const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const { Client } = require('basic-ftp');
const config = require('./config');

// Connection Pool Management
class FTPConnectionPool {
  constructor(maxConnections = 3) {
    this.maxConnections = maxConnections;
    this.connections = [];
    this.availableConnections = [];
    this.busyConnections = new Set();
    this.connectionConfig = null;
    this.isInitialized = false;
  }

  async initialize(ftpConfig) {
    this.connectionConfig = ftpConfig;
    this.isInitialized = true;
  }

  async createConnection() {
    if (!this.connectionConfig) {
      throw new Error('Connection pool not initialized');
    }

    const client = new Client();
    client.timeout = 30000;
    
    // Set up error handling
    client.ftp.socket.on('error', (error) => {
      console.error('FTP pool connection error:', error);
      this.removeConnection(client);
    });

    client.ftp.socket.on('close', () => {
      console.log('FTP pool connection closed');
      this.removeConnection(client);
    });

    client.ftp.socket.on('timeout', () => {
      console.warn('FTP pool connection timeout');
      this.removeConnection(client);
    });

    const connectPromise = client.access({
      host: this.connectionConfig.host,
      port: this.connectionConfig.port || 21,
      user: this.connectionConfig.username,
      password: this.connectionConfig.password,
      secure: this.connectionConfig.secure || false
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Connection timeout after 30 seconds')), 30000);
    });

    await Promise.race([connectPromise, timeoutPromise]);
    
    client._poolId = Date.now() + Math.random();
    this.connections.push(client);
    return client;
  }

  async getConnection() {
    // Return available connection if exists
    if (this.availableConnections.length > 0) {
      const connection = this.availableConnections.pop();
      this.busyConnections.add(connection._poolId);
      return connection;
    }

    // Create new connection if under limit
    if (this.connections.length < this.maxConnections) {
      const connection = await this.createConnection();
      this.busyConnections.add(connection._poolId);
      return connection;
    }

    // Wait for available connection
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (this.availableConnections.length > 0) {
          clearInterval(checkInterval);
          const connection = this.availableConnections.pop();
          this.busyConnections.add(connection._poolId);
          resolve(connection);
        }
      }, 100);

      // Timeout after 10 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error('Connection pool timeout - no available connections'));
      }, 10000);
    });
  }

  releaseConnection(connection) {
    if (connection && connection._poolId) {
      this.busyConnections.delete(connection._poolId);
      if (this.connections.includes(connection)) {
        this.availableConnections.push(connection);
      }
    }
  }

  removeConnection(connection) {
    if (connection && connection._poolId) {
      this.busyConnections.delete(connection._poolId);
      const index = this.connections.indexOf(connection);
      if (index > -1) {
        this.connections.splice(index, 1);
      }
      const availableIndex = this.availableConnections.indexOf(connection);
      if (availableIndex > -1) {
        this.availableConnections.splice(availableIndex, 1);
      }
      try {
        connection.close();
      } catch (error) {
        console.error('Error closing connection:', error);
      }
    }
  }

  async closeAll() {
    for (const connection of this.connections) {
      try {
        connection.close();
      } catch (error) {
        console.error('Error closing pool connection:', error);
      }
    }
    this.connections = [];
    this.availableConnections = [];
    this.busyConnections.clear();
    this.isInitialized = false;
  }

  getStats() {
    return {
      total: this.connections.length,
      available: this.availableConnections.length,
      busy: this.busyConnections.size,
      maxConnections: this.maxConnections
    };
  }
}

// Global connection pool instance
const connectionPool = new FTPConnectionPool(3);

// Legacy single connection for backward compatibility
let ftpClient = null;
let isConnected = false;
let currentUsername = null;

// Cache settings
const CACHE_TTL_HOURS = 48; // Cache valid for 48 hours (optimized for better persistence)
const CACHE_FILE_PREFIX = 'ftp_cache_';
const CACHE_VERSION = 4; // Increment when cache structure changes
const LOAD_HISTORY_FILE = 'load_history.json';
const MAX_CONCURRENT_OPERATIONS = 5; // Maximum concurrent directory scans
const SMART_CACHE_THRESHOLD = 3; // Number of accesses before prioritizing in cache

// Get cache directory path - using custom Caching folder for better performance
function getCacheDir() {
  // Use the specific Caching folder requested by user
  const projectRoot = path.dirname(path.dirname(__dirname));
  return path.join(projectRoot, 'client', 'Caching');
}

