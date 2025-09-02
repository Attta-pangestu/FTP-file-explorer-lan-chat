const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const { Client } = require('basic-ftp');
const config = require('./config');

// FTP client instance
let ftpClient = null;
let isConnected = false;

// Cache settings
const CACHE_TTL_HOURS = 1; // Cache valid for 1 hour
const CACHE_FILE_PREFIX = 'cache_';

// Get cache directory path
function getCacheDir() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'cache');
}

// Generate cache filename based on current date
function getCacheFilename() {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  return `${CACHE_FILE_PREFIX}${dateStr}.json`;
}

// Get full cache file path
function getCacheFilePath() {
  return path.join(getCacheDir(), getCacheFilename());
}

// Ensure cache directory exists
async function ensureCacheDir() {
  const cacheDir = getCacheDir();
  try {
    await fs.mkdir(cacheDir, { recursive: true });
  } catch (error) {
    console.error('Error creating cache directory:', error);
  }
}

// Clean old cache files (older than 7 days)
async function cleanOldCacheFiles() {
  try {
    const cacheDir = getCacheDir();
    const files = await fs.readdir(cacheDir);
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
    
    for (const file of files) {
      if (file.startsWith(CACHE_FILE_PREFIX)) {
        const filePath = path.join(cacheDir, file);
        const stats = await fs.stat(filePath);
        
        if (now - stats.mtime.getTime() > maxAge) {
          await fs.unlink(filePath);
          console.log(`Deleted old cache file: ${file}`);
        }
      }
    }
  } catch (error) {
    console.error('Error cleaning old cache files:', error);
  }
}

// Check if cache is valid (within TTL)
function isCacheValid(cacheData) {
  if (!cacheData || !cacheData.timestamp) {
    return false;
  }
  
  const now = Date.now();
  const cacheTime = new Date(cacheData.timestamp).getTime();
  const ttlMs = CACHE_TTL_HOURS * 60 * 60 * 1000;
  
  return (now - cacheTime) < ttlMs;
}

// Normalize file information for consistency
function normalizeFileInfo(file) {
  return {
    name: file.name,
    type: file.type === 1 ? 'file' : (file.type === 2 ? 'directory' : 'unknown'),
    size: file.size || 0,
    modifiedAt: file.modifiedAt ? file.modifiedAt.toISOString() : null,
    permissions: file.permissions || null,
    isDirectory: file.isDirectory,
    isFile: file.isFile,
    isSymbolicLink: file.isSymbolicLink
  };
}

// Connect to FTP server
async function connect() {
  try {
    if (isConnected && ftpClient) {
      return { success: true, message: 'Already connected to FTP server' };
    }
    
    // Get FTP configuration
    const appConfig = await config.getConfig();
    const ftpConfig = appConfig.ftp;
    
    if (!ftpConfig.host || !ftpConfig.username || !ftpConfig.password) {
      throw new Error('FTP configuration is incomplete');
    }
    
    // Create new FTP client
    ftpClient = new Client();
    
    // Set up error handling
    ftpClient.ftp.socket.on('error', (error) => {
      console.error('FTP socket error:', error);
      isConnected = false;
    });
    
    ftpClient.ftp.socket.on('close', () => {
      console.log('FTP connection closed');
      isConnected = false;
    });
    
    // Connect to server
    await ftpClient.access({
      host: ftpConfig.host,
      port: ftpConfig.port || 21,
      user: ftpConfig.username,
      password: ftpConfig.password,
      secure: ftpConfig.secure || false
    });
    
    isConnected = true;
    console.log(`Connected to FTP server: ${ftpConfig.host}`);
    
    return {
      success: true,
      message: 'Successfully connected to FTP server',
      host: ftpConfig.host,
      port: ftpConfig.port || 21
    };
    
  } catch (error) {
    isConnected = false;
    if (ftpClient) {
      ftpClient.close();
      ftpClient = null;
    }
    throw new Error(`Failed to connect to FTP server: ${error.message}`);
  }
}

// Disconnect from FTP server
async function disconnect() {
  try {
    if (ftpClient) {
      ftpClient.close();
      ftpClient = null;
    }
    isConnected = false;
    console.log('Disconnected from FTP server');
    return { success: true, message: 'Disconnected from FTP server' };
  } catch (error) {
    console.error('Error disconnecting from FTP:', error);
    throw new Error(`Failed to disconnect: ${error.message}`);
  }
}

