const { io } = require('socket.io-client');
const config = require('./config');

// Chat client instance and state
let socket = null;
let isConnected = false;
let currentUsername = null;
let connectionCallbacks = {
  onMessage: null,
  onUserList: null,
  onError: null,
  onConnect: null,
  onDisconnect: null
};

// Connection settings
const RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 3000;

// Connect to chat server
async function connect(username) {
  try {
    if (isConnected && socket && currentUsername === username) {
      return {
        success: true,
        message: 'Already connected to chat server',
        username: currentUsername
      };
    }
    
    // Disconnect existing connection if different username
    if (socket && currentUsername !== username) {
      await disconnect();
    }
    
    // Get chat configuration
    const appConfig = await config.getConfig();
    const chatConfig = appConfig.chat;
    
    if (!chatConfig.serverUrl) {
      throw new Error('Chat server URL is not configured');
    }
    
    if (!username || username.trim().length === 0) {
      throw new Error('Username is required');
    }
    
    const trimmedUsername = username.trim();
    
    console.log(`Connecting to chat server: ${chatConfig.serverUrl} as ${trimmedUsername}`);
    
    return new Promise((resolve, reject) => {
      // Create socket connection
      socket = io(chatConfig.serverUrl, {
        transports: ['websocket', 'polling'],
        timeout: 10000,
        reconnection: true,
        reconnectionAttempts: RECONNECT_ATTEMPTS,
        reconnectionDelay: RECONNECT_DELAY,
        autoConnect: false
      });
      
      // Set up event handlers
      setupEventHandlers(socket, resolve, reject, trimmedUsername);
      
      // Connect to server
      socket.connect();
      
      // Set timeout for connection
      const connectionTimeout = setTimeout(() => {
        if (!isConnected) {
          socket.disconnect();
          reject(new Error('Connection timeout'));
        }
      }, 15000);
      
      // Clear timeout on connect or error
      socket.once('connect', () => clearTimeout(connectionTimeout));
      socket.once('error', () => clearTimeout(connectionTimeout));
    });
    
  } catch (error) {
    console.error('Error connecting to chat server:', error);
    throw new Error(`Failed to connect to chat: ${error.message}`);
  }
}

