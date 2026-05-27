const { app, BrowserWindow, session } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Corrida Internacional de Praia Grande',
    icon: path.join(__dirname, 'favicon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  win.loadFile('index.html');

  // Abre DevTools apenas em desenvolvimento
  // win.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