// Generate cache filename based on username
function getCacheFilename(username = null) {
  const user = username || currentUsername || 'default';
  // Sanitize username for filename
  const sanitizedUser = user.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${CACHE_FILE_PREFIX}${sanitizedUser}.json`;
}

// Get full cache file path
function getCacheFilePath(username = null) {
  return path.join(getCacheDir(), getCacheFilename(username));
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

// Initialize current username from config
async function initializeUsername() {
  try {
    const appConfig = await config.getConfig();
    currentUsername = appConfig.ftp?.username || 'default';
    console.log(`Cache initialized for user: ${currentUsername}`);
  } catch (error) {
    console.error('Error initializing username:', error);
    currentUsername = 'default';
  }
}

// Enhanced cache management with smart cleanup
async function cleanOldCacheFiles() {
  try {
    const cacheDir = getCacheDir();
    const files = await fs.readdir(cacheDir);
    const now = Date.now();
    const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
    
    for (const file of files) {
      if (file.startsWith(CACHE_FILE_PREFIX)) {
        const filePath = path.join(cacheDir, file);
        try {
          const stats = await fs.stat(filePath);
          
          if (now - stats.mtime.getTime() > maxAge) {
            await fs.unlink(filePath);
            console.log(`Deleted old cache file: ${file}`);
          }
        } catch (statError) {
          // File might have been deleted already, ignore
          console.warn(`Could not stat cache file ${file}:`, statError.message);
        }
      }
    }
    
    // Also clean old load history entries
    await cleanOldLoadHistory();
  } catch (error) {
    console.error('Error cleaning old cache files:', error);
  }
}

// Clean old load history entries
async function cleanOldLoadHistory() {
  try {
    const historyFilePath = path.join(getCacheDir(), LOAD_HISTORY_FILE);
    
    let history = {};
    try {
      const historyData = await fs.readFile(historyFilePath, 'utf8');
      history = JSON.parse(historyData);
    } catch (error) {
      return; // No history file exists
    }
    
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days for load history
    let cleaned = false;
    
    for (const [path, pathHistory] of Object.entries(history)) {
      if (pathHistory.lastAccessed) {
        const lastAccessed = new Date(pathHistory.lastAccessed).getTime();
        if (now - lastAccessed > maxAge && pathHistory.accessCount < SMART_CACHE_THRESHOLD) {
          delete history[path];
          cleaned = true;
        }
      }
    }
    
    if (cleaned) {
      await fs.writeFile(historyFilePath, JSON.stringify(history), 'utf8');
      console.log('Cleaned old load history entries');
    }
  } catch (error) {
    console.error('Error cleaning load history:', error);
  }
}

// Optimize cache by removing least accessed entries when cache gets too large
async function optimizeCache(username = null) {
  try {
    const cacheFilePath = getCacheFilePath(username);
    const historyFilePath = path.join(getCacheDir(), LOAD_HISTORY_FILE);
    
    // Check cache file size
    try {
      const stats = await fs.stat(cacheFilePath);
      const maxCacheSize = 50 * 1024 * 1024; // 50MB max cache size
      
      if (stats.size > maxCacheSize) {
        console.log(`Cache file too large (${Math.round(stats.size / 1024 / 1024)}MB), optimizing...`);
        
        // Load cache and history
        const cacheData = await readCache(username);
        let history = {};
        
        try {
          const historyData = await fs.readFile(historyFilePath, 'utf8');
          history = JSON.parse(historyData);
        } catch (error) {
          // No history available, can't optimize effectively
          return;
        }
        
        // Remove least accessed directories from cache
        if (cacheData && cacheData.structure) {
          const optimizedStructure = await removeUnusedCacheEntries(cacheData.structure, history);
          cacheData.structure = optimizedStructure;
          cacheData.optimized = true;
          cacheData.optimizedAt = new Date().toISOString();
          
          await writeCache(cacheData, username);
          console.log('Cache optimized successfully');
        }
      }
    } catch (statError) {
      // Cache file doesn't exist, nothing to optimize
      return;
    }
  } catch (error) {
    console.error('Error optimizing cache:', error);
  }
}

// Remove unused cache entries based on access history
async function removeUnusedCacheEntries(structure, history, threshold = 1) {
  if (!structure || typeof structure !== 'object') {
    return structure;
  }
  
  // If this is a directory structure
  if (structure.directories && Array.isArray(structure.directories)) {
    structure.directories = structure.directories.filter(dir => {
      const pathHistory = history[dir.path];
      // Keep directories that are frequently accessed or recently accessed
      if (pathHistory && pathHistory.accessCount >= threshold) {
        return true;
      }
      
      // Keep directories accessed in the last 24 hours
      if (pathHistory && pathHistory.lastAccessed) {
        const lastAccessed = new Date(pathHistory.lastAccessed).getTime();
        const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
        if (lastAccessed > oneDayAgo) {
          return true;
        }
      }
      
      return false;
    });
    
    // Recursively clean subdirectories
    for (const dir of structure.directories) {
      if (dir.directories) {
        dir.directories = await removeUnusedCacheEntries(dir, history, threshold);
      }
    }
  }
  
  return structure;
}

// Load history tracking functions
async function updateLoadHistory(dirPath, loadTime, success = true) {
  try {
    await ensureCacheDir();
    const historyFilePath = path.join(getCacheDir(), LOAD_HISTORY_FILE);
    
    let history = {};
    try {
      const historyData = await fs.readFile(historyFilePath, 'utf8');
      history = JSON.parse(historyData);
    } catch (error) {
      // File doesn't exist or is invalid, start with empty history
      history = {};
    }
    
    if (!history[dirPath]) {
      history[dirPath] = {
        accessCount: 0,
        lastAccessed: null,
        averageLoadTime: 0,
        totalLoadTime: 0,
        successRate: 1.0,
        totalAttempts: 0
      };
    }
    
    const pathHistory = history[dirPath];
    pathHistory.accessCount++;
    pathHistory.lastAccessed = new Date().toISOString();
    pathHistory.totalAttempts++;
    pathHistory.totalLoadTime += loadTime;
    pathHistory.averageLoadTime = pathHistory.totalLoadTime / pathHistory.totalAttempts;
    
    // Update success rate
    const successCount = Math.round(pathHistory.successRate * (pathHistory.totalAttempts - 1)) + (success ? 1 : 0);
    pathHistory.successRate = successCount / pathHistory.totalAttempts;
    
    await fs.writeFile(historyFilePath, JSON.stringify(history), 'utf8');
  } catch (error) {
    console.error('Error updating load history:', error);
  }
}

async function getLoadHistory(path) {
  try {
    await ensureCacheDir();
    const historyFilePath = path.join(getCacheDir(), LOAD_HISTORY_FILE);
    
    const historyData = await fs.readFile(historyFilePath, 'utf8');
    const history = JSON.parse(historyData);
    
    return history[path] || null;
  } catch (error) {
    return null;
  }
}

async function shouldPrioritizeInCache(path) {
  const history = await getLoadHistory(path);
  return history && history.accessCount >= SMART_CACHE_THRESHOLD;
}

// Check if cache is valid (within TTL and correct version)
function isCacheValid(cacheData) {
  if (!cacheData || !cacheData.timestamp) {
    return false;
  }
  
  // Check cache version compatibility
  if (!cacheData.version || cacheData.version < CACHE_VERSION) {
    console.log('Cache version outdated, invalidating cache');
    return false;
  }
  
  // Check if cache is within TTL
  const now = Date.now();
  const cacheTime = new Date(cacheData.timestamp).getTime();
  const ttlMs = CACHE_TTL_HOURS * 60 * 60 * 1000;
  
  const isValid = (now - cacheTime) < ttlMs;
  if (!isValid) {
    console.log('Cache expired, invalidating cache');
  }
  
  return isValid;
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

// Create minimal directory structure when all other methods fail
function createMinimalStructure() {
  return {
    path: '/',
    name: 'root',
    type: 'directory',
    files: [],
    directories: [],
    isAccessible: false,
    hasChildren: false,
    loaded: false,
    timestamp: new Date().toISOString(),
    error: 'Unable to connect to FTP server - showing offline mode'
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
    
    // Initialize username for cache
    await initializeUsername();
    
    // Initialize connection pool
    await connectionPool.initialize(ftpConfig);
    
    // Create legacy single connection for backward compatibility
    ftpClient = new Client();
    
    // Configure timeouts to prevent hanging
    ftpClient.timeout = 30000; // 30 seconds timeout
    
    // Set up error handling
    ftpClient.ftp.socket.on('error', (error) => {
      console.error('FTP socket error:', error);
      isConnected = false;
    });
    
    ftpClient.ftp.socket.on('close', () => {
      console.log('FTP connection closed');
      isConnected = false;
    });
    
    ftpClient.ftp.socket.on('timeout', () => {
      console.warn('FTP socket timeout');
      isConnected = false;
    });
    
    // Connect to server with timeout
    const connectPromise = ftpClient.access({
      host: ftpConfig.host,
      port: ftpConfig.port || 21,
      user: ftpConfig.username,
      password: ftpConfig.password,
      secure: ftpConfig.secure || false
    });
    
    // Add connection timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Connection timeout after 30 seconds')), 30000);
    });
    
    await Promise.race([connectPromise, timeoutPromise]);
    
    isConnected = true;
    console.log(`Connected to FTP server: ${ftpConfig.host}`);
    console.log(`Connection pool initialized with ${connectionPool.maxConnections} max connections`);
    
    return {
      success: true,
      message: 'Successfully connected to FTP server with connection pooling',
      host: ftpConfig.host,
      port: ftpConfig.port || 21,
      poolStats: connectionPool.getStats()
    };
    
  } catch (error) {
    isConnected = false;
    if (ftpClient) {
      ftpClient.close();
      ftpClient = null;
    }
    await connectionPool.closeAll();
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
    
    // Close all pooled connections
    await connectionPool.closeAll();
    
    isConnected = false;
    console.log('Disconnected from FTP server and closed connection pool');
    return { success: true, message: 'Disconnected from FTP server and closed connection pool' };
  } catch (error) {
    console.error('Error disconnecting from FTP:', error);
    ftpClient = null;
    isConnected = false;
    await connectionPool.closeAll();
    throw new Error(`Failed to disconnect: ${error.message}`);
  }
}

// List files and directories in the specified path
async function list(remotePath = '/', retryCount = 0) {
  // Normalize path to prevent path traversal
  const normalizedPath = path.posix.normalize(remotePath);
  if (normalizedPath.includes('..')) {
    throw new Error('Path traversal is not allowed');
  }
  
  const maxRetries = 3;
  const retryDelay = 1000; // 1 second
  
  try {
    // Ensure we're connected
    if (!isConnected || !ftpClient) {
      await connect();
    }
    
    console.log(`Listing FTP directory: ${normalizedPath}`);
    
    // Create timeout promise for list operation
    const listPromise = ftpClient.list(normalizedPath);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('List operation timeout after 15 seconds')), 15000);
    });
    
    // Get directory listing from FTP server with timeout
    const rawList = await Promise.race([listPromise, timeoutPromise]);
    
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
    
    // Handle timeout and connection errors with retry logic
    const isTimeoutError = error.message.includes('timeout') || error.message.includes('Timeout');
    const isConnectionError = error.message.includes('connection') || error.message.includes('socket') || error.message.includes('closed');
    
    if ((isTimeoutError || isConnectionError) && retryCount < maxRetries) {
      console.log(`Retrying list operation (${retryCount + 1}/${maxRetries}) after ${retryDelay}ms...`);
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, retryDelay));
      
      try {
        // Force reconnection
        isConnected = false;
        if (ftpClient) {
          ftpClient.close();
          ftpClient = null;
        }
        await connect();
        
        // Retry the list operation
        return await list(normalizedPath, retryCount + 1);
      } catch (retryError) {
        if (retryCount === maxRetries - 1) {
          throw new Error(`Failed to list directory after ${maxRetries} retries: ${retryError.message}`);
        }
        throw retryError;
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

// Enhanced download function with progress tracking and resume capability
async function downloadWithProgress(remotePath, localPath, onProgress = null, allowResume = true) {
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

    console.log(`Downloading file with progress: ${normalizedRemotePath} -> ${localPath}`);
    
    // Ensure local directory exists
    const localDir = path.dirname(localPath);
    await fs.mkdir(localDir, { recursive: true });
    
    // Get remote file size for progress calculation
    let remoteFileSize = 0;
    let resumePosition = 0;
    
    try {
      const fileList = await ftpClient.list(path.posix.dirname(normalizedRemotePath));
      const fileName = path.posix.basename(normalizedRemotePath);
      const fileInfo = fileList.find(item => item.name === fileName && item.type === 'file');
      
      if (fileInfo && fileInfo.size) {
        remoteFileSize = parseInt(fileInfo.size);
      }
    } catch (listError) {
      console.warn('Could not get remote file size:', listError.message);
    }
    
    // Check if local file exists for resume capability
    if (allowResume && await fs.access(localPath).then(() => true).catch(() => false)) {
      const localStats = await fs.stat(localPath);
      resumePosition = localStats.size;
      
      // If local file is same size or larger, consider it complete
      if (remoteFileSize > 0 && resumePosition >= remoteFileSize) {
        console.log('File already downloaded completely');
        if (onProgress) onProgress(100, remoteFileSize, remoteFileSize, 'Download complete');
        return {
          success: true,
          remotePath: normalizedRemotePath,
          localPath: localPath,
          fileSize: remoteFileSize,
          resumed: false,
          message: 'File already downloaded'
        };
      }
      
      console.log(`Resuming download from position: ${resumePosition}`);
      if (onProgress) onProgress(Math.round((resumePosition / remoteFileSize) * 100), resumePosition, remoteFileSize, 'Resuming download...');
    }
    
    let downloadedBytes = resumePosition;
    const chunks = [];
    
    // Set up progress tracking
    const progressTracker = {
      write: (chunk) => {
        chunks.push(chunk);
        downloadedBytes += chunk.length;
        
        if (onProgress && remoteFileSize > 0) {
          const progress = Math.round((downloadedBytes / remoteFileSize) * 100);
          const speed = calculateDownloadSpeed(downloadedBytes - resumePosition, Date.now());
          onProgress(progress, downloadedBytes, remoteFileSize, `Downloading... ${formatSpeed(speed)}`);
        }
      },
      end: () => {}
    };
    
    // Perform download with resume support
    if (resumePosition > 0) {
      // For resume, we need to use REST command
      try {
        await ftpClient.ftp.send(`REST ${resumePosition}`);
        await ftpClient.downloadTo(progressTracker, normalizedRemotePath);
        
        // Append new data to existing file
        const newData = Buffer.concat(chunks);
        await fs.appendFile(localPath, newData);
      } catch (resumeError) {
        console.warn('Resume failed, starting fresh download:', resumeError.message);
        // Fallback to fresh download
        resumePosition = 0;
        downloadedBytes = 0;
        chunks.length = 0;
        await ftpClient.downloadTo(progressTracker, normalizedRemotePath);
        const fileData = Buffer.concat(chunks);
        await fs.writeFile(localPath, fileData);
      }
    } else {
      // Fresh download
      await ftpClient.downloadTo(progressTracker, normalizedRemotePath);
      const fileData = Buffer.concat(chunks);
      await fs.writeFile(localPath, fileData);
    }
    
    // Final progress update
    if (onProgress) {
      onProgress(100, downloadedBytes, downloadedBytes, 'Download complete');
    }
    
    console.log(`File downloaded successfully: ${localPath} (${downloadedBytes} bytes)`);
    
    return {
      success: true,
      remotePath: normalizedRemotePath,
      localPath: localPath,
      fileSize: downloadedBytes,
      resumed: resumePosition > 0,
      message: resumePosition > 0 ? 'File downloaded successfully (resumed)' : 'File downloaded successfully'
    };
    
  } catch (error) {
    console.error('Error downloading file with progress:', error);
    
    // If connection error, try to reconnect once
    if (error.message.includes('connection') || error.message.includes('socket')) {
      try {
        isConnected = false;
        await connect();
        // Retry without resume to avoid complications
        return await downloadWithProgress(remotePath, localPath, onProgress, false);
      } catch (retryError) {
        throw new Error(`Failed to download file after retry: ${retryError.message}`);
      }
    }
    
    throw new Error(`Failed to download file: ${error.message}`);
  }
}

// Helper function to calculate download speed
let downloadStartTime = null;
function calculateDownloadSpeed(bytesDownloaded, currentTime) {
  if (!downloadStartTime) {
    downloadStartTime = currentTime;
    return 0;
  }
  
  const timeElapsed = (currentTime - downloadStartTime) / 1000; // seconds
  return timeElapsed > 0 ? bytesDownloaded / timeElapsed : 0; // bytes per second
}

// Helper function to format download speed
function formatSpeed(bytesPerSecond) {
  if (bytesPerSecond < 1024) {
    return `${Math.round(bytesPerSecond)} B/s`;
  } else if (bytesPerSecond < 1024 * 1024) {
    return `${Math.round(bytesPerSecond / 1024)} KB/s`;
  } else {
    return `${Math.round(bytesPerSecond / (1024 * 1024))} MB/s`;
  }
}

// Read cache from file
async function readCache(username = null) {
  try {
    await ensureCacheDir();
    const cacheFilePath = getCacheFilePath(username);
    
    try {
      const cacheData = await fs.readFile(cacheFilePath, 'utf8');
      const parsed = JSON.parse(cacheData);
      
      if (isCacheValid(parsed)) {
        console.log(`Using valid cache data for user: ${username || currentUsername || 'default'}`);
        return parsed;
      } else {
        console.log(`Cache data is expired for user: ${username || currentUsername || 'default'}`);
        return null;
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log(`Cache file not found for user: ${username || currentUsername || 'default'}`);
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
async function writeCache(directoryStructure, username = null) {
  try {
    await ensureCacheDir();
    const cacheFilePath = getCacheFilePath(username);
    const user = username || currentUsername || 'default';
    
    const cacheData = {
      timestamp: new Date().toISOString(),
      structure: directoryStructure,
      version: CACHE_VERSION,
      username: user,
      cacheId: `${user}_${Date.now()}` // Unique cache identifier
    };
    
    // Write cache without indentation for smaller file size and faster I/O
    await fs.writeFile(cacheFilePath, JSON.stringify(cacheData), 'utf8');
    console.log(`Cache updated successfully for user: ${user}`);
    
    // Clean old cache files
    await cleanOldCacheFiles();
    
    return cacheData;
  } catch (error) {
    console.error('Error writing cache:', error);
    throw error;
  }
}

// Build directory structure with optimized lazy loading for faster performance
// Concurrent directory processing with smart caching
async function buildDirectoryStructureConcurrent(basePath = '/', maxDepth = 2, currentDepth = 0) {
  const normalizedPath = basePath === '/' ? '/' : basePath.replace(/\/$/, '');
  const startTime = Date.now();
  
  const structure = {
    name: normalizedPath === '/' ? 'Root' : normalizedPath.split('/').pop(),
    type: 'directory',
    path: normalizedPath,
    files: [],
    directories: [],
    isAccessible: true,
    hasChildren: false,
    loaded: true,
    timestamp: new Date().toISOString()
  };
  
  try {
    console.log(`Building directory structure (concurrent) for: ${normalizedPath} (depth: ${currentDepth}/${maxDepth})`);
    
    // Check if this path should be prioritized in cache
    const shouldPrioritize = await shouldPrioritizeInCache(normalizedPath);
    
    const buildPromise = async () => {
      const items = await list(normalizedPath);
      
      // Separate files and directories
      const files = items.filter(item => item.type === 'file');
      const directories = items.filter(item => item.type === 'directory');
      
      // Add files immediately
      structure.files.push(...files);
      
      // Process directories concurrently with limited concurrency
      const directoryPromises = directories.map(async (item) => {
        const dirPath = path.posix.join(normalizedPath, item.name);
        
        try {
          // Add timeout for directory access check
          const accessCheckPromise = list(dirPath);
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Directory access check timeout')), 8000);
          });
          
          const dirItems = await Promise.race([accessCheckPromise, timeoutPromise]);
          const hasChildren = dirItems.some(subItem => subItem.type === 'directory');
          
          return {
            ...item,
            path: dirPath,
            isAccessible: true,
            hasChildren,
            loaded: false,
            files: [],
            directories: []
          };
        } catch (error) {
          if (error.code === 550 || error.type === 'ACCESS_DENIED') {
            console.log(`Directory ${dirPath} access denied - marking as restricted`);
          } else {
            console.warn(`Directory ${dirPath} check failed: ${error.message}`);
          }
          
          return {
            ...item,
            path: dirPath,
            isAccessible: false,
            hasChildren: false,
            loaded: false,
            files: [],
            directories: []
          };
        }
      });
      
      // Process directories with controlled concurrency
      const processedDirectories = await processConcurrently(directoryPromises, MAX_CONCURRENT_OPERATIONS);
      structure.directories.push(...processedDirectories);
      
      return structure;
    };
    
    // Add overall timeout for the build process
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Build timeout for ${normalizedPath} after 25 seconds`)), 25000);
    });
    
    const result = await Promise.race([buildPromise(), timeoutPromise]);
    
    // Update hasChildren flag for the root structure
    result.hasChildren = result.directories.length > 0;
    
    // Update load history
    const loadTime = Date.now() - startTime;
    await updateLoadHistory(normalizedPath, loadTime, true);
    
    return result;
  } catch (error) {
    console.error(`Error building directory structure for ${normalizedPath}:`, error);
    
    // Update load history with failure
    const loadTime = Date.now() - startTime;
    await updateLoadHistory(normalizedPath, loadTime, false);
    
    // Return partial structure with error info instead of empty structure
    structure.isAccessible = false;
    structure.error = error.message;
    return structure;
  }
}