// Setup socket event handlers
function setupEventHandlers(socket, resolve, reject, username) {
  
  // Connection established
  socket.on('connect', () => {
    console.log('Connected to chat server');
    
    // Send login request
    socket.emit('user:login', { username });
  });
  
  // Login successful
  socket.on('user:login:success', (data) => {
    console.log(`Logged in successfully as: ${data.username}`);
    isConnected = true;
    currentUsername = data.username;
    
    // Call onConnect callback
    if (connectionCallbacks.onConnect) {
      connectionCallbacks.onConnect(data);
    }
    
    resolve({
      success: true,
      message: 'Successfully connected to chat server',
      username: data.username
    });
  });
  
  // Receive chat messages
  socket.on('chat:message', (message) => {
    console.log('Received chat message:', message);
    
    // Call onMessage callback
    if (connectionCallbacks.onMessage) {
      connectionCallbacks.onMessage(message);
    }
  });
  
  // Receive chat history
  socket.on('chat:history', (messages) => {
    console.log(`Received chat history: ${messages.length} messages`);
    
    // Call onMessage callback for each message
    if (connectionCallbacks.onMessage) {
      messages.forEach(message => {
        connectionCallbacks.onMessage(message);
      });
    }
  });
  
  // Receive user list updates
  socket.on('user:list', (users) => {
    console.log('Received user list:', users);
    
    // Call onUserList callback
    if (connectionCallbacks.onUserList) {
      connectionCallbacks.onUserList(users);
    }
  });
  
  // Handle typing indicators
  socket.on('chat:typing', (data) => {
    console.log('User typing:', data);
    // Could be extended to handle typing indicators in UI
  });
  
  // Handle errors
  socket.on('error', (error) => {
    console.error('Chat server error:', error);
    const errorMessage = error.message || 'Unknown chat server error';
    
    // Call onError callback
    if (connectionCallbacks.onError) {
      connectionCallbacks.onError({ message: errorMessage, type: 'server_error' });
    }
    
    if (!isConnected) {
      reject(new Error(errorMessage));
    }
  });
  
  // Handle connection errors
  socket.on('connect_error', (error) => {
    console.error('Chat connection error:', error);
    const errorMessage = `Connection failed: ${error.message}`;
    
    // Call onError callback
    if (connectionCallbacks.onError) {
      connectionCallbacks.onError({ message: errorMessage, type: 'connection_error' });
    }
    
    if (!isConnected) {
      reject(new Error(errorMessage));
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', (reason) => {
    console.log(`Disconnected from chat server: ${reason}`);
    isConnected = false;
    
    // Call onDisconnect callback
    if (connectionCallbacks.onDisconnect) {
      connectionCallbacks.onDisconnect({ reason });
    }
  });
  
  // Handle reconnection
  socket.on('reconnect', (attemptNumber) => {
    console.log(`Reconnected to chat server (attempt ${attemptNumber})`);
    
    // Re-login after reconnection
    if (currentUsername) {
      socket.emit('user:login', { username: currentUsername });
    }
  });
  
  // Handle reconnection attempts
  socket.on('reconnect_attempt', (attemptNumber) => {
    console.log(`Attempting to reconnect to chat server (attempt ${attemptNumber})`);
  });
  
  // Handle reconnection failure
  socket.on('reconnect_failed', () => {
    console.error('Failed to reconnect to chat server');
    isConnected = false;
    
    if (connectionCallbacks.onError) {
      connectionCallbacks.onError({
        message: 'Failed to reconnect to chat server',
        type: 'reconnection_failed'
      });
    }
  });
}

// Send a message
async function sendMessage(message) {
  try {
    if (!socket || !isConnected) {
      throw new Error('Not connected to chat server');
    }
    
    if (!message || message.trim().length === 0) {
      throw new Error('Message cannot be empty');
    }
    
    const trimmedMessage = message.trim();
    
    console.log('Sending message:', trimmedMessage);
    
    // Send message to server
    socket.emit('chat:send', { message: trimmedMessage });
    
    return {
      success: true,
      message: 'Message sent successfully'
    };
    
  } catch (error) {
    console.error('Error sending message:', error);
    throw new Error(`Failed to send message: ${error.message}`);
  }
}

// Send typing indicator
function sendTypingIndicator(isTyping) {
  try {
    if (!socket || !isConnected) {
      return;
    }
    
    socket.emit('chat:typing', { isTyping });
  } catch (error) {
    console.error('Error sending typing indicator:', error);
  }
}

// Disconnect from chat server
async function disconnect() {
  try {
    if (socket) {
      console.log('Disconnecting from chat server');
      
      // Remove all listeners to prevent memory leaks
      socket.removeAllListeners();
      
      // Disconnect socket
      socket.disconnect();
      socket = null;
    }
    
    isConnected = false;
    currentUsername = null;
    
    // Clear callbacks
    connectionCallbacks = {
      onMessage: null,
      onUserList: null,
      onError: null,
      onConnect: null,
      onDisconnect: null
    };
    
    console.log('Disconnected from chat server');
    
    return {
      success: true,
      message: 'Disconnected from chat server'
    };
    
  } catch (error) {
    console.error('Error disconnecting from chat:', error);
    throw new Error(`Failed to disconnect: ${error.message}`);
  }
}

// Register callback for incoming messages
function onMessage(callback) {
  if (typeof callback === 'function') {
    connectionCallbacks.onMessage = callback;
  } else {
    throw new Error('Callback must be a function');
  }
}

// Register callback for user list updates
function onUserList(callback) {
  if (typeof callback === 'function') {
    connectionCallbacks.onUserList = callback;
  } else {
    throw new Error('Callback must be a function');
  }
}

// Register callback for errors
function onError(callback) {
  if (typeof callback === 'function') {
    connectionCallbacks.onError = callback;
  } else {
    throw new Error('Callback must be a function');
  }
}

// Register callback for connection events
function onConnect(callback) {
  if (typeof callback === 'function') {
    connectionCallbacks.onConnect = callback;
  } else {
    throw new Error('Callback must be a function');
  }
}

// Register callback for disconnection events
function onDisconnect(callback) {
  if (typeof callback === 'function') {
    connectionCallbacks.onDisconnect = callback;
  } else {
    throw new Error('Callback must be a function');
  }
}

// Get connection status
function getConnectionStatus() {
  return {
    isConnected,
    username: currentUsername,
    hasSocket: !!socket,
    socketConnected: socket ? socket.connected : false
  };
}

// Get current username
function getCurrentUsername() {
  return currentUsername;
}

// Check if connected
function isClientConnected() {
  return isConnected && socket && socket.connected;
}

module.exports = {
  connect,
  disconnect,
  sendMessage,
  sendTypingIndicator,
  onMessage,
  onUserList,
  onError,
  onConnect,
  onDisconnect,
  getConnectionStatus,
  getCurrentUsername,
  isClientConnected
};
