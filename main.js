const { app, BrowserWindow } = require('electron');

const PROJECT_JACOB_URL = 'https://project-jacob-kris-project-jacob.vercel.app/';

function createWindow() {
    const win = new BrowserWindow({
        width: 500,
        height: 700,
        title: 'Project Jacob',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        },
        autoHideMenuBar: true
    });

    win.loadURL(PROJECT_JACOB_URL);
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
