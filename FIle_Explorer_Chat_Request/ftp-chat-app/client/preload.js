const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Configuration APIs
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (config) => ipcRenderer.invoke('config:save', config),
    validateFTP: (ftpConfig) => ipcRenderer.invoke('config:validate-ftp', ftpConfig)
  },

  // FTP APIs
  ftp: {
    connect: () => ipcRenderer.invoke('ftp:connect'),
    list: (path) => ipcRenderer.invoke('ftp:list', path),
    loadDirectory: (dirPath) => ipcRenderer.invoke('ftp:load-directory', dirPath),
    downloadAndOpen: (remotePath, fileName) => ipcRenderer.invoke('ftp:download-and-open', remotePath, fileName),
    downloadWithProgress: (remotePath, localPath, allowResume = true) => ipcRenderer.invoke('ftp:download-with-progress', remotePath, localPath, allowResume),
    onDownloadProgress: (callback) => {
      ipcRenderer.on('download-progress', (event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners('download-progress');
    },
    getCache: (forceRefresh = false) => ipcRenderer.invoke('ftp:get-cache', forceRefresh),
    refreshCache: (forceRefresh = true) => ipcRenderer.invoke('ftp:refresh-cache', forceRefresh),
    clearCache: () => ipcRenderer.invoke('ftp:clear-cache'),
    checkCacheExists: () => ipcRenderer.invoke('ftp:check-cache-exists'),
    getCachedUsers: () => ipcRenderer.invoke('ftp:get-cached-users'),
    initUsername: () => ipcRenderer.invoke('ftp:init-username'),
    disconnect: () => ipcRenderer.invoke('ftp:disconnect'),
    upload: (localPath, remotePath) => ipcRenderer.invoke('ftp:upload', localPath, remotePath),
    uploadMultiple: (files) => ipcRenderer.invoke('ftp:upload-multiple', files),
    createDirectory: (remotePath) => ipcRenderer.invoke('ftp:create-directory', remotePath),
    onUploadProgress: (callback) => {
      ipcRenderer.on('ftp:upload-progress', (event, data) => callback(data));
      return () => ipcRenderer.removeAllListeners('ftp:upload-progress');
    },
    deleteFile: (remotePath) => ipcRenderer.invoke('ftp:delete-file', remotePath),
    deleteDirectory: (remotePath) => ipcRenderer.invoke('ftp:delete-directory', remotePath),
    deleteMultiple: (items) => ipcRenderer.invoke('ftp:delete-multiple', items),
    onDeleteProgress: (callback) => {
      ipcRenderer.on('delete-progress', callback);
      return () => ipcRenderer.removeAllListeners('delete-progress');
    },
    // File operation APIs
    getFileContent: (remotePath) => ipcRenderer.invoke('ftp:get-file-content', remotePath),
    updateFile: (remotePath, content) => ipcRenderer.invoke('ftp:update-file', remotePath, content),
    replaceFile: (remotePath, localPath) => ipcRenderer.invoke('ftp:replace-file', remotePath, localPath),
    // Connection Pool Functions
    listPooled: (remotePath) => ipcRenderer.invoke('ftp:list-pooled', remotePath),
    downloadPooled: (remotePath, localPath) => ipcRenderer.invoke('ftp:download-pooled', remotePath, localPath),
    uploadPooled: (localPath, remotePath) => ipcRenderer.invoke('ftp:upload-pooled', localPath, remotePath),
    performConcurrentOperations: (operations, maxConcurrency) => ipcRenderer.invoke('ftp:concurrent-operations', operations, maxConcurrency),
    getPoolStats: () => ipcRenderer.invoke('ftp:get-pool-stats'),
    optimizePool: () => ipcRenderer.invoke('ftp:optimize-pool'),
    // Windows Explorer-like lazy loading functions
    loadDirectoryLazy: (dirPath, options) => ipcRenderer.invoke('ftp:load-directory-lazy', dirPath, options),
    setVisibleDirectories: (directories) => ipcRenderer.invoke('ftp:set-visible-directories', directories),
    refreshVisibleDirectories: () => ipcRenderer.invoke('ftp:refresh-visible-directories'),
    getLazyLoadStats: () => ipcRenderer.invoke('ftp:get-lazy-load-stats'),
    clearLazyCache: (dirPath) => ipcRenderer.invoke('ftp:clear-lazy-cache', dirPath),
    // Background worker functions
    startBackgroundWorker: (refreshInterval) => ipcRenderer.invoke('ftp:start-background-worker', refreshInterval),
    stopBackgroundWorker: () => ipcRenderer.invoke('ftp:stop-background-worker'),
    addMonitoredDirectory: (dirPath) => ipcRenderer.invoke('ftp:add-monitored-directory', dirPath),
    removeMonitoredDirectory: (dirPath) => ipcRenderer.invoke('ftp:remove-monitored-directory', dirPath),
    updateWorkerActivity: () => ipcRenderer.invoke('ftp:update-worker-activity'),
    getBackgroundWorkerStats: () => ipcRenderer.invoke('ftp:get-background-worker-stats')
  },



  // App APIs
  app: {
    getVersion: () => ipcRenderer.invoke('app:get-version'),
    getPlatform: () => ipcRenderer.invoke('app:get-platform')
  },

  // Dialog APIs
  dialog: {
    showSaveDialog: (options) => ipcRenderer.invoke('dialog:show-save-dialog', options),
    showMessageBox: (options) => ipcRenderer.invoke('dialog:show-message-box', options),
    showError: (title, content) => ipcRenderer.invoke('dialog:show-error', title, content),
    openFiles: () => ipcRenderer.invoke('dialog:open-files'),
    showConfirmation: (title, message) => ipcRenderer.invoke('dialog:show-confirmation', title, message)
  },

  // Shell APIs
  shell: {
    openPath: (path) => ipcRenderer.invoke('shell:open-path', path),
    showItemInFolder: (path) => ipcRenderer.invoke('shell:show-item-in-folder', path)
  }
});
