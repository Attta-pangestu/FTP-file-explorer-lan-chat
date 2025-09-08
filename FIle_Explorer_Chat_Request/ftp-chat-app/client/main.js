const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Import utility modules
const config = require('./utils/config');
const ftpClient = require('./utils/ftp-client');


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

ipcMain.handle('ftp:download-with-progress', async (event, remotePath, localPath, allowResume = true) => {
  try {
    // Progress callback to send updates to renderer
    const onProgress = (progress, downloaded, total, status) => {
      event.sender.send('download-progress', {
        remotePath,
        localPath,
        progress,
        downloaded,
        total,
        status
      });
    };
    
    // Download file with progress tracking
    const result = await ftpClient.downloadWithProgress(remotePath, localPath, onProgress, allowResume);
    
    return { success: true, ...result };
  } catch (error) {
    console.error('Error downloading file with progress:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ftp:get-cache', async (event, forceRefresh = false) => {
  try {
    const structure = await ftpClient.getCachedStructure(null, forceRefresh);
    return { success: true, cache: { structure } };
  } catch (error) {
    console.error('Error getting FTP cache:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ftp:load-directory', async (event, dirPath) => {
  try {
    // Use lazy loading system for better performance and concurrency control
    const contents = await ftpClient.loadDirectoryLazy(dirPath, { forceRefresh: false });
    
    // Optimize cache in background after successful load
    ftpClient.optimizeCache().catch(error => {
      console.warn('Cache optimization failed:', error);
    });
    
    return { success: true, contents };
  } catch (error) {
    console.error('Error loading directory contents:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ftp:refresh-cache', async (event, forceRefresh = true) => {
  try {
    const structure = await ftpClient.refreshCache(null, forceRefresh);
    
    // Optimize cache after refresh
    ftpClient.optimizeCache().catch(error => {
      console.warn('Cache optimization after refresh failed:', error);
    });
    
    return { success: true, structure };
  } catch (error) {
    console.error('Error refreshing FTP cache:', error);
    return { success: false, error: error.message };
  }
});

// Clear cache for current user
ipcMain.handle('ftp:clear-cache', async () => {
  try {
    const result = await ftpClient.clearUserCache();
    return { success: true, message: result.message };
  } catch (error) {
    console.error('Error clearing FTP cache:', error);
    return { success: false, error: error.message };
  }
});

// Check if cache exists
ipcMain.handle('ftp:check-cache-exists', async () => {
  try {
    const exists = await ftpClient.checkCacheExists();
    return exists;
  } catch (error) {
    console.error('Error checking cache existence:', error);
    throw error;
  }
});

// Get list of cached users
ipcMain.handle('ftp:get-cached-users', async () => {
  try {
    const users = await ftpClient.getCachedUsers();
    return { success: true, users };
  } catch (error) {
    console.error('Error getting cached users:', error);
    return { success: false, error: error.message };
  }
});

// Initialize username for cache
ipcMain.handle('ftp:init-username', async () => {
  try {
    await ftpClient.initializeUsername();
    return { success: true };
  } catch (error) {
    console.error('Error initializing username:', error);
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

ipcMain.handle('ftp:upload', async (event, localPath, remotePath, onProgress) => {
  try {
    const result = await ftpClient.upload(localPath, remotePath, (progress) => {
      // Send progress updates to renderer
      event.sender.send('ftp:upload-progress', {
        remotePath,
        progress: progress.percentage,
        transferred: progress.transferred,
        total: progress.total
      });
    });
    return { success: true, result };
  } catch (error) {
    console.error('Error uploading file:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ftp:upload-multiple', async (event, files) => {
  try {
    const results = await ftpClient.uploadMultiple(files, (fileProgress) => {
      // Send progress updates to renderer
      event.sender.send('ftp:upload-progress', fileProgress);
    });
    return { success: true, results };
  } catch (error) {
    console.error('Error uploading multiple files:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ftp:create-directory', async (event, remotePath) => {
  try {
    await ftpClient.createDirectory(remotePath);
    return { success: true };
  } catch (error) {
    console.error('Error creating directory:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('dialog:open-files', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    return { success: true, filePaths: result.filePaths, cancelled: result.canceled };
  } catch (error) {
    console.error('Error opening file dialog:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ftp:delete-file', async (event, remotePath) => {
  try {
    const result = await ftpClient.deleteFile(remotePath);
    return result;
  } catch (error) {
    console.error('Error deleting file:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ftp:delete-directory', async (event, remotePath) => {
  try {
    const result = await ftpClient.deleteDirectory(remotePath);
    return result;
  } catch (error) {
    console.error('Error deleting directory:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ftp:delete-multiple', async (event, items) => {
  try {
    const results = await ftpClient.deleteMultiple(items, (progress) => {
      mainWindow.webContents.send('delete-progress', progress);
    });
    return { success: true, results };
  } catch (error) {
    console.error('Error deleting multiple items:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('dialog:show-confirmation', async (event, options) => {
  try {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      title: options.title || 'Confirm Delete',
      message: options.message || 'Are you sure you want to delete this item?',
      detail: options.detail || 'This action cannot be undone.'
    });
    return { confirmed: result.response === 1 };
  } catch (error) {
    console.error('Error showing confirmation dialog:', error);
    return { confirmed: false, error: error.message };
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
  return await dialog.showErrorBox(title, content);
});

ipcMain.handle('dialog:show-save-dialog', async (event, options) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, options);
    return result;
  } catch (error) {
    console.error('Error showing save dialog:', error);
    return { canceled: true, error: error.message };
  }
});

ipcMain.handle('dialog:show-message-box', async (event, options) => {
  try {
    const result = await dialog.showMessageBox(mainWindow, options);
    return result;
  } catch (error) {
    console.error('Error showing message box:', error);
    return { response: -1, error: error.message };
  }
});

ipcMain.handle('shell:open-path', async (event, path) => {
  try {
    const result = await shell.openPath(path);
    return { success: true, result };
  } catch (error) {
    console.error('Error opening path:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('shell:show-item-in-folder', async (event, path) => {
  try {
    shell.showItemInFolder(path);
    return { success: true };
  } catch (error) {
    console.error('Error showing item in folder:', error);
    return { success: false, error: error.message };
  }
});

// =============================================
// IPC Handlers for File Operations
// =============================================

ipcMain.handle('ftp:get-file-content', async (event, remotePath) => {
  try {
    const content = await ftpClient.getFileContent(remotePath);
    return { success: true, content };
  } catch (error) {
    console.error('Error getting file content:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ftp:update-file', async (event, remotePath, content) => {
  try {
    await ftpClient.updateFile(remotePath, content);
    return { success: true };
  } catch (error) {
    console.error('Error updating file:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ftp:replace-file', async (event, remotePath, localPath) => {
   try {
     await ftpClient.replaceFile(remotePath, localPath);
     return { success: true };
   } catch (error) {
     console.error('Error replacing file:', error);
     return { success: false, error: error.message };
   }
 });

// =============================================
// IPC Handlers for Connection Pool Operations
// =============================================

ipcMain.handle('ftp:list-pooled', async (event, remotePath = '/') => {
  try {
    const result = await ftpClient.listPooled(remotePath);
    return result;
  } catch (error) {
    console.error('Error listing directory with pool:', error);
    throw error;
  }
});

ipcMain.handle('ftp:download-pooled', async (event, remotePath, localPath) => {
  try {
    const result = await ftpClient.downloadPooled(remotePath, localPath);
    return result;
  } catch (error) {
    console.error('Error downloading file with pool:', error);
    throw error;
  }
});

ipcMain.handle('ftp:upload-pooled', async (event, localPath, remotePath) => {
  try {
    const result = await ftpClient.uploadPooled(localPath, remotePath);
    return result;
  } catch (error) {
    console.error('Error uploading file with pool:', error);
    throw error;
  }
});

ipcMain.handle('ftp:concurrent-operations', async (event, operations, maxConcurrency = 3) => {
  try {
    const result = await ftpClient.performConcurrentOperations(operations, maxConcurrency);
    return result;
  } catch (error) {
    console.error('Error performing concurrent operations:', error);
    throw error;
  }
});

ipcMain.handle('ftp:get-pool-stats', async () => {
  try {
    const stats = ftpClient.getPoolStats();
    return stats;
  } catch (error) {
    console.error('Error getting pool stats:', error);
    throw error;
  }
});

ipcMain.handle('ftp:optimize-pool', async () => {
    try {
      return await ftpClient.optimizeConnectionPool();
    } catch (error) {
      console.error('Error optimizing connection pool:', error);
      throw error;
    }
  });

  // Windows Explorer-like lazy loading IPC handlers
  ipcMain.handle('ftp:load-directory-lazy', async (event, dirPath, options = {}) => {
    try {
      return await ftpClient.loadDirectoryLazy(dirPath, options);
    } catch (error) {
      console.error('Error lazy loading directory:', error);
      throw error;
    }
  });

  ipcMain.handle('ftp:set-visible-directories', async (event, directories) => {
    try {
      return ftpClient.setVisibleDirectories(directories);
    } catch (error) {
      console.error('Error setting visible directories:', error);
      throw error;
    }
  });

  ipcMain.handle('ftp:refresh-visible-directories', async () => {
    try {
      return await ftpClient.refreshVisibleDirectories();
    } catch (error) {
      console.error('Error refreshing visible directories:', error);
      throw error;
    }
  });

  ipcMain.handle('ftp:get-lazy-load-stats', async () => {
    try {
      return ftpClient.getLazyLoadStats();
    } catch (error) {
      console.error('Error getting lazy load stats:', error);
      throw error;
    }
  });

  ipcMain.handle('ftp:clear-lazy-cache', async (event, dirPath) => {
    try {
      return ftpClient.clearLazyCache(dirPath);
    } catch (error) {
      console.error('Error clearing lazy cache:', error);
      throw error;
    }
  });

  // Background worker IPC handlers
  ipcMain.handle('ftp:start-background-worker', async (event, refreshInterval) => {
    try {
      return ftpClient.startBackgroundWorker(refreshInterval);
    } catch (error) {
      console.error('Error starting background worker:', error);
      throw error;
    }
  });

  ipcMain.handle('ftp:stop-background-worker', async () => {
    try {
      return ftpClient.stopBackgroundWorker();
    } catch (error) {
      console.error('Error stopping background worker:', error);
      throw error;
    }
  });

  ipcMain.handle('ftp:add-monitored-directory', async (event, dirPath) => {
    try {
      return ftpClient.addMonitoredDirectory(dirPath);
    } catch (error) {
      console.error('Error adding monitored directory:', error);
      throw error;
    }
  });

  ipcMain.handle('ftp:remove-monitored-directory', async (event, dirPath) => {
    try {
      return ftpClient.removeMonitoredDirectory(dirPath);
    } catch (error) {
      console.error('Error removing monitored directory:', error);
      throw error;
    }
  });

  ipcMain.handle('ftp:update-worker-activity', async () => {
    try {
      return ftpClient.updateWorkerActivity();
    } catch (error) {
      console.error('Error updating worker activity:', error);
      throw error;
    }
  });

  ipcMain.handle('ftp:get-background-worker-stats', async () => {
    try {
      return ftpClient.getBackgroundWorkerStats();
    } catch (error) {
      console.error('Error getting background worker stats:', error);
      throw error;
    }
  });

// =============================================
// Cleanup on app quit
// =============================================

app.on('before-quit', async () => {
  try {
    await ftpClient.disconnect();
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