// Helper function to process promises with controlled concurrency
async function processConcurrently(promises, maxConcurrency) {
  const results = [];
  const executing = [];
  
  for (const promise of promises) {
    const p = Promise.resolve(promise).then(result => {
      executing.splice(executing.indexOf(p), 1);
      return result;
    });
    
    results.push(p);
    executing.push(p);
    
    if (executing.length >= maxConcurrency) {
      await Promise.race(executing);
    }
  }
  
  return Promise.all(results);
}

// Legacy function for backward compatibility
async function buildDirectoryStructure(basePath = '/', maxDepth = 2, currentDepth = 0) {
  return buildDirectoryStructureConcurrent(basePath, maxDepth, currentDepth);
}

// Load directory contents on demand with concurrent processing and smart caching
async function loadDirectoryContentsConcurrent(dirPath, maxDepth = 1) {
  const startTime = Date.now();
  
  try {
    console.log(`Loading directory contents (concurrent) for: ${dirPath}`);
    
    // Check load history for optimization hints
    const history = await getLoadHistory(dirPath);
    const shouldPrioritize = history && history.accessCount >= SMART_CACHE_THRESHOLD;
    
    if (shouldPrioritize) {
      console.log(`Prioritizing ${dirPath} based on access history (${history.accessCount} accesses)`);
    }
    
    const items = await list(dirPath);
    const structure = {
      path: dirPath,
      files: [],
      directories: [],
      loaded: true,
      timestamp: new Date().toISOString(),
      loadTime: 0,
      prioritized: shouldPrioritize
    };
    
    // Separate files and directories
    const files = items.filter(item => item.type === 'file');
    const directories = items.filter(item => item.type === 'directory');
    
    // Add files immediately
    structure.files.push(...files);
    
    // Process directories concurrently
    const directoryPromises = directories.map(async (item) => {
      const subDirPath = path.posix.join(dirPath, item.name);
      
      try {
        // Use shorter timeout for frequently accessed paths
        const timeout = shouldPrioritize ? 6000 : 8000;
        const accessCheckPromise = list(subDirPath);
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Directory access check timeout')), timeout);
        });
        
        const subItems = await Promise.race([accessCheckPromise, timeoutPromise]);
        const hasChildren = subItems.some(subItem => subItem.type === 'directory');
        
        return {
          ...item,
          path: subDirPath,
          isAccessible: true,
          hasChildren,
          loaded: false,
          files: [],
          directories: []
        };
      } catch (error) {
        if (error.code === 550 || error.type === 'ACCESS_DENIED') {
          console.log(`Subdirectory ${subDirPath} access denied - marking as restricted`);
        } else {
          console.warn(`Subdirectory ${subDirPath} check failed: ${error.message}`);
        }
        
        return {
          ...item,
          path: subDirPath,
          isAccessible: false,
          hasChildren: false,
          loaded: false,
          files: [],
          directories: []
        };
      }
    });
    
    // Process with controlled concurrency
    const processedDirectories = await processConcurrently(directoryPromises, MAX_CONCURRENT_OPERATIONS);
    structure.directories.push(...processedDirectories);
    
    // Record load time and update history
    const loadTime = Date.now() - startTime;
    structure.loadTime = loadTime;
    await updateLoadHistory(dirPath, loadTime, true);
    
    return structure;
  } catch (error) {
    console.error(`Error loading directory contents for ${dirPath}:`, error);
    
    // Update load history with failure
    const loadTime = Date.now() - startTime;
    await updateLoadHistory(dirPath, loadTime, false);
    
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

// Legacy function for backward compatibility
async function loadDirectoryContents(dirPath, maxDepth = 1) {
  return loadDirectoryContentsConcurrent(dirPath, maxDepth);
}

// Windows File Explorer-like lazy loading system
class LazyDirectoryLoader {
  constructor() {
    this.loadingQueue = new Map(); // Track ongoing loads
    this.backgroundWorker = null;
    this.visibleDirectories = new Set(); // Currently visible directories
    this.prefetchQueue = new Set(); // Directories to prefetch
    this.directoryCache = new Map(); // Per-directory cache with TTL
  }

  // Load directory only when requested (like Windows Explorer)
  async loadDirectoryOnDemand(dirPath, options = {}) {
    const { forceRefresh = false, priority = 'normal', usePooled = false } = options;
    
    // Check if already loading
    if (this.loadingQueue.has(dirPath)) {
      return await this.loadingQueue.get(dirPath);
    }

    // Check cache first (per-directory TTL)
    if (!forceRefresh) {
      const cached = this.getFromDirectoryCache(dirPath);
      if (cached) {
        console.log(`Using cached data for directory: ${dirPath}`);
        return cached;
      }
    }

    // Create loading promise
    const loadPromise = this._loadSingleDirectory(dirPath, priority, usePooled);
    this.loadingQueue.set(dirPath, loadPromise);

    try {
      const result = await loadPromise;
      this.setDirectoryCache(dirPath, result);
      return result;
    } finally {
      this.loadingQueue.delete(dirPath);
    }
  }

  // Internal method to load single directory
  async _loadSingleDirectory(dirPath, priority = 'normal', usePooled = false) {
    const startTime = Date.now();
    
    try {
      console.log(`Lazy loading directory: ${dirPath} (priority: ${priority}, pooled: ${usePooled})`);
      
      // Use pooled connection for background operations or regular connection for user operations
      const items = usePooled ? await listPooled(dirPath) : await list(dirPath);
      
      // Debug logging to see what we get from FTP server
      console.log(`Raw FTP items for ${dirPath}:`, items.length, 'items');
      console.log('Sample items:', items.slice(0, 3).map(item => ({
        name: item.name,
        type: item.type,
        isDirectory: item.isDirectory,
        isFile: item.isFile
      })));
      
      const files = items.filter(item => item.type === 'file');
      const directories = items.filter(item => item.type === 'directory').map(dir => ({
        ...dir,
        path: path.posix.join(dirPath, dir.name),
        loaded: false, // Mark as not loaded initially
        hasChildren: null, // Unknown until expanded
        isAccessible: true
      }));
      
      console.log(`Processed ${dirPath}: ${files.length} files, ${directories.length} directories`);
      if (directories.length > 0) {
        console.log('Directory names:', directories.map(d => d.name));
      }
      
      const structure = {
        path: dirPath,
        files,
        directories,
        loaded: true,
        timestamp: new Date().toISOString(),
        loadTime: Date.now() - startTime,
        priority
      };

      await updateLoadHistory(dirPath, structure.loadTime, true);
      return structure;
    } catch (error) {
      console.error(`Error lazy loading directory ${dirPath}:`, error);
      await updateLoadHistory(dirPath, Date.now() - startTime, false);
      throw error;
    }
  }

  // Set visible directories for background refresh
  setVisibleDirectories(directories) {
    this.visibleDirectories.clear();
    directories.forEach(dir => this.visibleDirectories.add(dir));
    this._schedulePrefetch();
  }

  // Background refresh for visible directories
  async refreshVisibleDirectories() {
    const refreshPromises = Array.from(this.visibleDirectories).map(async (dirPath) => {
      try {
        await this.loadDirectoryOnDemand(dirPath, { forceRefresh: true, priority: 'background' });
        console.log(`Background refreshed: ${dirPath}`);
      } catch (error) {
        console.warn(`Background refresh failed for ${dirPath}:`, error.message);
      }
    });

    await Promise.allSettled(refreshPromises);
  }

  // Schedule prefetch for adjacent directories
  _schedulePrefetch() {
    if (this.backgroundWorker) {
      clearTimeout(this.backgroundWorker);
    }

    this.backgroundWorker = setTimeout(async () => {
      await this._prefetchAdjacentDirectories();
    }, 2000); // Wait 2 seconds before prefetching
  }

  // Prefetch adjacent directories in background
  async _prefetchAdjacentDirectories() {
    const adjacentDirs = new Set();
    
    // Find parent and sibling directories
    this.visibleDirectories.forEach(dirPath => {
      const parentPath = path.posix.dirname(dirPath);
      if (parentPath !== dirPath && parentPath !== '.') {
        adjacentDirs.add(parentPath);
      }
    });

    // Prefetch with low priority
    const prefetchPromises = Array.from(adjacentDirs).map(async (dirPath) => {
      if (!this.visibleDirectories.has(dirPath) && !this.loadingQueue.has(dirPath)) {
        try {
          await this.loadDirectoryOnDemand(dirPath, { priority: 'prefetch' });
          console.log(`Prefetched: ${dirPath}`);
        } catch (error) {
          console.warn(`Prefetch failed for ${dirPath}:`, error.message);
        }
      }
    });

    await Promise.allSettled(prefetchPromises);
  }

  // Per-directory cache management
  getFromDirectoryCache(dirPath) {
    const cached = this.directoryCache.get(dirPath);
    if (!cached) return null;

    const now = Date.now();
    const age = now - cached.timestamp;
    const ttl = this._getTTLForDirectory(dirPath);

    if (age > ttl) {
      this.directoryCache.delete(dirPath);
      return null;
    }

    return cached.data;
  }

  setDirectoryCache(dirPath, data) {
    this.directoryCache.set(dirPath, {
      data,
      timestamp: Date.now()
    });
  }

  // Dynamic TTL based on directory access patterns
  _getTTLForDirectory(dirPath) {
    const baseTTL = 5 * 60 * 1000; // 5 minutes base
    const maxTTL = 30 * 60 * 1000; // 30 minutes max
    
    // Frequently accessed directories get longer TTL
    if (this.visibleDirectories.has(dirPath)) {
      return maxTTL;
    }
    
    return baseTTL;
  }

  // Clear cache for specific directory
  clearDirectoryCache(dirPath) {
    this.directoryCache.delete(dirPath);
  }

  // Get cache statistics
  getCacheStats() {
    return {
      cachedDirectories: this.directoryCache.size,
      visibleDirectories: this.visibleDirectories.size,
      loadingQueue: this.loadingQueue.size,
      prefetchQueue: this.prefetchQueue.size
    };
  }
}

// Global lazy loader instance
const lazyLoader = new LazyDirectoryLoader();

// Windows Explorer-like directory loading function
async function loadDirectoryLazy(dirPath, options = {}) {
  try {
    const structure = await lazyLoader.loadDirectoryOnDemand(dirPath, options);
    return {
      success: true,
      structure: structure,
      error: null
    };
  } catch (error) {
    console.error(`Error in loadDirectoryLazy for ${dirPath}:`, error);
    return {
      success: false,
      structure: null,
      error: error.message || 'Failed to load directory'
    };
  }
}

// Set currently visible directories for optimization
function setVisibleDirectories(directories) {
  lazyLoader.setVisibleDirectories(directories);
}

// Background refresh for visible directories
async function refreshVisibleDirectories() {
  return await lazyLoader.refreshVisibleDirectories();
}

// Get lazy loading statistics
function getLazyLoadStats() {
  return lazyLoader.getCacheStats();
}

// Clear specific directory from lazy cache
function clearLazyCache(dirPath) {
  lazyLoader.clearDirectoryCache(dirPath);
}

// Background worker for continuous directory monitoring
class BackgroundDirectoryWorker {
  constructor() {
    this.isRunning = false;
    this.intervalId = null;
    this.refreshInterval = 30000; // 30 seconds default
    this.monitoredDirectories = new Set();
    this.lastActivity = Date.now();
  }

  // Start background monitoring
  start(refreshInterval = 30000) {
    if (this.isRunning) {
      console.log('Background worker already running');
      return;
    }

    this.refreshInterval = refreshInterval;
    this.isRunning = true;
    
    console.log(`Starting background directory worker (refresh every ${refreshInterval}ms)`);
    
    this.intervalId = setInterval(async () => {
      await this._performBackgroundTasks();
    }, this.refreshInterval);
  }

  // Stop background monitoring
  stop() {
    if (!this.isRunning) {
      return;
    }

    console.log('Stopping background directory worker');
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    
    this.isRunning = false;
  }

  // Add directory to monitoring list
  addMonitoredDirectory(dirPath) {
    this.monitoredDirectories.add(dirPath);
    this.lastActivity = Date.now();
    console.log(`Added ${dirPath} to background monitoring`);
  }

  // Remove directory from monitoring
  removeMonitoredDirectory(dirPath) {
    this.monitoredDirectories.delete(dirPath);
    console.log(`Removed ${dirPath} from background monitoring`);
  }

  // Update activity timestamp
  updateActivity() {
    this.lastActivity = Date.now();
  }

  // Check if user is inactive
  isUserInactive(inactiveThreshold = 300000) { // 5 minutes
    return (Date.now() - this.lastActivity) > inactiveThreshold;
  }

  // Perform background tasks
  async _performBackgroundTasks() {
    try {
      // Skip if user is inactive to save resources
      if (this.isUserInactive()) {
        console.log('User inactive, skipping background refresh');
        return;
      }

      // Refresh visible directories first (high priority)
      if (lazyLoader.visibleDirectories.size > 0) {
        await lazyLoader.refreshVisibleDirectories();
      }

      // Refresh monitored directories (medium priority)
      if (this.monitoredDirectories.size > 0) {
        await this._refreshMonitoredDirectories();
      }

      // Cleanup old cache entries (low priority)
      await this._cleanupOldCacheEntries();

    } catch (error) {
      console.warn('Background worker task failed:', error.message);
    }
  }

  // Refresh monitored directories
  async _refreshMonitoredDirectories() {
    const refreshPromises = Array.from(this.monitoredDirectories).map(async (dirPath) => {
      try {
        // Only refresh if not already in visible directories
        if (!lazyLoader.visibleDirectories.has(dirPath)) {
          await lazyLoader.loadDirectoryOnDemand(dirPath, { 
            forceRefresh: true, 
            priority: 'background-monitor',
            usePooled: true // Use pooled connections for background operations
          });
          console.log(`Background monitored refresh: ${dirPath}`);
        }
      } catch (error) {
        console.warn(`Background monitor refresh failed for ${dirPath}:`, error.message);
      }
    });

    await Promise.allSettled(refreshPromises);
  }

  // Cleanup old cache entries
  async _cleanupOldCacheEntries() {
    const maxCacheSize = 100; // Maximum cached directories
    
    if (lazyLoader.directoryCache.size > maxCacheSize) {
      const entries = Array.from(lazyLoader.directoryCache.entries());
      
      // Sort by timestamp (oldest first)
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      
      // Remove oldest entries
      const toRemove = entries.slice(0, entries.length - maxCacheSize);
      toRemove.forEach(([dirPath]) => {
        lazyLoader.directoryCache.delete(dirPath);
      });
      
      console.log(`Cleaned up ${toRemove.length} old cache entries`);
    }
  }

  // Get worker statistics
  getStats() {
    return {
      isRunning: this.isRunning,
      refreshInterval: this.refreshInterval,
      monitoredDirectories: this.monitoredDirectories.size,
      lastActivity: this.lastActivity,
      isUserInactive: this.isUserInactive()
    };
  }
}

// Global background worker instance
const backgroundWorker = new BackgroundDirectoryWorker();

// Background worker control functions
function startBackgroundWorker(refreshInterval = 30000) {
  backgroundWorker.start(refreshInterval);
}

function stopBackgroundWorker() {
  backgroundWorker.stop();
}

function addMonitoredDirectory(dirPath) {
  backgroundWorker.addMonitoredDirectory(dirPath);
}

function removeMonitoredDirectory(dirPath) {
  backgroundWorker.removeMonitoredDirectory(dirPath);
}

function updateWorkerActivity() {
  backgroundWorker.updateActivity();
}

function getBackgroundWorkerStats() {
  return backgroundWorker.getStats();
}

// Refresh cache by rebuilding directory structure
async function refreshCache(username = null, forceRefresh = false) {
  const user = username || currentUsername || 'default';
  console.log(`Refreshing FTP cache for user: ${user}${forceRefresh ? ' (forced)' : ''}...`);
  
  try {
    // Check if we need to initialize username
    if (!currentUsername) {
      await initializeUsername();
    }
    
    // Try to build fresh directory structure with timeout
    const buildPromise = buildDirectoryStructure('/', 1, 0);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Cache refresh timeout after 45 seconds')), 45000);
    });
    
    const structure = await Promise.race([buildPromise, timeoutPromise]);
    
    // Write to cache
    await writeCache(structure, username);
    
    console.log(`Cache refreshed successfully for user: ${user}`);
    return structure;
    
  } catch (error) {
    console.error('Error refreshing cache:', error);
    
    // Try to read existing cache as fallback
    try {
      const fallbackCache = await readCache(username);
      if (fallbackCache && fallbackCache.structure) {
        console.log(`Using existing cache as fallback for user: ${user}`);
        return fallbackCache.structure;
      }
    } catch (fallbackError) {
      console.error('Fallback cache read failed:', fallbackError);
    }
    
    // If all else fails, throw the original error
    throw new Error(`Failed to refresh cache: ${error.message}`);
  }
}

