const http = require('http');
const fs = require('fs');
const path = require('path');
const { default: RunwayML, TaskFailedError, TaskTimedOutError, AbortError } = require('@runwayml/sdk');

const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';
const DATA_DIR = process.env.JACOB_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const PUBLIC_URL = process.env.JACOB_PUBLIC_URL || 'https://project-jacob.vercel.app';

// Allowed values for the gen4_image model, from https://docs.dev.runwayml.com/api.md
const RUNWAY_IMAGE_MODEL = 'gen4_image';
const RUNWAY_IMAGE_RATIOS = new Set([
  '1024:1024', '1080:1080', '1168:880', '1360:768', '1440:1080', '1080:1440', '1808:768', '1920:1080',
  '1080:1920', '2112:912', '1280:720', '720:1280', '720:720', '960:720', '720:960', '1680:720'
]);
const RUNWAY_IMAGE_DEFAULT_RATIO = '1280:720';
const RUNWAY_TASK_TIMEOUT_MS = 5 * 60 * 1000;

function allowedOrigin(origin) {
  if (!origin) return '*';
  const allowed = new Set([
    PUBLIC_URL,
    'https://project-jacob.vercel.app',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ]);
  return allowed.has(origin) ? origin : PUBLIC_URL;
}

function sendJson(res, status, body, origin, options = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': allowedOrigin(origin),
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
    'Cache-Control': 'no-store'
  });
  res.end(options.headOnly ? '' : payload);
}

function sendRedirect(res, location, origin, options = {}) {
  const payload = `Redirecting to ${location}`;
  res.writeHead(302, {
    'Location': location,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': allowedOrigin(origin),
    'Vary': 'Origin',
    'Cache-Control': 'no-store'
  });
  res.end(options.headOnly ? '' : payload);
}

function sendServiceWorker(res, origin, options = {}) {
  const script = [
    "self.addEventListener('install', () => self.skipWaiting());",
    "self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));",
    ''
  ].join('\n');
  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Content-Length': Buffer.byteLength(script),
    'Access-Control-Allow-Origin': allowedOrigin(origin),
    'Service-Worker-Allowed': '/',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  });
  res.end(options.headOnly ? '' : script);
}

function acceptsHtml(req) {
  return String(req.headers.accept || '').includes('text/html');
}

