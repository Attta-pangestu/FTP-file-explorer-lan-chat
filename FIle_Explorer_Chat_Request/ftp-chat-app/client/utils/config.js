const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { Client } = require('basic-ftp');
const { io } = require('socket.io-client');

// Encryption settings
const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_KEY_LENGTH = 32;
const IV_LENGTH = 16;

// Get encryption key from environment or generate one
function getEncryptionKey() {
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey && envKey.length === 64) { // 32 bytes in hex
    return Buffer.from(envKey, 'hex');
  }
  
  // Generate a key based on app name and version (consistent across runs)
  const appData = `${app.getName()}-${app.getVersion()}-encryption-salt`;
  return crypto.pbkdf2Sync(appData, 'ftp-chat-salt', 10000, ENCRYPTION_KEY_LENGTH, 'sha512');
}

// Encrypt sensitive data
function encrypt(text) {
  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return {
      encrypted,
      iv: iv.toString('hex')
    };
  } catch (error) {
    console.error('Encryption error:', error);
    throw new Error('Failed to encrypt data');
  }
}

// Decrypt sensitive data
function decrypt(encryptedData) {
  try {
    const key = getEncryptionKey();
    const iv = Buffer.from(encryptedData.iv, 'hex');
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    
    let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error);
    throw new Error('Failed to decrypt data - config may be corrupted');
  }
}

// Get config file path
function getConfigPath() {
  // First check if there's a config.json in the project root
  const projectConfigPath = path.join(__dirname, '..', '..', 'config.json');
  try {
    if (require('fs').existsSync(projectConfigPath)) {
      return projectConfigPath;
    }
  } catch (error) {
    // Ignore error and fall back to userData path
  }
  
  // Fall back to userData directory
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'config.json');
}