// Get cached directory structure or build it if not available
async function getCachedStructure(username = null, forceRefresh = false) {
  try {
    const user = username || currentUsername || 'default';
    
    // Check if we need to initialize username
    if (!currentUsername) {
      await initializeUsername();
    }
    
    // Try to read from cache first (for fallback)
    const cachedData = await readCache(username);
    
    // If force refresh is requested, try to refresh but fallback to cache on failure
    if (forceRefresh) {
      console.log(`Force refresh requested for user: ${user}`);
      try {
        return await refreshCache(username, true);
      } catch (refreshError) {
        console.warn('Force refresh failed, falling back to cached data:', refreshError.message);
        if (cachedData && cachedData.structure) {
          console.log(`Using cached directory structure as fallback for user: ${user}`);
          return cachedData.structure;
        }
        // If no cache available, return minimal structure
        console.warn('No cached data available, returning minimal structure');
        return createMinimalStructure();
      }
    }
    
    // Check if cached data is valid and recent
    if (cachedData && cachedData.structure && isCacheValid(cachedData)) {
      console.log(`Using cached directory structure for user: ${user}`);
      return cachedData.structure;
    }
    
    // Try to refresh cache, but fallback to old cache if refresh fails
    console.log(`Cache invalid or missing for user: ${user}, attempting refresh...`);
    try {
      return await refreshCache(username);
    } catch (refreshError) {
      console.warn('Cache refresh failed, checking for any cached data:', refreshError.message);
      
      // Use old cached data if available, even if expired
      if (cachedData && cachedData.structure) {
        console.log(`Using expired cached data as fallback for user: ${user}`);
        return cachedData.structure;
      }
      
      // Last resort: return minimal structure
      console.warn('No cached data available, returning minimal structure');
      return createMinimalStructure();
    }
    
  } catch (error) {
    console.error('Error getting cached structure:', error);
    
    // Final fallback: try to read any available cache
    try {
      const fallbackCache = await readCache(username);
      if (fallbackCache && fallbackCache.structure) {
        console.log('Using fallback cached data due to error');
        return fallbackCache.structure;
      }
    } catch (fallbackError) {
      console.error('Fallback cache read failed:', fallbackError);
    }
    
    // Ultimate fallback: minimal structure
    console.warn('All fallback attempts failed, returning minimal structure');
    return createMinimalStructure();
  }
}