// List files and directories in the specified path
async function list(remotePath = '/') {
  // Normalize path to prevent path traversal
  const normalizedPath = path.posix.normalize(remotePath);
  if (normalizedPath.includes('..')) {
    throw new Error('Path traversal is not allowed');
  }
  
  try {
    // Ensure we're connected
    if (!isConnected || !ftpClient) {
      await connect();
    }
    
    console.log(`Listing FTP directory: ${normalizedPath}`);
    
    // Get directory listing from FTP server
    const rawList = await ftpClient.list(normalizedPath);
    
    // Normalize file information
    const fileList = rawList.map(normalizeFileInfo);
    
    return fileList;
    
  } catch (error) {
    console.error('Error listing FTP directory:', error);
    
    // Handle specific FTP error codes
    if (error.code === 550) {
      // Access denied - this is expected for restricted directories
      const accessError = new Error(`Access denied to directory: ${normalizedPath}`);
      accessError.code = 550;
      accessError.type = 'ACCESS_DENIED';
      throw accessError;
    }
    
    // If connection error, try to reconnect once
    if (error.message.includes('connection') || error.message.includes('socket')) {
      try {
        isConnected = false;
        await connect();
        const rawList = await ftpClient.list(remotePath);
        return rawList.map(normalizeFileInfo);
      } catch (retryError) {
        throw new Error(`Failed to list directory after retry: ${retryError.message}`);
      }
    }
    
    // Handle other FTP errors with more specific messages
    if (error.code === 421) {
      throw new Error(`FTP server timeout: ${error.message}`);
    } else if (error.code === 530) {
      throw new Error(`Authentication failed: ${error.message}`);
    } else if (error.code === 553) {
      throw new Error(`Invalid file name: ${error.message}`);
    }
    
    throw new Error(`Failed to list directory: ${error.message}`);
  }
}

// Download file from FTP server to local path
async function download(remotePath, localPath) {
  try {
    // Ensure we're connected
    if (!isConnected || !ftpClient) {
      await connect();
    }
    
    // Normalize remote path to prevent path traversal
    const normalizedRemotePath = path.posix.normalize(remotePath);
    if (normalizedRemotePath.includes('..')) {
      throw new Error('Path traversal is not allowed');
    }
    
    console.log(`Downloading file: ${normalizedRemotePath} -> ${localPath}`);
    
    // Ensure local directory exists
    const localDir = path.dirname(localPath);
    await fs.mkdir(localDir, { recursive: true });
    
    // Download file
    await ftpClient.downloadTo(localPath, normalizedRemotePath);
    
    console.log(`File downloaded successfully: ${localPath}`);
    
    return {
      success: true,
      remotePath: normalizedRemotePath,
      localPath: localPath,
      message: 'File downloaded successfully'
    };
    
  } catch (error) {
    console.error('Error downloading file:', error);
    
    // If connection error, try to reconnect once
    if (error.message.includes('connection') || error.message.includes('socket')) {
      try {
        isConnected = false;
        await connect();
        await ftpClient.downloadTo(localPath, remotePath);
        return {
          success: true,
          remotePath,
          localPath,
          message: 'File downloaded successfully after retry'
        };
      } catch (retryError) {
        throw new Error(`Failed to download file after retry: ${retryError.message}`);
      }
    }
    
    throw new Error(`Failed to download file: ${error.message}`);
  }
}

// Read cache from file
async function readCache() {
  try {
    await ensureCacheDir();
    const cacheFilePath = getCacheFilePath();
    
    try {
      const cacheData = await fs.readFile(cacheFilePath, 'utf8');
      const parsed = JSON.parse(cacheData);
      
      if (isCacheValid(parsed)) {
        console.log('Using valid cache data');
        return parsed;
      } else {
        console.log('Cache data is expired');
        return null;
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('Cache file not found');
        return null;
      }
      throw error;
    }
  } catch (error) {
    console.error('Error reading cache:', error);
    return null;
  }
}

// Write cache to file
async function writeCache(directoryStructure) {
  try {
    await ensureCacheDir();
    const cacheFilePath = getCacheFilePath();
    
    const cacheData = {
      timestamp: new Date().toISOString(),
      structure: directoryStructure,
      version: 1
    };
    
    await fs.writeFile(cacheFilePath, JSON.stringify(cacheData, null, 2), 'utf8');
    console.log('Cache updated successfully');
    
    // Clean old cache files
    await cleanOldCacheFiles();
    
    return cacheData;
  } catch (error) {
    console.error('Error writing cache:', error);
    throw error;
  }
}

