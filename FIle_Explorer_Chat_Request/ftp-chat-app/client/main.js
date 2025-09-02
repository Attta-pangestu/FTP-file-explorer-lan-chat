const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Import utility modules
const config = require('./utils/config');
const ftpClient = require('./utils/ftp-client');
const chatClient = require('./utils/chat-client');

// Keep a global reference of the window object
let mainWindow;

// Enable live reload for Electron in development
if (process.env.NODE_ENV === 'development') {
  require('electron-reload')(__dirname, {
    electron: path.join(__dirname, '..', 'node_modules', '.bin', 'electron'),
    hardResetMethod: 'exit'
  });
}

function createWindow() {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'assets', 'icon.png'), // Add icon later
    titleBarStyle: 'default',
    show: false // Don't show until ready
  });

  // Load the app
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    
    // Forward renderer console logs to main process
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      console.log(`[RENDERER] ${message}`);
    });
    
    // Open DevTools in development
    if (process.env.NODE_ENV === 'development') {
      mainWindow.webContents.openDevTools();
    }
  });

  // Emitted when the window is closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// App event listeners
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // On macOS, keep app running even when all windows are closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On macOS, re-create window when dock icon is clicked
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Security: Prevent new window creation
app.on('web-contents-created', (event, contents) => {
  contents.on('new-window', (event, navigationUrl) => {
    event.preventDefault();
    shell.openExternal(navigationUrl);
  });
});

// =============================================
// IPC Handlers for Configuration
// =============================================

ipcMain.handle('config:get', async () => {
  try {
    return await config.getConfig();
  } catch (error) {
    console.error('Error getting config:', error);
    return null;
  }
});

ipcMain.handle('config:save', async (event, configData) => {
  try {
    await config.saveConfig(configData);
    return { success: true };
  } catch (error) {
    console.error('Error saving config:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('config:validate-ftp', async (event, ftpConfig) => {
  try {
    const result = await config.validateFTP(ftpConfig);
    return { success: true, result };
  } catch (error) {
    console.error('Error validating FTP:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('config:validate-chat', async (event, chatConfig) => {
  try {
    const result = await config.validateChat(chatConfig);
    return { success: true, result };
  } catch (error) {
    console.error('Error validating chat:', error);
    return { success: false, error: error.message };
  }
});

// =============================================
// IPC Handlers for FTP Operations
// =============================================

ipcMain.handle('ftp:connect', async () => {
  try {
    const result = await ftpClient.connect();
    return { success: true, result };
  } catch (error) {
    console.error('Error connecting to FTP:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ftp:list', async (event, remotePath = '/') => {
  try {
    const files = await ftpClient.list(remotePath);
    return { success: true, files };
  } catch (error) {
    console.error('Error listing FTP directory:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ftp:download-and-open', async (event, remotePath, fileName) => {
  try {
    // Create temp directory if it doesn't exist
    const tempDir = path.join(os.tmpdir(), 'ftp-explorer-temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const localPath = path.join(tempDir, fileName);
    
    // Download file
    await ftpClient.download(remotePath, localPath);
    
    // Open file with default application
    await shell.openPath(localPath);
    
    return { success: true, localPath };
  } catch (error) {
    console.error('Error downloading and opening file:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ftp:get-cache', async () => {
  try {
    const structure = await ftpClient.getCachedStructure();
    return { success: true, cache: { structure } };
  } catch (error) {
    console.error('Error getting FTP cache:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ftp:load-directory', async (event, dirPath) => {
  try {
    const contents = await ftpClient.loadDirectoryContents(dirPath);
    return { success: true, contents };
  } catch (error) {
    console.error('Error loading directory contents:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ftp:refresh-cache', async () => {
  try {
    await ftpClient.refreshCache();
    return { success: true };
  } catch (error) {
    console.error('Error refreshing FTP cache:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ftp:disconnect', async () => {
  try {
    await ftpClient.disconnect();
    return { success: true };
  } catch (error) {
    console.error('Error disconnecting from FTP:', error);
    return { success: false, error: error.message };
  }
});

// =============================================
// IPC Handlers for Chat Operations
// =============================================

ipcMain.handle('chat:connect', async (event, username) => {
  try {
    const result = await chatClient.connect(username);
    return { success: true, result };
  } catch (error) {
    console.error('Error connecting to chat:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('chat:send-message', async (event, message) => {
  try {
    await chatClient.sendMessage(message);
    return { success: true };
  } catch (error) {
    console.error('Error sending chat message:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('chat:disconnect', async () => {
  try {
    await chatClient.disconnect();
    return { success: true };
  } catch (error) {
    console.error('Error disconnecting from chat:', error);
    return { success: false, error: error.message };
  }
});

// Forward chat events to renderer
chatClient.onMessage((message) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('chat:message-received', message);
  }
});

chatClient.onUserList((users) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('chat:user-list-updated', users);
  }
});

chatClient.onError((error) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('chat:error', error);
  }
});

// =============================================
// General IPC Handlers
// =============================================

ipcMain.handle('app:get-version', () => {
  return app.getVersion();
});

ipcMain.handle('app:get-platform', () => {
  return process.platform;
});

ipcMain.handle('dialog:show-error', async (event, title, content) => {
  dialog.showErrorBox(title, content);
  return { success: true };
});

// =============================================
// Cleanup on app quit
// =============================================

app.on('before-quit', async () => {
  try {
    await ftpClient.disconnect();
    await chatClient.disconnect();
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
});

// Handle app errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  dialog.showErrorBox('Unexpected Error', error.message);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Promise Rejection:', error);
});