// Check connection status
function getConnectionStatus() {
  return {
    isConnected,
    hasClient: !!ftpClient
  };
}

// Clear cache for specific user
async function clearUserCache(username = null) {
  try {
    const user = username || currentUsername || 'default';
    const cacheFilePath = getCacheFilePath(username);
    
    try {
      await fs.unlink(cacheFilePath);
      console.log(`Cache cleared for user: ${user}`);
      return { success: true, message: `Cache cleared for user: ${user}` };
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log(`No cache file found for user: ${user}`);
        return { success: true, message: `No cache to clear for user: ${user}` };
      }
      throw error;
    }
  } catch (error) {
    console.error('Error clearing user cache:', error);
    throw new Error(`Failed to clear cache for user: ${error.message}`);
  }
}

// Check if cache exists for current user
async function checkCacheExists(username = null) {
  try {
    await ensureCacheDir();
    
    const targetUsername = username || currentUsername;
    if (!targetUsername) {
      console.warn('No username provided for cache check');
      return false;
    }
    
    const cacheFilePath = getCacheFilePath(targetUsername);
    
    try {
      const stats = await fs.stat(cacheFilePath);
      return stats.isFile();
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  } catch (error) {
    console.error('Error checking cache existence:', error);
    return false;
  }
}

// Get list of all cached users
async function getCachedUsers() {
  try {
    await ensureCacheDir();
    const cacheDir = getCacheDir();
    const files = await fs.readdir(cacheDir);
    
    const users = [];
    for (const file of files) {
      if (file.startsWith(CACHE_FILE_PREFIX) && file.endsWith('.json')) {
        const username = file.replace(CACHE_FILE_PREFIX, '').replace('.json', '');
        const filePath = path.join(cacheDir, file);
        
        try {
          const stats = await fs.stat(filePath);
          const cacheData = JSON.parse(await fs.readFile(filePath, 'utf8'));
          
          users.push({
            username: username,
            lastModified: stats.mtime,
            cacheValid: isCacheValid(cacheData),
            cacheVersion: cacheData.version || 1,
            cacheId: cacheData.cacheId || 'unknown'
          });
        } catch (error) {
          console.warn(`Error reading cache file ${file}:`, error.message);
        }
      }
    }
    
    return users;
  } catch (error) {
    console.error('Error getting cached users:', error);
    return [];
  }
}

// Upload file to FTP server
async function upload(localPath, remotePath, onProgress = null) {
  if (!isConnected || !ftpClient) {
    throw new Error('FTP client is not connected');
  }

  try {
    console.log(`Uploading file from ${localPath} to ${remotePath}`);
    
    // Check if local file exists
    const fs = require('fs');
    if (!fs.existsSync(localPath)) {
      throw new Error(`Local file does not exist: ${localPath}`);
    }

    // Get file size for progress tracking
    const stats = fs.statSync(localPath);
    const fileSize = stats.size;
    let uploadedBytes = 0;

    // Set up progress tracking if callback provided
    if (onProgress && typeof onProgress === 'function') {
      const originalWrite = ftpClient.ftp.dataSocket?.write;
      if (ftpClient.ftp.dataSocket && originalWrite) {
        ftpClient.ftp.dataSocket.write = function(chunk) {
          uploadedBytes += chunk.length;
          const progress = Math.round((uploadedBytes / fileSize) * 100);
          onProgress(progress, uploadedBytes, fileSize);
          return originalWrite.call(this, chunk);
        };
      }
    }

    // Perform the upload
    await ftpClient.uploadFrom(localPath, remotePath);
    
    // Final progress update
    if (onProgress && typeof onProgress === 'function') {
      onProgress(100, fileSize, fileSize);
    }

    console.log(`File uploaded successfully: ${remotePath}`);
    return {
      success: true,
      localPath,
      remotePath,
      fileSize,
      message: 'File uploaded successfully'
    };
  } catch (error) {
    console.error('Upload error:', error);
    
    // If connection error, try to reconnect once
    if (error.message.includes('connection') || error.message.includes('socket')) {
      try {
        isConnected = false;
        await connect();
        await ftpClient.uploadFrom(localPath, remotePath);
        
        if (onProgress && typeof onProgress === 'function') {
          onProgress(100, 0, 0);
        }
        
        return {
          success: true,
          localPath,
          remotePath,
          message: 'File uploaded successfully after retry'
        };
      } catch (retryError) {
        throw new Error(`Failed to upload file after retry: ${retryError.message}`);
      }
    }
    
    throw new Error(`Failed to upload file: ${error.message}`);
  }
}

// Upload multiple files with progress tracking
async function uploadMultiple(fileList, targetDirectory, onFileProgress = null, onOverallProgress = null) {
  if (!isConnected || !ftpClient) {
    throw new Error('FTP client is not connected');
  }

  const results = [];
  const totalFiles = fileList.length;
  let completedFiles = 0;
  let failedFiles = 0;

  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    const fileName = path.basename(file.path);
    const remotePath = path.posix.join(targetDirectory, fileName).replace(/\\/g, '/');

    try {
      const result = await upload(file.path, remotePath, (progress, uploaded, total) => {
        if (onFileProgress) {
          onFileProgress(i, fileName, progress, uploaded, total);
        }
      });
      
      results.push({
        ...result,
        fileName,
        index: i,
        status: 'completed'
      });
      
      completedFiles++;
    } catch (error) {
      console.error(`Failed to upload ${fileName}:`, error);
      results.push({
        success: false,
        fileName,
        localPath: file.path,
        remotePath,
        index: i,
        status: 'error',
        error: error.message
      });
      
      failedFiles++;
    }

    // Update overall progress
    if (onOverallProgress) {
      const overallProgress = Math.round(((completedFiles + failedFiles) / totalFiles) * 100);
      onOverallProgress(overallProgress, completedFiles, failedFiles, totalFiles);
    }
  }

  return {
    success: failedFiles === 0,
    results,
    summary: {
      total: totalFiles,
      completed: completedFiles,
      failed: failedFiles
    }
  };
}

