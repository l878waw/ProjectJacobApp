const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';
const DATA_DIR = process.env.JACOB_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
const PUBLIC_URL = process.env.JACOB_PUBLIC_URL || 'https://project-jacob.vercel.app';

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
        elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY)
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
      endpoints: ['/health', 'POST /api/speak', 'POST /api/checkins']
    }, origin, { headOnly: isHead });
  }

  if (method === 'GET' && url.pathname === '/service-worker.js') {
    return sendServiceWorker(res, origin, { headOnly: isHead });
  }

  if (method === 'POST' && url.pathname === '/api/speak') {
    return speak(req, res, origin);
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
