# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an FTP File Explorer Desktop Application built with Electron.js. It provides a modern, intuitive interface for browsing and managing files on FTP servers with advanced features like intelligent caching, lazy loading, and background synchronization.

### Key Features
- **FTP File Explorer**: Tree-view navigation with Windows Explorer-like behavior
- **Intelligent Caching**: Multi-level caching system for performance optimization
- **Lazy Loading**: On-demand directory loading for better UX
- **Background Workers**: Continuous monitoring and synchronization
- **Connection Pooling**: Efficient connection management with concurrent operations
- **File Operations**: Full CRUD operations with progress tracking
- **Security**: AES-256 encryption for sensitive data

## Development Commands

### Core Development Workflow
```bash
# Development mode
cd client && npm start

# Development with debugging
cd client && npm run dev

# Build for production
cd client && npm run build

# Platform-specific builds
cd client && npm run build:win   # Windows
cd client && npm run build:mac   # macOS  
cd client && npm run build:linux # Linux
```

### Available Scripts
- `npm start` - Run Electron app in development mode
- `npm run dev` - Run with debugging enabled
- `npm run build` - Build for current platform
- `npm run build:win` - Build Windows installer (NSIS)
- `npm run build:mac` - Build macOS DMG
- `npm run build:linux` - Build Linux AppImage

## Architecture

### Technology Stack
- **Electron.js**: Desktop application framework
- **basic-ftp**: FTP client library
- **Node.js**: Runtime environment
- **Electron Builder**: Application packaging

### Project Structure
```
ftp-chat-app/
├── client/                    # Main Electron application
│   ├── main.js              # Electron main process
│   ├── preload.js           # IPC context bridge
│   ├── renderer/            # UI components
│   │   ├── index.html       # Main HTML template
│   │   ├── renderer.js      # Frontend application logic
│   │   └── styles.css       # Application styles
│   └── utils/               # Utility modules
│       ├── config.js        # Configuration management with encryption
│       └── ftp-client.js    # FTP operations and connection pooling
├── config.json              # Application configuration (optional)
└── CLAUDE.md               # This guidance file
```

### Core Components

#### 1. Main Process (`main.js`)
- Manages application lifecycle
- Handles IPC communication with renderer
- Implements security features (context isolation, remote module disabled)
- Manages FTP connection pool and background workers

#### 2. Renderer Process (`renderer.js`)
- Windows Explorer-like file browser interface
- Implements lazy loading for large directory structures
- Manages real-time progress tracking
- Handles user interactions and file operations

#### 3. FTP Client (`utils/ftp-client.js`)
- Advanced connection pooling with configurable concurrency
- Intelligent caching system with multiple cache levels
- Background workers for continuous monitoring
- Lazy loading with priority queuing
- Progress tracking for all operations

#### 4. Configuration Management (`utils/config.js`)
- AES-256 encryption for sensitive data
- Fallback configuration system
- Validation and testing capabilities

## Key Architectural Patterns

### Connection Pooling
The application uses a sophisticated connection pool that:
- Maintains multiple concurrent connections (default: 10)
- Implements automatic connection health monitoring
- Provides efficient connection reuse
- Handles connection timeouts and errors gracefully

### Intelligent Caching System
Multi-level caching approach:
- **L1 Cache**: In-memory cache for frequently accessed data
- **L2 Cache**: Persistent file-based cache with structure optimization
- **Lazy Cache**: On-demand loading with visible directory tracking
- **Background Optimization**: Continuous cache improvements

### Background Workers
Automated monitoring system:
- Continuous directory monitoring for changes
- Smart refresh scheduling based on user activity
- Configurable refresh intervals
- Performance optimization during idle periods

### Lazy Loading Implementation
Windows Explorer-like behavior:
- Skeleton screens during loading
- On-demand directory content loading
- Visible directory tracking and monitoring
- Priority-based loading system

## Development Notes

### Security Considerations
- **Context Isolation**: Enabled in all BrowserWindows
- **Node Integration**: Disabled for security
- **Remote Module**: Disabled completely
- **Data Encryption**: FTP passwords encrypted using AES-256
- **Input Validation**: All user inputs validated before processing

### Performance Optimizations
- Connection pooling reduces connection overhead
- Lazy loading prevents unnecessary data transfer
- Background workers maintain cache freshness
- Smart caching minimizes server requests
- Progress tracking provides user feedback

### Error Handling
- Comprehensive error handling throughout the application
- User-friendly error messages
- Graceful degradation when services are unavailable
- Automatic retry mechanisms for transient failures

## Configuration

### Environment Variables
- `ENCRYPTION_KEY`: Optional 64-character hex key for encryption
- Default encryption key is derived from app name and version

### Configuration File
Located at `client/config.json` or userData directory:
```json
{
  "ftp": {
    "host": "",
    "port": 21,
    "username": "",
    "password": "", // Automatically encrypted
    "secure": false
  },
  "app": {
    "theme": "light",
    "autoConnect": false,
    "tempDir": ""
  }
}
```

## Development Guidelines

### Code Style
- Follow existing JavaScript patterns in the codebase
- Use async/await for all asynchronous operations
- Implement proper error handling with try/catch blocks
- Add meaningful console logging for debugging

### File Operations
- Always use the connection pool for FTP operations
- Implement proper cleanup in error scenarios
- Use progress callbacks for user feedback
- Handle file permissions and access errors gracefully

### UI Development
- Use the existing CSS classes and patterns
- Implement skeleton screens for loading states
- Ensure responsive design for different window sizes
- Follow the existing notification and modal patterns

### Testing
- Test with various FTP server configurations
- Verify error handling for network issues
- Test performance with large directory structures
- Validate user interaction flows