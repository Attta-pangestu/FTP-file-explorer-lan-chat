const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Configuration APIs
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (config) => ipcRenderer.invoke('config:save', config),
    validateFTP: (ftpConfig) => ipcRenderer.invoke('config:validate-ftp', ftpConfig),
    validateChat: (chatConfig) => ipcRenderer.invoke('config:validate-chat', chatConfig)
  },

  // FTP APIs
  ftp: {
    connect: () => ipcRenderer.invoke('ftp:connect'),
    list: (path) => ipcRenderer.invoke('ftp:list', path),
    loadDirectory: (dirPath) => ipcRenderer.invoke('ftp:load-directory', dirPath),
    downloadAndOpen: (remotePath, fileName) => ipcRenderer.invoke('ftp:download-and-open', remotePath, fileName),
    getCache: (forceRefresh = false) => ipcRenderer.invoke('ftp:get-cache', forceRefresh),
    refreshCache: (forceRefresh = true) => ipcRenderer.invoke('ftp:refresh-cache', forceRefresh),
    clearCache: () => ipcRenderer.invoke('ftp:clear-cache'),
    getCachedUsers: () => ipcRenderer.invoke('ftp:get-cached-users'),
    initUsername: () => ipcRenderer.invoke('ftp:init-username'),
    disconnect: () => ipcRenderer.invoke('ftp:disconnect')
  },

  // Chat APIs
  chat: {
    connect: (username) => ipcRenderer.invoke('chat:connect', username),
    sendMessage: (message) => ipcRenderer.invoke('chat:send-message', message),
    disconnect: () => ipcRenderer.invoke('chat:disconnect'),
    
    // Event listeners
    onMessageReceived: (callback) => {
      ipcRenderer.on('chat:message-received', (event, message) => callback(message));
    },
    onUserListUpdated: (callback) => {
      ipcRenderer.on('chat:user-list-updated', (event, users) => callback(users));
    },
    onError: (callback) => {
      ipcRenderer.on('chat:error', (event, error) => callback(error));
    },

    // Remove listeners (cleanup)
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('chat:message-received');
      ipcRenderer.removeAllListeners('chat:user-list-updated');
      ipcRenderer.removeAllListeners('chat:error');
    }
  },

  // App APIs
  app: {
    getVersion: () => ipcRenderer.invoke('app:get-version'),
    getPlatform: () => ipcRenderer.invoke('app:get-platform')
  },

  // Dialog APIs
  dialog: {
    showError: (title, content) => ipcRenderer.invoke('dialog:show-error', title, content)
  }
});
