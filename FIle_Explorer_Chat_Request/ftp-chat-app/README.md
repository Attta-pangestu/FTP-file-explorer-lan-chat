# FTP File Explorer Desktop App

Aplikasi desktop menggunakan Electron.js untuk File Explorer berbasis FTP dengan antarmuka yang intuitif dan modern.

## Features

### 🗂️ FTP File Explorer
- Setup konfigurasi FTP (host, port, username, password)
- Browse direktori dan file dari server FTP
- Caching struktur direktori untuk performa
- Double-click file untuk download dan buka dengan aplikasi default
- UI tree view seperti Windows File Explorer

### 📁 Advanced File Management
- Comprehensive CRUD operations
- Drag-and-drop file upload
- Batch file operations
- Progress tracking for all operations

## Project Structure

```
ftp-chat-app/
├── client/                 # Electron client application
│   ├── main.js            # Main process Electron
│   ├── preload.js         # Context bridge for IPC
│   ├── package.json
│   ├── renderer/          # UI files
│   │   ├── index.html
│   │   ├── renderer.js
│   │   └── styles.css
│   └── utils/             # Utility modules
│       ├── config.js      # Configuration management
│       ├── ftp-client.js  # FTP operations

└── README.md
```

## Installation & Setup

### Prerequisites
- Node.js >= 14.x
- npm >= 6.x

### 1. Install Client
```bash
cd client
npm install
npm start  # Development mode
npm run build  # Production build
```

## Configuration

Saat pertama kali menjalankan aplikasi, Anda akan diminta untuk setup:

### FTP Configuration
- **Host**: Alamat server FTP
- **Port**: Port FTP (default: 21)
- **Username**: Username FTP
- **Password**: Password FTP (akan dienkripsi)



## Usage

1. **Jalankan Client**: `cd client && npm start`
2. **Setup konfigurasi** FTP pada first run
3. **Browse files** dan kelola file FTP dengan mudah
4. **Upload, download, edit, dan delete** file secara langsung

## Tech Stack

### Client
- **Electron.js**: Desktop app framework
- **basic-ftp**: FTP client operations
- **socket.io-client**: Real-time communication
- **Node.js crypto**: Password encryption

### Server
- **Node.js**: Runtime
- **Express**: Web framework
- **Socket.io**: WebSocket server

## Security Notes

- FTP passwords dienkripsi menggunakan AES-256
- Context isolation untuk keamanan Electron
- Input validation untuk semua parameter
- Tidak ada plain text passwords dalam logs

## Troubleshooting

### FTP Connection Issues
- Pastikan host dan port FTP benar
- Cek firewall dan network connectivity
- Verifikasi username/password



## Future Enhancements
- [ ] Advanced file search and filtering
- [ ] File versioning and backup
- [ ] Multi-server FTP management
- [ ] End-to-end encryption
- [ ] Multi-language support

## License

MIT License