// Create directory on FTP server
async function createDirectory(remotePath) {
  if (!isConnected || !ftpClient) {
    throw new Error('FTP client is not connected');
  }

  try {
    await ftpClient.ensureDir(remotePath);
    console.log(`Directory created: ${remotePath}`);
    return {
      success: true,
      remotePath,
      message: 'Directory created successfully'
    };
  } catch (error) {
    console.error('Create directory error:', error);
    throw new Error(`Failed to create directory: ${error.message}`);
  }
}

// Delete a file from the FTP server
async function deleteFile(remotePath) {
  if (!isConnected) {
    await connect();
  }

  try {
    await ftpClient.remove(remotePath);
    console.log(`File deleted successfully: ${remotePath}`);
    return {
      success: true,
      remotePath,
      message: 'File deleted successfully'
    };
  } catch (error) {
    console.error('Delete file error:', error);
    
    // If connection error, try to reconnect once
    if (error.message.includes('connection') || error.message.includes('socket')) {
      try {
        isConnected = false;
        await connect();
        await ftpClient.remove(remotePath);
        
        return {
          success: true,
          remotePath,
          message: 'File deleted successfully after retry'
        };
      } catch (retryError) {
        throw new Error(`Failed to delete file after retry: ${retryError.message}`);
      }
    }
    
    throw new Error(`Failed to delete file: ${error.message}`);
  }
}