// Default configuration
function getDefaultConfig() {
  return {
    ftp: {
      host: '',
      port: 21,
      username: '',
      password: '', // Will be encrypted
      secure: false
    },
    chat: {
      serverUrl: 'ws://localhost:3000',
      username: ''
    },
    app: {
      theme: 'light',
      autoConnect: false,
      tempDir: ''
    },
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// Read configuration from file
async function getConfig() {
  try {
    const configPath = getConfigPath();
    
    // Check if config file exists
    try {
      await fs.access(configPath);
    } catch (error) {
      // Config file doesn't exist, return default config
      console.log('Config file not found, returning default config');
      return getDefaultConfig();
    }
    
    // Read and parse config file
    const configData = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configData);
    
    // Decrypt password if it exists and is encrypted
    if (config.ftp && config.ftp.password && typeof config.ftp.password === 'object') {
      try {
        config.ftp.password = decrypt(config.ftp.password);
      } catch (error) {
        console.error('Failed to decrypt FTP password:', error);
        config.ftp.password = '';
      }
    }
    
    // Merge with default config to ensure all properties exist
    const defaultConfig = getDefaultConfig();
    const mergedConfig = {
      ...defaultConfig,
      ...config,
      ftp: { ...defaultConfig.ftp, ...config.ftp },
      chat: { ...defaultConfig.chat, ...config.chat },
      app: { ...defaultConfig.app, ...config.app }
    };
    
    return mergedConfig;
    
  } catch (error) {
    console.error('Error reading config:', error);
    return getDefaultConfig();
  }
}

// Save configuration to file
async function saveConfig(newConfig) {
  try {
    const configPath = getConfigPath();
    const currentConfig = await getConfig();
    
    // Merge new config with current config
    const updatedConfig = {
      ...currentConfig,
      ...newConfig,
      ftp: { ...currentConfig.ftp, ...(newConfig.ftp || {}) },
      chat: { ...currentConfig.chat, ...(newConfig.chat || {}) },
      app: { ...currentConfig.app, ...(newConfig.app || {}) },
      updatedAt: new Date().toISOString()
    };
    
    // Encrypt FTP password before saving
    if (updatedConfig.ftp.password && typeof updatedConfig.ftp.password === 'string') {
      updatedConfig.ftp.password = encrypt(updatedConfig.ftp.password);
    }
    
    // Ensure user data directory exists
    const userDataPath = path.dirname(configPath);
    try {
      await fs.mkdir(userDataPath, { recursive: true });
    } catch (error) {
      // Directory might already exist
    }
    
    // Write config file
    await fs.writeFile(configPath, JSON.stringify(updatedConfig, null, 2), 'utf8');
    
    console.log('Configuration saved successfully');
    return true;
    
  } catch (error) {
    console.error('Error saving config:', error);
    throw new Error(`Failed to save configuration: ${error.message}`);
  }
}

// Validate FTP configuration by attempting connection
async function validateFTP(ftpConfig) {
  return new Promise((resolve, reject) => {
    let client;
    const timeout = setTimeout(() => {
      if (client) {
        client.close();
      }
      reject(new Error('FTP connection timeout'));
    }, 10000); // 10 second timeout
    
    async function testConnection() {
      try {
        client = new Client();
        
        // Set up error handling
        client.ftp.socket.on('error', (error) => {
          clearTimeout(timeout);
          reject(new Error(`FTP connection failed: ${error.message}`));
        });
        
        // Connect to FTP server
        await client.access({
          host: ftpConfig.host,
          port: ftpConfig.port || 21,
          user: ftpConfig.username,
          password: ftpConfig.password,
          secure: ftpConfig.secure || false
        });
        
        // Test basic operations
        const list = await client.list('/');
        
        clearTimeout(timeout);
        client.close();
        
        resolve({
          success: true,
          message: 'FTP connection successful',
          rootFiles: list.length
        });
        
      } catch (error) {
        clearTimeout(timeout);
        if (client) {
          client.close();
        }
        reject(new Error(`FTP validation failed: ${error.message}`));
      }
    }
    
    testConnection();
  });
}

// Validate Chat configuration by attempting connection
async function validateChat(chatConfig) {
  return new Promise((resolve, reject) => {
    let socket;
    const timeout = setTimeout(() => {
      if (socket) {
        socket.disconnect();
      }
      reject(new Error('Chat server connection timeout'));
    }, 5000); // 5 second timeout
    
    try {
      socket = io(chatConfig.serverUrl, {
        transports: ['websocket'],
        timeout: 5000,
        autoConnect: false
      });
      
      socket.on('connect', () => {
        clearTimeout(timeout);
        socket.disconnect();
        resolve({
          success: true,
          message: 'Chat server connection successful'
        });
      });
      
      socket.on('connect_error', (error) => {
        clearTimeout(timeout);
        socket.disconnect();
        reject(new Error(`Chat server connection failed: ${error.message}`));
      });
      
      socket.on('error', (error) => {
        clearTimeout(timeout);
        socket.disconnect();
        reject(new Error(`Chat server error: ${error.message || 'Unknown error'}`));
      });
      
      // Attempt connection
      socket.connect();
      
    } catch (error) {
      clearTimeout(timeout);
      if (socket) {
        socket.disconnect();
      }
      reject(new Error(`Chat validation failed: ${error.message}`));
    }
  });
}

// Check if configuration is complete and valid
async function isConfigurationValid() {
  try {
    const config = await getConfig();
    
    // Check FTP configuration
    const ftpValid = config.ftp.host && 
                    config.ftp.username && 
                    config.ftp.password;
    
    // Check Chat configuration
    const chatValid = config.chat.serverUrl && 
                     config.chat.username;
    
    return ftpValid && chatValid;
    
  } catch (error) {
    console.error('Error checking configuration validity:', error);
    return false;
  }
}

module.exports = {
  getConfig,
  saveConfig,
  validateFTP,
  validateChat,
  isConfigurationValid,
  getConfigPath
};
