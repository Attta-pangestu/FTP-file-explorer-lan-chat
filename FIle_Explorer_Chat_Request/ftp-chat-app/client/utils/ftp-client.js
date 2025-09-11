const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const { Client } = require('basic-ftp');
const config = require('./config');

// Connection Pool Management
class FTPConnectionPool {
  constructor(maxConnections = 15) { // Increased to 15 for maximum concurrency
    this.maxConnections = maxConnections;
    this.connections = [];
    this.availableConnections = [];
    this.busyConnections = new Set();
    this.connectionConfig = null;
    this.isInitialized = false;
    
    // Performance timing constants - optimized for speed
    this.CONNECTION_TIMEOUT = 5000; // 5 seconds (reduced from 8)
    this.LIST_TIMEOUT = 3000; // 3 seconds (reduced from 5)
    this.DOWNLOAD_TIMEOUT = 5000; // 5 seconds for downloads
    this.UPLOAD_TIMEOUT = 8000; // 8 seconds for uploads
    
    // Connection health monitoring
    this.healthCheckInterval = null;
    this.connectionHealth = new Map();
    
    // Performance tracking
    this.performanceStats = {
      totalConnections: 0,
      activeConnections: 0,
      averageResponseTime: 0,
      fastResponseCount: 0,
      slowResponseCount: 0
    };
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

  // Warm up the connection pool by pre-establishing connections
  async warmUp(targetConnections = 2) {
    if (!this.isInitialized) {
      console.warn('Cannot warm up connection pool: not initialized');
      return;
    }

    const connectionsToCreate = Math.min(
      targetConnections - this.availableConnections.length,
      this.maxConnections - this.connections.length
    );

    if (connectionsToCreate <= 0) {
      console.log('Connection pool already warmed up');
      return;
    }

    console.log(`Warming up connection pool: creating ${connectionsToCreate} connections`);
    
    const warmUpPromises = [];
    for (let i = 0; i < connectionsToCreate; i++) {
      warmUpPromises.push(
        this.createConnection().catch(error => {
          console.warn('Failed to create warm-up connection:', error.message);
          return null;
        })
      );
    }

    const results = await Promise.allSettled(warmUpPromises);
    const successful = results.filter(result => 
      result.status === 'fulfilled' && result.value !== null
    ).length;
    
    console.log(`Connection pool warm-up completed: ${successful}/${connectionsToCreate} connections created`);
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

// Enhanced file download and temporary storage system
class EnhancedFileDownloader {
  constructor() {
    this.tempDirectory = null;
    this.activeDownloads = new Map();
    this.downloadQueue = [];
    this.maxConcurrentDownloads = 3;
    this.tempFileCleanupInterval = null;
    this.maxTempFileAge = 24 * 60 * 60 * 1000; // 24 hours
    this.tempFileQuota = 1024 * 1024 * 1024; // 1GB quota
    this.usedTempSpace = 0;
    this.downloadStats = {
      totalDownloads: 0,
      successfulDownloads: 0,
      failedDownloads: 0,
      totalBytesDownloaded: 0,
      averageDownloadTime: 0,
      tempFilesCleaned: 0
    };
  }

  // Initialize temporary directory
  async init() {
    try {
      // Use system temp directory or create app-specific temp dir
      const appTempDir = path.join(app.getPath('temp'), 'ftp-explorer');
      await fs.mkdir(appTempDir, { recursive: true });
      this.tempDirectory = appTempDir;
      
      // Start cleanup interval
      this.startCleanupInterval();
      
      console.log(`Enhanced file downloader initialized with temp dir: ${this.tempDirectory}`);
      return true;
    } catch (error) {
      console.error('Failed to initialize enhanced file downloader:', error);
      return false;
    }
  }

  // Download file to temporary directory for opening
  async downloadToTemp(remotePath, options = {}) {
    const { 
      openAfterDownload = false, 
      fileName = null,
      customTempDir = null,
      priority = 'normal',
      onProgress = null,
      allowResume = true
    } = options;

    if (!this.tempDirectory) {
      await this.init();
    }

    // Generate unique filename if not provided
    const finalFileName = fileName || path.posix.basename(remotePath) || `temp_file_${Date.now()}`;
    const tempFilePath = path.join(customTempDir || this.tempDirectory, finalFileName);

    const downloadId = `download_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      console.log(`Starting enhanced download to temp: ${remotePath} -> ${tempFilePath}`);

      // Check if file already exists in temp directory
      if (await fs.access(tempFilePath).then(() => true).catch(() => false)) {
        const stats = await fs.stat(tempFilePath);
        
        // Check if file is complete and valid
        if (await this._validateTempFile(tempFilePath, remotePath)) {
          console.log(`File already exists in temp directory: ${tempFilePath}`);
          
          if (openAfterDownload) {
            await this.openFile(tempFilePath);
          }
          
          return {
            success: true,
            tempFilePath,
            downloadId,
            message: 'File already available in temp directory',
            cached: true
          };
        }
      }

      // Add to active downloads
      this.activeDownloads.set(downloadId, {
        remotePath,
        tempFilePath,
        startTime: Date.now(),
        status: 'downloading',
        priority
      });

      // Perform download with enhanced features
      const result = await this._downloadWithEnhancedFeatures(
        remotePath, 
        tempFilePath, 
        { allowResume, onProgress, priority }
      );

      // Update download statistics
      this.downloadStats.totalDownloads++;
      if (result.success) {
        this.downloadStats.successfulDownloads++;
        this.downloadStats.totalBytesDownloaded += result.fileSize || 0;
      } else {
        this.downloadStats.failedDownloads++;
      }

      // Clean up download record
      this.activeDownloads.delete(downloadId);

      // Open file if requested
      if (result.success && openAfterDownload) {
        await this.openFile(tempFilePath);
      }

      return {
        success: result.success,
        tempFilePath,
        downloadId,
        message: result.message,
        fileSize: result.fileSize,
        downloadTime: Date.now() - (this.activeDownloads.get(downloadId)?.startTime || Date.now()),
        cached: false
      };

    } catch (error) {
      console.error('Enhanced download failed:', error);
      
      // Clean up download record
      this.activeDownloads.delete(downloadId);
      this.downloadStats.failedDownloads++;
      this.downloadStats.totalDownloads++;

      throw new Error(`Enhanced download failed: ${error.message}`);
    }
  }

  // Enhanced download with advanced features
  async _downloadWithEnhancedFeatures(remotePath, localPath, options = {}) {
    const { allowResume = true, onProgress = null, priority = 'normal' } = options;
    
    try {
      // Ensure we're connected
      if (!isConnected || !ftpClient) {
        await connect();
      }

      // Normalize remote path
      const normalizedRemotePath = path.posix.normalize(remotePath);
      if (normalizedRemotePath.includes('..')) {
        throw new Error('Path traversal is not allowed');
      }

      console.log(`Enhanced downloading: ${normalizedRemotePath} -> ${localPath}`);

      // Ensure local directory exists
      const localDir = path.dirname(localPath);
      await fs.mkdir(localDir, { recursive: true });

      // Get remote file size
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

      // Check if file exists for resume
      if (allowResume && await fs.access(localPath).then(() => true).catch(() => false)) {
        const localStats = await fs.stat(localPath);
        resumePosition = localStats.size;

        if (remoteFileSize > 0 && resumePosition >= remoteFileSize) {
          console.log('File already complete in temp directory');
          return {
            success: true,
            localPath,
            fileSize: resumePosition,
            message: 'File already complete'
          };
        }
      }

      // Track download performance
      const downloadStartTime = Date.now();
      let downloadedBytes = resumePosition;
      const chunks = [];

      // Enhanced progress tracking
      const progressTracker = {
        write: (chunk) => {
          chunks.push(chunk);
          downloadedBytes += chunk.length;
          
          if (onProgress && remoteFileSize > 0) {
            const progress = Math.round((downloadedBytes / remoteFileSize) * 100);
            const speed = this.calculateDownloadSpeed(downloadedBytes - resumePosition, Date.now());
            const estimatedTimeRemaining = this.calculateEstimatedTimeRemaining(
              downloadedBytes - resumePosition, 
              remoteFileSize - resumePosition, 
              speed
            );
            
            onProgress(progress, downloadedBytes, remoteFileSize, 
              `Downloading... ${formatSpeed(speed)}${estimatedTimeRemaining ? ` (ETA: ${estimatedTimeRemaining})` : ''}`);
          }
        },
        end: () => {}
      };

      // Perform download
      if (resumePosition > 0) {
        try {
          await ftpClient.ftp.send(`REST ${resumePosition}`);
          await ftpClient.downloadTo(progressTracker, normalizedRemotePath);
          
          // Append to existing file
          const newData = Buffer.concat(chunks);
          await fs.appendFile(localPath, newData);
        } catch (resumeError) {
          console.warn('Resume failed, starting fresh download:', resumeError.message);
          resumePosition = 0;
          downloadedBytes = 0;
          chunks.length = 0;
          await ftpClient.downloadTo(progressTracker, normalizedRemotePath);
          const fileData = Buffer.concat(chunks);
          await fs.writeFile(localPath, fileData);
        }
      } else {
        await ftpClient.downloadTo(progressTracker, normalizedRemotePath);
        const fileData = Buffer.concat(chunks);
        await fs.writeFile(localPath, fileData);
      }

      const downloadTime = Date.now() - downloadStartTime;
      this.downloadStats.averageDownloadTime = 
        (this.downloadStats.averageDownloadTime * (this.downloadStats.totalDownloads - 1) + downloadTime) / 
        this.downloadStats.totalDownloads;

      // Update temp space usage
      if (!this.usedTempSpace) {
        this.usedTempSpace += downloadedBytes;
      }

      console.log(`Enhanced download completed: ${localPath} (${downloadedBytes} bytes, ${downloadTime}ms)`);

      return {
        success: true,
        localPath,
        fileSize: downloadedBytes,
        downloadTime,
        message: 'Enhanced download completed successfully'
      };

    } catch (error) {
      console.error('Enhanced download error:', error);
      throw new Error(`Enhanced download failed: ${error.message}`);
    }
  }

  // Open file with appropriate application
  async openFile(filePath) {
    try {
      const { shell } = require('electron');
      
      console.log(`Opening file: ${filePath}`);
      await shell.openPath(filePath);
      
      return {
        success: true,
        message: 'File opened successfully'
      };
    } catch (error) {
      console.error('Failed to open file:', error);
      throw new Error(`Failed to open file: ${error.message}`);
    }
  }

  // Validate temp file
  async _validateTempFile(filePath, remotePath) {
    try {
      // Check file exists
      const stats = await fs.stat(filePath);
      if (stats.size === 0) return false;

      // Check file age (remove if too old)
      const fileAge = Date.now() - stats.mtime.getTime();
      if (fileAge > this.maxTempFileAge) {
        await fs.unlink(filePath);
        return false;
      }

      // Basic file integrity check
      const buffer = await fs.readFile(filePath);
      if (buffer.length !== stats.size) {
        return false;
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  // Calculate download speed
  calculateDownloadSpeed(bytesDownloaded, currentTime) {
    const startTime = this.downloadStats.lastDownloadStartTime || currentTime;
    const timeElapsed = (currentTime - startTime) / 1000;
    
    if (timeElapsed > 0) {
      this.downloadStats.lastDownloadSpeed = bytesDownloaded / timeElapsed;
      this.downloadStats.lastDownloadStartTime = currentTime;
    }
    
    return this.downloadStats.lastDownloadSpeed || 0;
  }

  // Calculate estimated time remaining
  calculateEstimatedTimeRemaining(downloaded, remaining, currentSpeed) {
    if (currentSpeed <= 0 || remaining <= 0) return null;
    
    const remainingSeconds = remaining / currentSpeed;
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = Math.floor(remainingSeconds % 60);
    
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    } else {
      return `${seconds}s`;
    }
  }

  // Start temporary file cleanup
  startCleanupInterval() {
    if (this.tempFileCleanupInterval) {
      clearInterval(this.tempFileCleanupInterval);
    }
    
    this.tempFileCleanupInterval = setInterval(async () => {
      await this.cleanupTempFiles();
    }, 60 * 60 * 1000); // Run every hour
  }

  // Cancel active download
  async cancelDownload(downloadId) {
    const download = this.activeDownloads.get(downloadId);
    if (download) {
      download.status = 'cancelled';
      this.activeDownloads.delete(downloadId);
      
      // Try to delete partial file
      try {
        await fs.unlink(download.tempFilePath);
      } catch (error) {
        // Ignore errors when cleaning up partial file
      }
      
      return { success: true, message: 'Download cancelled' };
    }
    
    return { success: false, message: 'Download not found' };
  }

  // Get download status
  getDownloadStatus(downloadId) {
    const download = this.activeDownloads.get(downloadId);
    if (download) {
      return {
        ...download,
        elapsed: Date.now() - download.startTime
      };
    }
    return null;
  }

  // Get download statistics
  getDownloadStats() {
    return {
      ...this.downloadStats,
      activeDownloads: this.activeDownloads.size,
      tempDirectory: this.tempDirectory,
      usedTempSpace: this.usedTempSpace,
      tempFileQuota: this.tempFileQuota,
      availableTempSpace: this.tempFileQuota - this.usedTempSpace
    };
  }

  // Clean up all resources
  async cleanup() {
    if (this.tempFileCleanupInterval) {
      clearInterval(this.tempFileCleanupInterval);
    }

    // Cancel all active downloads
    const downloadIds = Array.from(this.activeDownloads.keys());
    for (const downloadId of downloadIds) {
      await this.cancelDownload(downloadId);
    }

    // Clean up all temp files
    if (this.tempDirectory) {
      try {
        const files = await fs.readdir(this.tempDirectory);
        for (const file of files) {
          await fs.unlink(path.join(this.tempDirectory, file));
        }
        this.usedTempSpace = 0;
      } catch (error) {
        console.error('Error during cleanup:', error);
      }
    }

    console.log('Enhanced file downloader cleaned up');
  }
}

// Standalone wrapper functions for enhanced downloader
function getDownloadStatus(downloadId) {
  return enhancedDownloader.getDownloadStatus(downloadId);
}

function getDownloadStats() {
  return enhancedDownloader.getDownloadStats();
}

async function cleanupEnhancedDownloader() {
  return await enhancedDownloader.cleanup();
}

// Performance monitoring and metrics system
class PerformanceMonitor {
  constructor() {
    this.metrics = {
      // General application metrics
      uptime: Date.now(),
      sessionStart: Date.now(),
      
      // FTP connection metrics
      connections: {
        total: 0,
        successful: 0,
        failed: 0,
        averageResponseTime: 0,
        lastConnectionTime: null,
        connectionFailures: []
      },
      
      // Cache performance metrics
      cache: {
        hits: 0,
        misses: 0,
        hitRate: 0,
        averageReadTime: 0,
        averageWriteTime: 0,
        memoryCacheSize: 0,
        diskCacheSize: 0
      },
      
      // Download performance metrics
      downloads: {
        total: 0,
        successful: 0,
        failed: 0,
        averageSpeed: 0,
        averageSize: 0,
        averageTime: 0,
        totalBytes: 0,
        concurrentDownloads: 0
      },
      
      // Lazy loading metrics
      lazyLoading: {
        totalLoads: 0,
        cacheHits: 0,
        cacheMisses: 0,
        averageLoadTime: 0,
        concurrentLoads: 0,
        prefetchHits: 0,
        prefetchMisses: 0
      },
      
      // Background worker metrics
      backgroundWorker: {
        tasksExecuted: 0,
        averageTaskTime: 0,
        smartRefreshCount: 0,
        manualRefreshCount: 0,
        skippedTasks: 0
      }
    };
    
    // Performance thresholds for alerts
    this.thresholds = {
      connectionTime: 5000, // 5 seconds
      downloadSpeed: 1024 * 1024, // 1MB/s
      cacheReadTime: 100, // 100ms
      loadTime: 2000, // 2 secondsc
      taskTime: 1000 // 1 second
    };
    
    // Performance history for trending analysis
    this.history = [];
    this.maxHistorySize = 100;
    
    // Alert system
    this.alerts = [];
    this.maxAlerts = 50;
    
    // Start performance monitoring interval
    this.monitoringInterval = null;
    this.startMonitoring();
  }

  // Record connection attempt
  recordConnection(success, responseTime = 0) {
    this.metrics.connections.total++;
    if (success) {
      this.metrics.connections.successful++;
    } else {
      this.metrics.connections.failed++;
      this.metrics.connections.connectionFailures.push({
        timestamp: Date.now(),
        responseTime
      });
      
      // Keep only recent failures
      if (this.metrics.connections.connectionFailures.length > 20) {
        this.metrics.connections.connectionFailures.shift();
      }
    }
    
    this.metrics.connections.lastConnectionTime = Date.now();
    this.metrics.connections.averageResponseTime = 
      (this.metrics.connections.averageResponseTime * (this.metrics.connections.total - 1) + responseTime) / 
      this.metrics.connections.total;
    
    this.checkPerformanceThresholds('connection', responseTime);
    this.updateHistory();
  }

  // Record cache operation
  recordCacheOperation(type, duration, size = 0) {
    if (type === 'hit') {
      this.metrics.cache.hits++;
    } else {
      this.metrics.cache.misses++;
    }
    
    // Calculate hit rate
    const total = this.metrics.cache.hits + this.metrics.cache.misses;
    this.metrics.cache.hitRate = total > 0 ? (this.metrics.cache.hits / total) * 100 : 0;
    
    // Update average read/write times
    if (type === 'hit') {
      this.metrics.cache.averageReadTime = 
        (this.metrics.cache.averageReadTime * (this.metrics.cache.hits - 1) + duration) / 
        this.metrics.cache.hits;
    }
    
    this.updateHistory();
  }

  // Record download operation
  recordDownload(success, fileSize, duration, speed) {
    this.metrics.downloads.total++;
    if (success) {
      this.metrics.downloads.successful++;
    } else {
      this.metrics.downloads.failed++;
    }
    
    // Update averages
    this.metrics.downloads.averageSpeed = 
      (this.metrics.downloads.averageSpeed * (this.metrics.downloads.total - 1) + speed) / 
      this.metrics.downloads.total;
    
    this.metrics.downloads.averageSize = 
      (this.metrics.downloads.averageSize * (this.metrics.downloads.total - 1) + fileSize) / 
      this.metrics.downloads.total;
    
    this.metrics.downloads.averageTime = 
      (this.metrics.downloads.averageTime * (this.metrics.downloads.total - 1) + duration) / 
      this.metrics.downloads.total;
    
    this.metrics.downloads.totalBytes += fileSize;
    
    this.checkPerformanceThresholds('download', speed);
    this.updateHistory();
  }

  // Record lazy loading operation
  recordLazyLoad(cacheHit, duration, prefetchHit = false) {
    this.metrics.lazyLoading.totalLoads++;
    
    if (cacheHit) {
      this.metrics.lazyLoading.cacheHits++;
    } else {
      this.metrics.lazyLoading.cacheMisses++;
    }
    
    if (prefetchHit) {
      this.metrics.lazyLoading.prefetchHits++;
    } else {
      this.metrics.lazyLoading.prefetchMisses++;
    }
    
    // Calculate average load time
    const totalLoads = this.metrics.lazyLoading.totalLoads;
    this.metrics.lazyLoading.averageLoadTime = 
      (this.metrics.lazyLoading.averageLoadTime * (totalLoads - 1) + duration) / 
      totalLoads;
    
    this.checkPerformanceThresholds('load', duration);
    this.updateHistory();
  }

  // Record background worker task
  recordBackgroundTask(taskType, duration) {
    this.metrics.backgroundWorker.tasksExecuted++;
    
    // Update average task time
    const totalTasks = this.metrics.backgroundWorker.tasksExecuted;
    this.metrics.backgroundWorker.averageTaskTime = 
      (this.metrics.backgroundWorker.averageTaskTime * (totalTasks - 1) + duration) / 
      totalTasks;
    
    if (taskType === 'smart') {
      this.metrics.backgroundWorker.smartRefreshCount++;
    } else if (taskType === 'manual') {
      this.metrics.backgroundWorker.manualRefreshCount++;
    } else if (taskType === 'skipped') {
      this.metrics.backgroundWorker.skippedTasks++;
    }
    
    this.updateHistory();
  }

  // Check performance thresholds and generate alerts
  checkPerformanceThresholds(type, value) {
    const threshold = this.thresholds[type + 'Time'] || this.thresholds[type];
    if (threshold && value > threshold) {
      this.addAlert({
        type: 'performance',
        category: type,
        message: `${type} performance degraded (${value}ms > ${threshold}ms)`,
        severity: 'warning',
        timestamp: Date.now(),
        value,
        threshold
      });
    }
  }

  // Add alert to the system
  addAlert(alert) {
    this.alerts.push(alert);
    
    // Keep only recent alerts
    if (this.alerts.length > this.maxAlerts) {
      this.alerts.shift();
    }
    
    console.warn(`Performance Alert: ${alert.message}`);
  }

  // Update performance history
  updateHistory() {
    const timestamp = Date.now();
    const historyEntry = {
      timestamp,
      uptime: timestamp - this.metrics.uptime,
      connections: { ...this.metrics.connections },
      cache: { ...this.metrics.cache },
      downloads: { ...this.metrics.downloads },
      lazyLoading: { ...this.metrics.lazyLoading },
      backgroundWorker: { ...this.metrics.backgroundWorker }
    };
    
    this.history.push(historyEntry);
    
    // Keep only recent history
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
  }

  // Get current performance metrics
  getMetrics() {
    const uptime = Date.now() - this.metrics.uptime;
    
    return {
      ...this.metrics,
      uptime,
      uptimeFormatted: this.formatUptime(uptime),
      alerts: this.alerts.slice(-10), // Last 10 alerts
      historyTrends: this.calculateTrends(),
      systemHealth: this.calculateSystemHealth()
    };
  }

  // Get performance summary for UI
  getPerformanceSummary() {
    const metrics = this.getMetrics();
    
    return {
      overallScore: this.calculateOverallScore(),
      connectionHealth: this.calculateConnectionHealth(),
      cacheEfficiency: this.metrics.cache.hitRate,
      downloadPerformance: formatSpeed(this.metrics.downloads.averageSpeed),
      lazyLoadingEfficiency: this.calculateLazyLoadingEfficiency(),
      recentAlerts: metrics.alerts.slice(-5),
      recommendations: this.generateRecommendations()
    };
  }

  // Calculate system health score
  calculateSystemHealth() {
    const connectionScore = this.metrics.connections.total > 0 
      ? (this.metrics.connections.successful / this.metrics.connections.total) * 100 
      : 100;
    
    const cacheScore = this.metrics.cache.hitRate;
    const downloadScore = this.metrics.downloads.total > 0 
      ? (this.metrics.downloads.successful / this.metrics.downloads.total) * 100 
      : 100;
    
    return Math.round((connectionScore + cacheScore + downloadScore) / 3);
  }

  // Calculate overall performance score
  calculateOverallScore() {
    const weights = {
      connections: 0.3,
      cache: 0.25,
      downloads: 0.25,
      lazyLoading: 0.2
    };
    
    const connectionScore = this.metrics.connections.total > 0 
      ? (this.metrics.connections.successful / this.metrics.connections.total) * 100 
      : 100;
    
    const cacheScore = this.metrics.cache.hitRate;
    const downloadScore = this.metrics.downloads.total > 0 
      ? (this.metrics.downloads.successful / this.metrics.downloads.total) * 100 
      : 100;
    
    const lazyScore = this.calculateLazyLoadingEfficiency();
    
    return Math.round(
      connectionScore * weights.connections +
      cacheScore * weights.cache +
      downloadScore * weights.downloads +
      lazyScore * weights.lazyLoading
    );
  }

  // Calculate lazy loading efficiency
  calculateLazyLoadingEfficiency() {
    const total = this.metrics.lazyLoading.cacheHits + this.metrics.lazyLoading.cacheMisses;
    if (total === 0) return 100;
    
    return (this.metrics.lazyLoading.cacheHits / total) * 100;
  }

  // Calculate connection health
  calculateConnectionHealth() {
    const total = this.metrics.connections.total;
    if (total === 0) return 'unknown';
    
    const successRate = (this.metrics.connections.successful / total) * 100;
    
    if (successRate >= 95) return 'excellent';
    if (successRate >= 85) return 'good';
    if (successRate >= 70) return 'fair';
    return 'poor';
  }

  // Calculate performance trends
  calculateTrends() {
    if (this.history.length < 2) return {};
    
    const recent = this.history.slice(-10);
    const older = this.history.slice(-20, -10);
    
    return {
      connectionTime: this.calculateTrend(recent, older, 'connections', 'averageResponseTime'),
      cacheHitRate: this.calculateTrend(recent, older, 'cache', 'hitRate'),
      downloadSpeed: this.calculateTrend(recent, older, 'downloads', 'averageSpeed'),
      loadTime: this.calculateTrend(recent, older, 'lazyLoading', 'averageLoadTime')
    };
  }

  // Calculate individual metric trend
  calculateTrend(recent, older, category, metric) {
    if (!older || older.length === 0) return 'stable';
    
    const recentValue = recent[recent.length - 1][category][metric];
    const olderValue = older[older.length - 1][category][metric];
    
    const change = ((recentValue - olderValue) / olderValue) * 100;
    
    if (Math.abs(change) < 5) return 'stable';
    if (change > 5) return 'improving';
    if (change < -5) return 'declining';
    return 'stable';
  }

  // Generate performance recommendations
  generateRecommendations() {
    const recommendations = [];
    
    // Connection recommendations
    if (this.metrics.connections.averageResponseTime > this.thresholds.connectionTime) {
      recommendations.push({
        type: 'connection',
        priority: 'high',
        message: 'Consider increasing connection pool size or optimizing network settings'
      });
    }
    
    // Cache recommendations
    if (this.metrics.cache.hitRate < 70) {
      recommendations.push({
        type: 'cache',
        priority: 'medium',
        message: 'Cache hit rate is low - consider increasing memory cache size'
      });
    }
    
    // Download recommendations
    if (this.metrics.downloads.averageSpeed < this.thresholds.downloadSpeed) {
      recommendations.push({
        type: 'download',
        priority: 'medium',
        message: 'Download speed is below recommended threshold'
      });
    }
    
    // Lazy loading recommendations
    if (this.metrics.lazyLoading.averageLoadTime > this.thresholds.loadTime) {
      recommendations.push({
        type: 'lazy-loading',
        priority: 'medium',
        message: 'Directory loading time is high - consider optimizing prefetching'
      });
    }
    
    return recommendations;
  }

  // Start performance monitoring
  startMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    this.monitoringInterval = setInterval(() => {
      this.updateHistory();
      
      // Check for system health degradation
      const health = this.calculateSystemHealth();
      if (health < 70) {
        this.addAlert({
          type: 'health',
          category: 'system',
          message: `System health degraded to ${health}%`,
          severity: 'warning',
          timestamp: Date.now(),
          health
        });
      }
    }, 60000); // Check every minute
  }

  // Stop performance monitoring
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }

  // Format uptime for display
  formatUptime(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
      return `${days}d ${hours % 24}h ${minutes % 60}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}

// Global performance monitor instance
const performanceMonitor = new PerformanceMonitor();

// Wrapper functions for performance monitoring
function getPerformanceMetrics() {
  return performanceMonitor.getMetrics();
}

function getPerformanceSummary() {
  return performanceMonitor.getPerformanceSummary();
}

function getPerformanceAlerts() {
  return performanceMonitor.alerts;
}

function clearPerformanceAlerts() {
  performanceMonitor.alerts = [];
  return { success: true, message: 'Performance alerts cleared' };
}

function generatePerformanceReport() {
  const metrics = getPerformanceMetrics();
  const summary = getPerformanceSummary();
  
  return {
    reportGenerated: Date.now(),
    metrics,
    summary,
    recommendations: summary.recommendations,
    systemHealth: summary.overallScore,
    uptime: metrics.uptimeFormatted
  };
}

// Global enhanced downloader instance
const enhancedDownloader = new EnhancedFileDownloader();

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
    
    // Enhanced memory-based cache layer with multiple cache strategies
    this.memoryCache = new Map(); // LFU cache for hot data
    this.accessFrequency = new Map(); // Track access frequency
    this.accessRecency = new Map(); // Track recent access for hybrid strategy
    this.maxMemoryCacheSize = 400; // Increased memory cache size
    this.memoryHitCount = 0;
    this.memoryCacheRequests = 0;
    
    // Performance optimization constants
    this.LOAD_TIMEOUT = 8000; // 8 seconds timeout for directory loading
    this.PREFETCH_BATCH_SIZE = 5; // Number of directories to prefetch at once
    this.PREFETCH_DELAY = 300; // Reduced delay for faster prefetching
    this.CACHE_PROMOTION_THRESHOLD = 3; // Access count to promote to memory cache
    
    // Load prioritization system
    this.loadPriorityQueue = new Map(); // Track load priorities
    this.directorySizeEstimates = new Map(); // Track estimated directory sizes
    this.lastAccessTimes = new Map(); // Track last access times
    
    // Adaptive prefetching
    this.adaptivePrefetchEnabled = true;
    this.userBehaviorLearning = true;
    this.learningData = {
      navigationPatterns: new Map(),
      accessHeatmap: new Map(),
      predictionAccuracy: 0
    };
  }

  // Load directory only when requested (like Windows Explorer)
  async loadDirectoryOnDemand(dirPath, options = {}) {
    const { forceRefresh = false, priority = 'normal', usePooled = false } = options;
    
    // Update learning data for user behavior
    if (this.userBehaviorLearning) {
      this._updateLearningData(dirPath);
    }
    
    // Check if already loading
    if (this.loadingQueue.has(dirPath)) {
      // Update priority for concurrent load
      if (priority === 'high') {
        this.loadPriorityQueue.set(dirPath, priority);
      }
      return await this.loadingQueue.get(dirPath);
    }

    // Check memory cache first (fastest)
    if (!forceRefresh) {
      const memoryData = this.getFromMemoryCache(dirPath);
      if (memoryData) {
        this._updateAccessMetrics(dirPath, 'memory');
        // Trigger intelligent prefetching based on user behavior
        this._intelligentPrefetch(dirPath);
        return memoryData.data;
      }
    }

    // Check disk cache second (with adaptive TTL)
    if (!forceRefresh) {
      const cached = this.getFromDirectoryCache(dirPath);
      if (cached) {
        console.log(`Using disk cached data for directory: ${dirPath}`);
        
        // Store in memory cache if frequently accessed
        if (this._shouldCacheInMemory(dirPath)) {
          this.setMemoryCache(dirPath, cached);
        }
        
        // Trigger intelligent prefetching based on cached content
        this._intelligentPrefetch(dirPath, cached);
        return cached;
      }
    }

    // Create loading promise
    const loadPromise = this._loadSingleDirectory(dirPath, priority, usePooled);
    this.loadingQueue.set(dirPath, loadPromise);

    try {
      const result = await loadPromise;
      
      // Store in disk cache
      this.setDirectoryCache(dirPath, result);
      
      // Store in memory cache if it should be cached
      if (this._shouldCacheInMemory(dirPath)) {
        this.setMemoryCache(dirPath, result);
      }
      
      // Trigger immediate prefetching for adjacent directories after successful load
      this._immediatePrefetch(dirPath);
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
    const previousVisible = new Set(this.visibleDirectories);
    this.visibleDirectories.clear();
    directories.forEach(dir => this.visibleDirectories.add(dir));
    
    // Promote newly visible directories from disk cache to memory cache
    directories.forEach(dir => {
      if (!previousVisible.has(dir)) {
        const diskCacheData = this.getFromDirectoryCache(dir);
        if (diskCacheData && this._shouldCacheInMemory(dir)) {
          this.setMemoryCache(dir, diskCacheData);
          console.log(`[LazyLoader] Promoted ${dir} to memory cache`);
        }
      }
    });
    
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
    }, 500); // Reduced delay for more aggressive prefetching
  }

  // Aggressive prefetching of adjacent and child directories
  async _prefetchAdjacentDirectories() {
    const adjacentDirs = new Set();
    const childDirs = new Set();
    
    // Find parent, sibling, and child directories
    this.visibleDirectories.forEach(dirPath => {
      const parentPath = path.posix.dirname(dirPath);
      if (parentPath !== dirPath && parentPath !== '.') {
        adjacentDirs.add(parentPath);
      }
      
      // Add potential child directories from cache
      const cachedData = this.getFromDirectoryCache(dirPath);
      if (cachedData && cachedData.children) {
        cachedData.children.forEach(child => {
          if (child.type === 'directory') {
            const childPath = path.posix.join(dirPath, child.name);
            childDirs.add(childPath);
          }
        });
      }
    });

    // Prefetch adjacent directories with medium priority
    const adjacentPromises = Array.from(adjacentDirs).map(async (dirPath) => {
      if (!this.visibleDirectories.has(dirPath) && !this.loadingQueue.has(dirPath)) {
        try {
          await this.loadDirectoryOnDemand(dirPath, { priority: 'medium' });
          console.log(`Prefetched adjacent: ${dirPath}`);
        } catch (error) {
          console.warn(`Adjacent prefetch failed for ${dirPath}:`, error.message);
        }
      }
    });

    // Prefetch child directories with low priority
    const childPromises = Array.from(childDirs).slice(0, 5).map(async (dirPath) => {
      if (!this.visibleDirectories.has(dirPath) && !this.loadingQueue.has(dirPath)) {
        try {
          await this.loadDirectoryOnDemand(dirPath, { priority: 'prefetch' });
          console.log(`Prefetched child: ${dirPath}`);
        } catch (error) {
          console.warn(`Child prefetch failed for ${dirPath}:`, error.message);
        }
      }
    });

    await Promise.allSettled([...adjacentPromises, ...childPromises]);
  }

  // Immediate prefetching when user navigates to a directory
  async _immediatePrefetch(dirPath) {
    const cachedData = this.getFromDirectoryCache(dirPath);
    if (cachedData && cachedData.children) {
      const childDirectories = cachedData.children
        .filter(child => child.type === 'directory')
        .slice(0, 3) // Limit to first 3 child directories
        .map(child => path.posix.join(dirPath, child.name));

      const prefetchPromises = childDirectories.map(async (childPath) => {
        if (!this.loadingQueue.has(childPath)) {
          try {
            await this.loadDirectoryOnDemand(childPath, { priority: 'medium' });
            console.log(`Immediately prefetched: ${childPath}`);
          } catch (error) {
            console.warn(`Immediate prefetch failed for ${childPath}:`, error.message);
          }
        }
      });

      Promise.allSettled(prefetchPromises); // Don't await, run in background
    }
  }

  // Intelligent prefetching based on user behavior patterns
  async _intelligentPrefetch(dirPath, cachedData = null) {
    if (!this.adaptivePrefetchEnabled) return;

    try {
      // Get predicted directories based on user behavior
      const predictedDirs = this._predictNextDirectories(dirPath, cachedData);
      
      // Batch prefetch with priority
      const batchSize = Math.min(this.PREFETCH_BATCH_SIZE, predictedDirs.length);
      const topPredictions = predictedDirs.slice(0, batchSize);

      const prefetchPromises = topPredictions.map(async (predPath) => {
        if (!this.visibleDirectories.has(predPath) && 
            !this.loadingQueue.has(predPath) && 
            !this.memoryCache.has(predPath)) {
          try {
            await this.loadDirectoryOnDemand(predPath, { 
              priority: 'prefetch',
              usePooled: true 
            });
            console.log(`Intelligently prefetched: ${predPath}`);
          } catch (error) {
            console.warn(`Intelligent prefetch failed for ${predPath}:`, error.message);
          }
        }
      });

      // Run prefetching with controlled concurrency
      const results = await Promise.allSettled(prefetchPromises);
      const successCount = results.filter(r => r.status === 'fulfilled').length;
      
      if (successCount > 0) {
        console.log(`Intelligent prefetch completed: ${successCount}/${batchSize} directories`);
      }
    } catch (error) {
      console.warn('Intelligent prefetch failed:', error.message);
    }
  }

  // Predict next directories based on user behavior
  _predictNextDirectories(currentPath, cachedData = null) {
    const predictions = new Set();
    
    // Add navigation pattern predictions
    const patterns = this.learningData.navigationPatterns.get(currentPath);
    if (patterns && patterns.nextPaths) {
      patterns.nextPaths.forEach(path => predictions.add(path));
    }

    // Add heatmap-based predictions
    const heatmap = this.learningData.accessHeatmap.get(currentPath);
    if (heatmap && heatmap.frequentNeighbors) {
      heatmap.frequentNeighbors.forEach(path => predictions.add(path));
    }

    // Add directory-based predictions from cache
    if (cachedData && cachedData.directories) {
      cachedData.directories.slice(0, 3).forEach(dir => {
        const childPath = path.posix.join(currentPath, dir.name);
        predictions.add(childPath);
      });
    }

    // Add parent and sibling predictions
    const parentPath = path.posix.dirname(currentPath);
    if (parentPath !== '.' && parentPath !== currentPath) {
      predictions.add(parentPath);
    }

    return Array.from(predictions).slice(0, 8); // Limit predictions
  }

  // Update learning data for user behavior
  _updateLearningData(dirPath) {
    // Update access frequency and recency
    const currentFreq = this.accessFrequency.get(dirPath) || 0;
    this.accessFrequency.set(dirPath, currentFreq + 1);
    
    this.accessRecency.set(dirPath, Date.now());
    this.lastAccessTimes.set(dirPath, Date.now());

    // Update navigation patterns
    const visibleArray = Array.from(this.visibleDirectories);
    const currentIndex = visibleArray.indexOf(dirPath);
    if (currentIndex !== -1) {
      // Learn navigation sequence
      if (!this.learningData.navigationPatterns.has(dirPath)) {
        this.learningData.navigationPatterns.set(dirPath, {
          nextPaths: new Set(),
          previousPaths: new Set(),
          accessCount: 0
        });
      }

      const patterns = this.learningData.navigationPatterns.get(dirPath);
      patterns.accessCount++;

      // Learn next paths
      if (currentIndex < visibleArray.length - 1) {
        const nextPath = visibleArray[currentIndex + 1];
        patterns.nextPaths.add(nextPath);
      }

      // Learn previous paths
      if (currentIndex > 0) {
        const prevPath = visibleArray[currentIndex - 1];
        patterns.previousPaths.add(prevPath);
      }
    }

    // Update access heatmap
    const parentPath = path.posix.dirname(dirPath);
    if (parentPath !== '.' && parentPath !== dirPath) {
      if (!this.learningData.accessHeatmap.has(parentPath)) {
        this.learningData.accessHeatmap.set(parentPath, {
          childAccessCount: new Map(),
          totalAccess: 0
        });
      }

      const heatmap = this.learningData.accessHeatmap.get(parentPath);
      const childCount = heatmap.childAccessCount.get(dirPath) || 0;
      heatmap.childAccessCount.set(dirPath, childCount + 1);
      heatmap.totalAccess++;
    }

    // Update prediction accuracy
    this._updatePredictionAccuracy();
  }

  // Update prediction accuracy metrics
  _updatePredictionAccuracy() {
    // This is a simplified accuracy calculation
    // In a production system, you'd track successful predictions
    const totalPatterns = Array.from(this.learningData.navigationPatterns.values())
      .reduce((sum, p) => sum + p.nextPaths.size, 0);
    
    if (totalPatterns > 0) {
      this.learningData.predictionAccuracy = Math.min(0.8, totalPatterns * 0.1);
    }
  }

  // Update access metrics for cache performance
  _updateAccessMetrics(dirPath, cacheType) {
    if (cacheType === 'memory') {
      this.memoryHitCount++;
    }
    this.memoryCacheRequests++;
  }

  // Enhanced cache promotion logic
  _shouldCacheInMemory(dirPath) {
    const freq = this.accessFrequency.get(dirPath) || 0;
    const recentAccess = this.lastAccessTimes.get(dirPath) || 0;
    const timeSinceAccess = Date.now() - recentAccess;

    // Promote to memory cache if:
    // 1. Frequently accessed (meets threshold)
    // 2. Recently accessed (within last 5 minutes)
    // 3. Frequently accessed parent directories
    const meetsFrequencyThreshold = freq >= this.CACHE_PROMOTION_THRESHOLD;
    const isRecentAccess = timeSinceAccess < 5 * 60 * 1000; // 5 minutes
    const hasFrequentParent = this._hasFrequentParentDirectory(dirPath);

    return meetsFrequencyThreshold || isRecentAccess || hasFrequentParent;
  }

  // Check if parent directory is frequently accessed
  _hasFrequentParentDirectory(dirPath) {
    const parentPath = path.posix.dirname(dirPath);
    if (parentPath === '.' || parentPath === dirPath) return false;

    const parentFreq = this.accessFrequency.get(parentPath) || 0;
    return parentFreq >= this.CACHE_PROMOTION_THRESHOLD;
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
    const baseTTL = 2 * 60 * 1000; // 2 minutes base (optimized for responsiveness)
    const maxTTL = 60 * 60 * 1000; // 60 minutes max (increased for better caching)
    
    // Frequently accessed directories get longer TTL
    if (this.visibleDirectories.has(dirPath)) {
      return maxTTL;
    }
    
    return baseTTL;
  }

  // Clear cache for specific directory
  clearDirectoryCache(dirPath) {
    this.directoryCache.delete(dirPath);
    // Also clear from memory cache for consistency
    this.clearMemoryCache(dirPath);
  }

  // Memory cache management methods
  getFromMemoryCache(dirPath) {
    this.memoryCacheRequests++;
    
    if (this.memoryCache.has(dirPath)) {
      this.memoryHitCount++;
      // Move to end (most recently used)
      const data = this.memoryCache.get(dirPath);
      this.memoryCache.delete(dirPath);
      this.memoryCache.set(dirPath, data);
      
      // Update access frequency
      this.accessFrequency.set(dirPath, (this.accessFrequency.get(dirPath) || 0) + 1);
      
      console.log(`Memory cache hit for: ${dirPath}`);
      return data;
    }
    
    return null;
  }
  
  setMemoryCache(dirPath, data) {
    // Check if we need to evict old entries
    if (this.memoryCache.size >= this.maxMemoryCacheSize && !this.memoryCache.has(dirPath)) {
      // Remove least recently used (first entry)
      const firstKey = this.memoryCache.keys().next().value;
      this.memoryCache.delete(firstKey);
      this.accessFrequency.delete(firstKey);
      console.log(`Evicted from memory cache: ${firstKey}`);
    }
    
    // Add/update entry (will be at the end = most recently used)
    this.memoryCache.set(dirPath, {
      data: data,
      timestamp: Date.now(),
      size: this._estimateDataSize(data)
    });
    
    // Initialize access frequency
    if (!this.accessFrequency.has(dirPath)) {
      this.accessFrequency.set(dirPath, 1);
    }
    
    console.log(`Added to memory cache: ${dirPath} (${this.memoryCache.size}/${this.maxMemoryCacheSize})`);
  }
  
  clearMemoryCache(dirPath = null) {
    if (dirPath) {
      this.memoryCache.delete(dirPath);
      this.accessFrequency.delete(dirPath);
    } else {
      this.memoryCache.clear();
      this.accessFrequency.clear();
      this.memoryHitCount = 0;
      this.memoryCacheRequests = 0;
    }
  }
  
  _estimateDataSize(data) {
    // Rough estimation of data size in bytes
    if (!data || !data.children) return 100;
    return data.children.length * 200; // Approximate 200 bytes per file entry
  }
  
  _shouldCacheInMemory(dirPath) {
    // Cache in memory if:
    // 1. Directory is visible (currently being viewed)
    // 2. Has been accessed multiple times
    // 3. Is a frequently accessed parent directory
    const accessCount = this.accessFrequency.get(dirPath) || 0;
    const isVisible = this.visibleDirectories.has(dirPath);
    const isFrequentlyAccessed = accessCount >= 2;
    
    return isVisible || isFrequentlyAccessed;
  }

  // Get cache statistics
  getCacheStats() {
    const memoryHitRate = this.memoryCacheRequests > 0 ? 
      (this.memoryHitCount / this.memoryCacheRequests * 100).toFixed(2) : 0;
    
    return {
      cachedDirectories: this.directoryCache.size,
      visibleDirectories: this.visibleDirectories.size,
      loadingQueue: this.loadingQueue.size,
      prefetchQueue: this.prefetchQueue.size,
      memoryCacheSize: this.memoryCache.size,
      memoryHitRate: `${memoryHitRate}%`,
      memoryHits: this.memoryHitCount,
      memoryCacheRequests: this.memoryCacheRequests
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
    this.refreshInterval = 12000; // 12 seconds default (optimized from 30s)
    this.baseRefreshInterval = 12000; // Base interval for calculation
    this.maxRefreshInterval = 60000; // Maximum interval when idle
    this.monitoredDirectories = new Set();
    this.lastActivity = Date.now();
    
    // Smart refresh settings
    this.smartRefreshEnabled = true;
    this.manualRefreshTriggered = false;
    this.lastManualRefresh = 0;
    this.autoRefreshThreshold = 30000; // 30 seconds of inactivity before auto refresh
    this.userActionRefreshCount = 0;
    this.userActionRefreshLimit = 5; // Max consecutive auto refreshes
  }

  // Start background monitoring
  start(refreshInterval = 15000, enableSmartRefresh = true) {
    if (this.isRunning) {
      console.log('Background worker already running');
      return;
    }

    this.refreshInterval = refreshInterval;
    this.smartRefreshEnabled = enableSmartRefresh;
    this.isRunning = true;
    
    console.log(`Starting background directory worker (refresh every ${refreshInterval}ms, smart refresh: ${enableSmartRefresh})`);
    
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
    this.userActionRefreshCount = 0; // Reset counter on user action
  }

  // Trigger manual refresh (user-initiated)
  triggerManualRefresh() {
    this.manualRefreshTriggered = true;
    this.lastManualRefresh = Date.now();
    console.log('Manual refresh triggered by user');
  }

  // Check if smart refresh should run
  shouldRunSmartRefresh() {
    if (!this.smartRefreshEnabled) {
      return false;
    }

    // Always run manual refresh immediately
    if (this.manualRefreshTriggered) {
      this.manualRefreshTriggered = false;
      return true;
    }

    // Only run auto refresh if user has been inactive for threshold
    const inactiveTime = Date.now() - this.lastActivity;
    if (inactiveTime < this.autoRefreshThreshold) {
      return false;
    }

    // Limit consecutive auto refreshes
    if (this.userActionRefreshCount >= this.userActionRefreshLimit) {
      console.log('Auto refresh limit reached, waiting for user action');
      return false;
    }

    return true;
  }

  // Increment user action refresh counter
  incrementAutoRefreshCount() {
    if (this.userActionRefreshCount < this.userActionRefreshLimit) {
      this.userActionRefreshCount++;
    }
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

      // Only perform smart refresh when appropriate
      if (!this.shouldRunSmartRefresh()) {
        console.log('Smart refresh conditions not met, skipping background tasks');
        return;
      }

      console.log('Performing smart background refresh');

      // Refresh visible directories first (high priority)
      if (lazyLoader.visibleDirectories.size > 0) {
        await this._smartRefreshVisibleDirectories();
      }

      // Refresh monitored directories (medium priority)
      if (this.monitoredDirectories.size > 0) {
        await this._refreshMonitoredDirectories();
      }

      // Warm up connection pool during idle time (medium priority)
      await this._warmUpConnectionPool();

      // Cleanup old cache entries (low priority)
      await this._cleanupOldCacheEntries();

      // Increment auto refresh counter
      this.incrementAutoRefreshCount();

    } catch (error) {
      console.warn('Background worker task failed:', error.message);
    }
  }

  // Smart refresh visible directories with user-initiated priority
  async _smartRefreshVisibleDirectories() {
    const refreshPromises = Array.from(this.visibleDirectories).map(async (dirPath) => {
      try {
        // Use force refresh only for manual refreshes
        const shouldForceRefresh = this.manualRefreshTriggered;
        await lazyLoader.loadDirectoryOnDemand(dirPath, { 
          forceRefresh: shouldForceRefresh, 
          priority: 'background-smart',
          usePooled: true
        });
        
        if (shouldForceRefresh) {
          console.log(`Manual smart refreshed: ${dirPath}`);
        } else {
          console.log(`Auto smart refreshed: ${dirPath}`);
        }
      } catch (error) {
        console.warn(`Smart refresh failed for ${dirPath}:`, error.message);
      }
    });

    await Promise.allSettled(refreshPromises);
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
        // Also clean from memory cache
        lazyLoader.clearMemoryCache(dirPath);
      });
      