// Delete a directory from the FTP server
async function deleteDirectory(remotePath) {
  if (!isConnected) {
    await connect();
  }

  try {
    await ftpClient.removeDir(remotePath);
    console.log(`Directory deleted successfully: ${remotePath}`);
    return {
      success: true,
      remotePath,
      message: 'Directory deleted successfully'
    };
  } catch (error) {
    console.error('Delete directory error:', error);
    
    // If connection error, try to reconnect once
    if (error.message.includes('connection') || error.message.includes('socket')) {
      try {
        isConnected = false;
        await connect();
        await ftpClient.removeDir(remotePath);
        
        return {
          success: true,
          remotePath,
          message: 'Directory deleted successfully after retry'
        };
      } catch (retryError) {
        throw new Error(`Failed to delete directory after retry: ${retryError.message}`);
      }
    }
    
    throw new Error(`Failed to delete directory: ${error.message}`);
  }
}

// Delete multiple files/directories with progress tracking
async function deleteMultiple(items, onProgress) {
  const results = [];
  let completed = 0;
  
  for (const item of items) {
    try {
      let result;
      if (item.type === 'directory') {
        result = await deleteDirectory(item.path);
      } else {
        result = await deleteFile(item.path);
      }
      
      results.push({ ...result, item });
      completed++;
      
      if (onProgress && typeof onProgress === 'function') {
        onProgress({
          completed,
          total: items.length,
          progress: Math.round((completed / items.length) * 100),
          currentItem: item.path,
          success: true
        });
      }
    } catch (error) {
      console.error(`Error deleting ${item.path}:`, error);
      results.push({
        success: false,
        error: error.message,
        item
      });
      completed++;
      
      if (onProgress && typeof onProgress === 'function') {
        onProgress({
          completed,
          total: items.length,
          progress: Math.round((completed / items.length) * 100),
          currentItem: item.path,
          success: false,
          error: error.message
        });
      }
    }
  }
  
  return results;
}

