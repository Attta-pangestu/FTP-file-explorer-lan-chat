const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// In-memory storage
const connectedUsers = new Map(); // socketId -> { username, joinTime }
const messages = []; // Array of { id, username, message, timestamp }
let messageIdCounter = 1;

// Middleware untuk logging
app.use(express.static('public'));

// Basic HTTP endpoint untuk health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    connectedUsers: connectedUsers.size,
    totalMessages: messages.length
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Handle user login
  socket.on('user:login', (data) => {
    try {
      const { username } = data;
      
      // Validate username
      if (!username || username.trim().length === 0) {
        socket.emit('error', { message: 'Username tidak boleh kosong' });
        return;
      }

      const trimmedUsername = username.trim();

      // Check if username already exists
      const existingUser = Array.from(connectedUsers.values())
        .find(user => user.username.toLowerCase() === trimmedUsername.toLowerCase());

      if (existingUser) {
        socket.emit('error', { message: 'Username sudah digunakan, pilih username lain' });
        return;
      }

      // Register user
      connectedUsers.set(socket.id, {
        username: trimmedUsername,
        joinTime: new Date().toISOString()
      });

      // Send success response
      socket.emit('user:login:success', { username: trimmedUsername });
      
      // Send current messages history (last 50 messages)
      const recentMessages = messages.slice(-50);
      socket.emit('chat:history', recentMessages);

      // Broadcast updated user list
      broadcastUserList();

      // Broadcast user joined message
      const joinMessage = {
        id: messageIdCounter++,
        username: 'System',
        message: `${trimmedUsername} bergabung dalam chat`,
        timestamp: new Date().toISOString(),
        type: 'system'
      };
      messages.push(joinMessage);
      io.emit('chat:message', joinMessage);

      console.log(`User logged in: ${trimmedUsername} (${socket.id})`);
      
    } catch (error) {
      console.error('Error in user:login:', error);
      socket.emit('error', { message: 'Terjadi kesalahan saat login' });
    }
  });

  // Handle chat messages
  socket.on('chat:send', (data) => {
    try {
      const user = connectedUsers.get(socket.id);
      
      if (!user) {
        socket.emit('error', { message: 'Anda harus login terlebih dahulu' });
        return;
      }

      const { message } = data;
      
      if (!message || message.trim().length === 0) {
        return; // Ignore empty messages
      }

      const chatMessage = {
        id: messageIdCounter++,
        username: user.username,
        message: message.trim(),
        timestamp: new Date().toISOString(),
        type: 'user'
      };

      // Store message
      messages.push(chatMessage);

      // Keep only last 1000 messages to prevent memory issues
      if (messages.length > 1000) {
        messages.shift();
      }

      // Broadcast to all connected clients
      io.emit('chat:message', chatMessage);

      console.log(`Message from ${user.username}: ${message.trim()}`);
      
    } catch (error) {
      console.error('Error in chat:send:', error);
      socket.emit('error', { message: 'Gagal mengirim pesan' });
    }
  });

  // Handle user typing indicator
  socket.on('chat:typing', (data) => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      socket.broadcast.emit('chat:typing', {
        username: user.username,
        isTyping: data.isTyping
      });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    
    if (user) {
      console.log(`User disconnected: ${user.username} (${socket.id})`);
      
      // Remove user from connected list
      connectedUsers.delete(socket.id);
      
      // Broadcast user left message
      const leaveMessage = {
        id: messageIdCounter++,
        username: 'System',
        message: `${user.username} meninggalkan chat`,
        timestamp: new Date().toISOString(),
        type: 'system'
      };
      messages.push(leaveMessage);
      io.emit('chat:message', leaveMessage);
      
      // Broadcast updated user list
      broadcastUserList();
    } else {
      console.log(`Socket disconnected: ${socket.id}`);
    }
  });
});

// Helper function to broadcast user list
function broadcastUserList() {
  const userList = Array.from(connectedUsers.values()).map(user => ({
    username: user.username,
    joinTime: user.joinTime
  }));
  
  io.emit('user:list', userList);
}

// Error handling
io.on('error', (error) => {
  console.error('Socket.io error:', error);
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Chat server running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n⏹️  Shutting down chat server...');
  server.close(() => {
    console.log('✅ Chat server closed');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