      console.log(`Cleaned up ${toRemove.length} old cache entries`);
    }
    
    // Also cleanup memory cache if it's getting too large
    if (lazyLoader.memoryCache.size > lazyLoader.maxMemoryCacheSize) {
      const memoryEntries = Array.from(lazyLoader.memoryCache.entries());
      // Sort by access frequency (least accessed first)
      memoryEntries.sort((a, b) => {
        const freqA = lazyLoader.accessFrequency.get(a[0]) || 0;
        const freqB = lazyLoader.accessFrequency.get(b[0]) || 0;
        return freqA - freqB;
      });
      
      const memoryToRemove = memoryEntries.slice(0, memoryEntries.length - lazyLoader.maxMemoryCacheSize);
      memoryToRemove.forEach(([dirPath]) => {
        lazyLoader.clearMemoryCache(dirPath);
      });
      
      console.log(`Cleaned up ${memoryToRemove.length} memory cache entries`);
    }
  }

  // Warm up connection pool during idle time
  async _warmUpConnectionPool() {
    try {
      // Only warm up if user is inactive for more than 30 seconds
      const inactiveTime = Date.now() - this.lastActivity;
      if (inactiveTime > 30000) {
        console.log('Warming up connection pool during idle time');
        await connectionPool.warmUp(2);
      }
    } catch (error) {
      console.warn('Connection pool warm-up failed:', error.message);
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
function startBackgroundWorker(refreshInterval = 15000, enableSmartRefresh = true) {
  backgroundWorker.start(refreshInterval, enableSmartRefresh);
}

function stopBackgroundWorker() {
  backgroundWorker.stop();
}

// Manual refresh function for user-triggered refreshes
function triggerManualRefresh() {
  if (backgroundWorker.isRunning) {
    backgroundWorker.triggerManualRefresh();
    backgroundWorker.updateActivity(); // Update activity timestamp
    return { success: true, message: 'Manual refresh triggered' };
  }
  return { success: false, message: 'Background worker not running' };
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

// Enhanced lazy loading utility functions
function getIntelligentPrefetchStats() {
  return {
    adaptivePrefetchEnabled: lazyLoader.adaptivePrefetchEnabled,
    predictionAccuracy: lazyLoader.learningData.predictionAccuracy,
    prefetchQueueSize: lazyLoader.prefetchQueue.size,
    memoryCacheHitRate: lazyLoader.memoryCacheRequests > 0 
      ? (lazyLoader.memoryHitCount / lazyLoader.memoryCacheRequests).toFixed(3)
      : 0,
    learningData: lazyLoader.learningData
  };
}

function enableAdaptivePrefetch() {
  lazyLoader.adaptivePrefetchEnabled = true;
  lazyLoader.userBehaviorLearning = true;
  return { success: true, message: 'Adaptive prefetch enabled' };
}

function disableAdaptivePrefetch() {
  lazyLoader.adaptivePrefetchEnabled = false;
  lazyLoader.userBehaviorLearning = false;
  return { success: true, message: 'Adaptive prefetch disabled' };
}

function getUserBehaviorData() {
  return {
    navigationPatterns: Array.from(lazyLoader.learningData.navigationPatterns.entries()),
    accessHeatmap: Array.from(lazyLoader.learningData.accessHeatmap.entries()),
    accessFrequency: Array.from(lazyLoader.accessFrequency.entries()),
    accessRecency: Array.from(lazyLoader.accessRecency.entries())
  };
}

function getCachePerformanceMetrics() {
  return {
    memoryCacheSize: lazyLoader.memoryCache.size,
    maxMemoryCacheSize: lazyLoader.maxMemoryCacheSize,
    directoryCacheSize: lazyLoader.directoryCache.size,
    memoryHitRate: lazyLoader.memoryCacheRequests > 0 
      ? (lazyLoader.memoryHitCount / lazyLoader.memoryCacheRequests).toFixed(3)
      : 0,
    totalRequests: lazyLoader.memoryCacheRequests,
    promotedToMemoryCache: Array.from(lazyLoader.accessFrequency.entries())
      .filter(([_, count]) => count >= lazyLoader.CACHE_PROMOTION_THRESHOLD).length,
    averageDirectoryLoadTime: lazyLoader.getAverageLoadTime ? lazyLoader.getAverageLoadTime() : 0
  };
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
  // Enhanced Lazy Loading Functions
  getIntelligentPrefetchStats,
  enableAdaptivePrefetch,
  disableAdaptivePrefetch,
  getUserBehaviorData,
  getCachePerformanceMetrics,
  // Background Worker Functions
  startBackgroundWorker,
  stopBackgroundWorker,
  triggerManualRefresh,
  addMonitoredDirectory,
  removeMonitoredDirectory,
  updateWorkerActivity,
  getBackgroundWorkerStats,
  // Enhanced File Download Functions
  downloadFileToTemp: (remotePath, options = {}) => enhancedDownloader.downloadFileToTemp(remotePath, options),
  openFile: (filePath) => enhancedDownloader.openFile(filePath),
  cancelFileDownload: (downloadId) => enhancedDownloader.cancelFileDownload(downloadId),
  getDownloadStatus: (downloadId) => enhancedDownloader.getDownloadStatus(downloadId),
  getDownloadStats: () => enhancedDownloader.getDownloadStats(),
  initEnhancedDownloader: () => enhancedDownloader.initEnhancedDownloader(),
  cleanupEnhancedDownloader: () => enhancedDownloader.cleanupEnhancedDownloader(),
  // Performance Monitoring Functions
  getPerformanceMetrics,
  getPerformanceSummary,
  getPerformanceAlerts,
  clearPerformanceAlerts,
  generatePerformanceReport
};