// Update/edit file content on FTP server
async function updateFile(remotePath, content, onProgress = null) {
  if (!isConnected) {
    await connect();
  }

  try {
    console.log(`Updating file: ${remotePath}`);
    
    if (onProgress) {
      onProgress(0, 'Starting file update...');
    }

    // Create a temporary buffer from the content
    const buffer = Buffer.from(content, 'utf8');
    
    if (onProgress) {
      onProgress(25, 'Preparing content...');
    }

    // Upload the content to replace the existing file
    await ftpClient.uploadFrom(buffer, remotePath);
    
    if (onProgress) {
      onProgress(100, 'File updated successfully');
    }

    console.log(`File updated successfully: ${remotePath}`);
    return {
      success: true,
      remotePath,
      size: buffer.length,
      message: 'File updated successfully'
    };
  } catch (error) {
    console.error('Update file error:', error);
    if (onProgress) {
      onProgress(0, `Error: ${error.message}`);
    }
    throw new Error(`Failed to update file: ${error.message}`);
  }
}

// Replace file with new file from local path
async function replaceFile(localPath, remotePath, onProgress = null) {
  if (!isConnected) {
    await connect();
  }

  try {
    console.log(`Replacing file: ${remotePath} with ${localPath}`);
    
    if (onProgress) {
      onProgress(0, 'Starting file replacement...');
    }

    // Check if local file exists
    const fs = require('fs').promises;
    try {
      await fs.access(localPath);
    } catch (error) {
      throw new Error(`Local file not found: ${localPath}`);
    }

    if (onProgress) {
      onProgress(25, 'Reading local file...');
    }

    // Get file stats for progress tracking
    const stats = await fs.stat(localPath);
    const fileSize = stats.size;

    if (onProgress) {
      onProgress(50, 'Uploading replacement file...');
    }

    // Upload the new file to replace the existing one
    await ftpClient.uploadFrom(localPath, remotePath);
    
    if (onProgress) {
      onProgress(100, 'File replaced successfully');
    }

    console.log(`File replaced successfully: ${remotePath}`);
    return {
      success: true,
      localPath,
      remotePath,
      size: fileSize,
      message: 'File replaced successfully'
    };
  } catch (error) {
    console.error('Replace file error:', error);
    if (onProgress) {
      onProgress(0, `Error: ${error.message}`);
    }
    throw new Error(`Failed to replace file: ${error.message}`);
  }
}

// Get file content for editing
async function getFileContent(remotePath) {
  if (!isConnected) {
    await connect();
  }

  try {
    console.log(`Reading file content: ${remotePath}`);
    
    // Create a buffer to store the file content
    const chunks = [];
    
    await ftpClient.downloadTo({
      write: (chunk) => {
        chunks.push(chunk);
      },
      end: () => {}
    }, remotePath);
    
    const content = Buffer.concat(chunks).toString('utf8');
    
    console.log(`File content read successfully: ${remotePath}`);
    return {
      success: true,
      remotePath,
      content,
      size: content.length,
      message: 'File content retrieved successfully'
    };
  } catch (error) {
    console.error('Get file content error:', error);
    throw new Error(`Failed to read file content: ${error.message}`);
  }
}

// Connection Pool Optimized Functions

// Pooled list operation for better concurrent performance
async function listPooled(remotePath = '/') {
  let connection = null;
  try {
    if (!connectionPool.isInitialized) {
      throw new Error('Connection pool not initialized');
    }
    
    connection = await connectionPool.getConnection();
    const normalizedPath = path.posix.normalize(remotePath);
    
    const files = await connection.list(normalizedPath);
    return files.map(normalizeFileInfo);
  } catch (error) {
    console.error('Pooled list error:', error);
    throw new Error(`Failed to list directory: ${error.message}`);
  } finally {
    if (connection) {
      connectionPool.releaseConnection(connection);
    }
  }
}

// Pooled download operation
async function downloadPooled(remotePath, localPath) {
  let connection = null;
  try {
    if (!connectionPool.isInitialized) {
      throw new Error('Connection pool not initialized');
    }
    
    connection = await connectionPool.getConnection();
    await connection.downloadTo(localPath, remotePath);
    
    return {
      success: true,
      localPath,
      remotePath,
      message: 'File downloaded successfully using pooled connection'
    };
  } catch (error) {
    console.error('Pooled download error:', error);
    throw new Error(`Failed to download file: ${error.message}`);
  } finally {
    if (connection) {
      connectionPool.releaseConnection(connection);
    }
  }
}

// Pooled upload operation
async function uploadPooled(localPath, remotePath) {
  let connection = null;
  try {
    if (!connectionPool.isInitialized) {
      throw new Error('Connection pool not initialized');
    }
    
    connection = await connectionPool.getConnection();
    await connection.uploadFrom(localPath, remotePath);
    
    return {
      success: true,
      localPath,
      remotePath,
      message: 'File uploaded successfully using pooled connection'
    };
  } catch (error) {
    console.error('Pooled upload error:', error);
    throw new Error(`Failed to upload file: ${error.message}`);
  } finally {
    if (connection) {
      connectionPool.releaseConnection(connection);
    }
  }
}

// Concurrent operations using connection pool
async function performConcurrentOperations(operations, maxConcurrency = 3) {
  if (!connectionPool.isInitialized) {
    throw new Error('Connection pool not initialized');
  }
  
  const results = [];
  const executing = [];
  
  for (const operation of operations) {
    const promise = operation().then(result => {
      executing.splice(executing.indexOf(promise), 1);
      return result;
    });
    
    results.push(promise);
    executing.push(promise);
    
    if (executing.length >= maxConcurrency) {
      await Promise.race(executing);
    }
  }
  
  return Promise.all(results);
}

// Get connection pool statistics
function getPoolStats() {
  return connectionPool.getStats();
}

// Optimize connection pool size based on usage patterns
async function optimizeConnectionPool() {
  const stats = connectionPool.getStats();
  const utilizationRate = stats.busy / stats.total;
  
  console.log(`Connection pool utilization: ${(utilizationRate * 100).toFixed(1)}%`);
  
  // If utilization is consistently high, we might need more connections
  if (utilizationRate > 0.8 && stats.total < 5) {
    console.log('High utilization detected - consider increasing pool size');
  }
  
  // If utilization is consistently low, we might have too many connections
  if (utilizationRate < 0.2 && stats.total > 1) {
    console.log('Low utilization detected - consider decreasing pool size');
  }
  
  return {
    stats,
    utilizationRate,
    recommendation: utilizationRate > 0.8 ? 'increase' : utilizationRate < 0.2 ? 'decrease' : 'optimal'
  };
}

// Export functions
module.exports = {
  connect,
  disconnect,
  list,
  download,
  downloadWithProgress,
  upload,
  uploadMultiple,
  createDirectory,
  deleteFile,
  deleteDirectory,
  deleteMultiple,
  updateFile,
  replaceFile,
  getFileContent,
  getCachedStructure,
  refreshCache,
  getConnectionStatus,
  clearUserCache,
  checkCacheExists,
  getCachedUsers,
  initializeUsername,
  loadDirectoryContents,
  loadDirectoryContentsConcurrent,
  normalizeFileInfo,
  buildDirectoryStructure,
  buildDirectoryStructureConcurrent,
  processConcurrently,
  readCache,
  writeCache,
  updateLoadHistory,
  getLoadHistory,
  shouldPrioritizeInCache,
  optimizeCache,
  cleanOldLoadHistory,
  removeUnusedCacheEntries,
  // Connection Pool Functions
  listPooled,
  downloadPooled,
  uploadPooled,
  performConcurrentOperations,
  getPoolStats,
  optimizeConnectionPool,
  // Lazy Loading Functions
  loadDirectoryLazy,
  setVisibleDirectories,
  refreshVisibleDirectories,
  getLazyLoadStats,
  clearLazyCache,
  // Background Worker Functions
  startBackgroundWorker,
  stopBackgroundWorker,
  addMonitoredDirectory,
  removeMonitoredDirectory,
  updateWorkerActivity,
  getBackgroundWorkerStats
}