// Build directory structure with lazy loading (only first level)
async function buildDirectoryStructure(basePath = '/', maxDepth = 3, currentDepth = 0) {
  try {
    const items = await list(basePath);
    const structure = {
      name: basePath === '/' ? 'Root' : basePath.split('/').pop(),
      type: 'directory',
      path: basePath,
      files: [],
      directories: [],
      isAccessible: true,
      hasChildren: false,
      loaded: true,
      timestamp: new Date().toISOString()
    };
    
    for (const item of items) {
      if (item.type === 'file') {
        structure.files.push(item);
      } else if (item.type === 'directory') {
        const dirPath = path.posix.join(basePath, item.name);
        
        // Check if directory is accessible by attempting to list it
        let isAccessible = true;
        let hasChildren = false;
        
        try {
          const dirItems = await list(dirPath);
          hasChildren = dirItems.some(subItem => subItem.type === 'directory');
        } catch (error) {
          if (error.code === 550 || error.type === 'ACCESS_DENIED') {
            console.log(`Directory ${dirPath} access denied - marking as restricted`);
            isAccessible = false;
          } else {
            console.warn(`Directory ${dirPath} check failed: ${error.message}`);
            isAccessible = false;
          }
        }
        
        structure.directories.push({
          ...item,
          path: dirPath,
          isAccessible,
          hasChildren,
          loaded: false, // Mark as not loaded for lazy loading
          files: [],
          directories: []
        });
      }
    }
    
    // Update hasChildren flag for the root structure
    structure.hasChildren = structure.directories.length > 0;
    
    return structure;
  } catch (error) {
    console.error(`Error building directory structure for ${basePath}:`, error);
    return {
      path: basePath,
      files: [],
      directories: [],
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

// Load directory contents on demand (lazy loading)
async function loadDirectoryContents(dirPath, maxDepth = 3) {
  try {
    console.log(`Loading directory contents for: ${dirPath}`);
    
    const items = await list(dirPath);
    const structure = {
      path: dirPath,
      files: [],
      directories: [],
      loaded: true,
      timestamp: new Date().toISOString()
    };
    
    for (const item of items) {
      if (item.type === 'file') {
        structure.files.push(item);
      } else if (item.type === 'directory') {
        const subDirPath = path.posix.join(dirPath, item.name);
        
        // Check if subdirectory is accessible
        let isAccessible = true;
        let hasChildren = false;
        
        try {
          const subItems = await list(subDirPath);
          hasChildren = subItems.some(subItem => subItem.type === 'directory');
        } catch (error) {
          if (error.code === 550 || error.type === 'ACCESS_DENIED') {
            console.log(`Subdirectory ${subDirPath} access denied - marking as restricted`);
            isAccessible = false;
          } else {
            console.warn(`Subdirectory ${subDirPath} check failed: ${error.message}`);
            isAccessible = false;
          }
        }
        
        structure.directories.push({
          ...item,
          path: subDirPath,
          isAccessible,
          hasChildren,
          loaded: false,
          files: [],
          directories: []
        });
      }
    }
    
    return structure;
  } catch (error) {
    console.error(`Error loading directory contents for ${dirPath}:`, error);
    
    // Handle access denied errors specifically
    if (error.code === 550 || error.type === 'ACCESS_DENIED') {
      const accessError = new Error(`Access denied to directory: ${dirPath}`);
      accessError.code = 550;
      accessError.type = 'ACCESS_DENIED';
      accessError.userMessage = 'This directory is restricted and cannot be accessed.';
      throw accessError;
    }
    
    // Add user-friendly message for other errors
    error.userMessage = 'Failed to load directory contents. Please check your connection and try again.';
    throw error;
  }
}

// Refresh cache by rebuilding directory structure
async function refreshCache() {
  try {
    console.log('Refreshing FTP cache...');
    
    // Build fresh directory structure (first level only)
    const structure = await buildDirectoryStructure('/', 3, 0);
    
    // Write to cache
    await writeCache(structure);
    
    console.log('Cache refreshed successfully');
    return structure;
    
  } catch (error) {
    console.error('Error refreshing cache:', error);
    throw new Error(`Failed to refresh cache: ${error.message}`);
  }
}

// Get cached directory structure or build it if not available
async function getCachedStructure() {
  try {
    // Try to read from cache first
    let cache = await readCache();
    
    if (!cache) {
      console.log('No valid cache found, building directory structure...');
      await refreshCache();
      cache = await readCache();
    }
    
    return cache ? cache.structure : null;
  } catch (error) {
    console.error('Error getting cached structure:', error);
    throw error;
  }
}

// Check connection status
function getConnectionStatus() {
  return {
    isConnected,
    hasClient: !!ftpClient
  };
}

module.exports = {
  connect,
  disconnect,
  list,
  download,
  readCache,
  refreshCache,
  getCachedStructure,
  getConnectionStatus,
  loadDirectoryContents,
  
  // For testing and debugging
  getCacheFilePath,
  buildDirectoryStructure
};