async function readJson(req, maxBytes = 1024 * 1024) {
  return await new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function requireAccessToken(req, res, origin) {
  const expected = process.env.JACOB_ACCESS_TOKEN;
  if (!expected) return true;
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${expected}`) return true;
  sendJson(res, 401, { error: 'Unauthorised' }, origin);
  return false;
}

async function speak(req, res, origin) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'kzXxs1kflcmnKP2KZjnr';
  if (!apiKey) return sendJson(res, 503, { error: 'ELEVENLABS_API_KEY is not configured' }, origin);

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message }, origin);
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return sendJson(res, 400, { error: 'Missing text' }, origin);
  if (text.length > 5000) return sendJson(res, 413, { error: 'Text is too long' }, origin);

  try {
    const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text,
        voice_settings: { stability: 0.6, similarity_boost: 0.8 }
      })
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error('ElevenLabs error', upstream.status, detail.slice(0, 500));
      return sendJson(res, 502, { error: 'Voice service request failed' }, origin);
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg',
      'Content-Length': audio.length,
      'Access-Control-Allow-Origin': allowedOrigin(origin),
      'Vary': 'Origin',
      'Cache-Control': 'no-store'
    });
    res.end(audio);
  } catch (error) {
    console.error('Voice service exception', error);
    sendJson(res, 502, { error: 'Voice service unavailable' }, origin);
  }
}

async function generateImage(req, res, origin) {
  if (!requireAccessToken(req, res, origin)) return;
  if (!process.env.RUNWAYML_API_SECRET) return sendJson(res, 503, { error: 'RUNWAYML_API_SECRET is not configured' }, origin);

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message }, origin);
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const ratio = body.ratio ?? RUNWAY_IMAGE_DEFAULT_RATIO;
  if (!prompt) return sendJson(res, 400, { error: 'Missing prompt' }, origin);
  if (prompt.length > 1000) return sendJson(res, 413, { error: 'Prompt is too long' }, origin);
  if (!RUNWAY_IMAGE_RATIOS.has(ratio)) return sendJson(res, 400, { error: 'Unsupported ratio', allowed: [...RUNWAY_IMAGE_RATIOS] }, origin);

  // Stop polling Runway if the caller disconnects before the task finishes.
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  const created = new RunwayML().textToImage.create({ model: RUNWAY_IMAGE_MODEL, promptText: prompt, ratio });
  // waitForTaskOutput() sleeps before awaiting the create request, so an early rejection (bad key, 4xx)
  // would be unhandled and crash the process. Mark it handled; waitForTaskOutput() still rethrows it.
  created.catch(() => {});

  try {
    const task = await created.waitForTaskOutput({ timeout: RUNWAY_TASK_TIMEOUT_MS, abortSignal: abort.signal });

    // Output URLs expire within 24-48 hours; download them if they need to be kept.
    sendJson(res, 200, { taskId: task.id, model: RUNWAY_IMAGE_MODEL, ratio, imageUrl: task.output[0] }, origin);
  } catch (error) {
    if (error instanceof AbortError) return;
    if (error instanceof TaskFailedError) {
      const { id, failureCode } = error.taskDetails;
      console.error('Runway task failed', id, failureCode, error.taskDetails.failure);
      return sendJson(res, 502, { error: 'Image generation failed', taskId: id, failureCode }, origin);
    }
    if (error instanceof TaskTimedOutError) {
      return sendJson(res, 504, { error: 'Image generation timed out', taskId: error.taskDetails.id }, origin);
    }
    console.error('Runway error', error.status, error.message);
    if (error.status === 429) return sendJson(res, 429, { error: 'Runway rate limit reached, try again shortly' }, origin);
    sendJson(res, 502, { error: 'Runway request failed', upstreamStatus: error.status ?? null }, origin);
  }
}

async function saveCheckIn(req, res, origin) {
  if (!requireAccessToken(req, res, origin)) return;

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message }, origin);
  }

  const entry = {
    timestamp: new Date().toISOString(),
    mood: body.mood ?? null,
    energy: body.energy ?? null,
    stress: body.stress ?? null,
    note: typeof body.note === 'string' ? body.note.slice(0, 4000) : ''
  };

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, 'checkins.ndjson'), `${JSON.stringify(entry)}\n`, 'utf8');
    sendJson(res, 201, { ok: true, entry }, origin);
  } catch (error) {
    console.error('Persistence error', error);
    sendJson(res, 500, { error: 'Could not save check-in' }, origin);
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const isHead = req.method === 'HEAD';
  const method = isHead ? 'GET' : req.method;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': allowedOrigin(origin),
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    });
    return res.end();
  }

  if (method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'project-jacob-api',
      uptime: Math.round(process.uptime()),
      dataDir: DATA_DIR,
      integrations: {
        openai: Boolean(process.env.OPENAI_API_KEY),
        elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
        runway: Boolean(process.env.RUNWAYML_API_SECRET)
      }
    }, origin, { headOnly: isHead });
  }

  if (method === 'GET' && url.pathname === '/') {
    if (!isHead && acceptsHtml(req)) {
      return sendRedirect(res, PUBLIC_URL, origin);
    }

    return sendJson(res, 200, {
      name: 'Project Jacob API',
      status: 'online',
      frontend: PUBLIC_URL,
      endpoints: ['/health', 'POST /api/speak', 'POST /api/generate-image', 'POST /api/checkins']
    }, origin, { headOnly: isHead });
  }

  if (method === 'GET' && url.pathname === '/service-worker.js') {
    return sendServiceWorker(res, origin, { headOnly: isHead });
  }

  if (method === 'POST' && url.pathname === '/api/speak') {
    return speak(req, res, origin);
  }

  if (method === 'POST' && url.pathname === '/api/generate-image') {
    return generateImage(req, res, origin);
  }

  if (method === 'POST' && url.pathname === '/api/checkins') {
    return saveCheckIn(req, res, origin);
  }

  return sendJson(res, 404, { error: 'Not found' }, origin, { headOnly: isHead });
});

server.on('clientError', (err, socket) => {
  console.error('Client error', err.message);
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  console.log(`Project Jacob API listening on http://${HOST}:${PORT}`);
  console.log(`Persistent data directory: ${DATA_DIR}`);
});
