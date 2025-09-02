# FTP File Explorer & Chat Desktop App

Aplikasi desktop menggunakan Electron.js yang menggabungkan File Explorer berbasis FTP dan fitur Chat real-time seperti WhatsApp Desktop.

## Features

### 🗂️ FTP File Explorer
- Setup konfigurasi FTP (host, port, username, password)
- Browse direktori dan file dari server FTP
- Caching struktur direktori untuk performa
- Double-click file untuk download dan buka dengan aplikasi default
- UI tree view seperti Windows File Explorer

### 💬 Real-time Chat
- Setup server chat terpisah
- UI mirip WhatsApp Desktop
- Login dengan username
- Chat real-time menggunakan WebSocket
- Daftar pengguna aktif

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
│       └── chat-client.js # Chat functionality
├── server/                # Chat server
│   ├── server.js         # Socket.io server
│   └── package.json
└── README.md
```

## Installation & Setup

### Prerequisites
- Node.js >= 14.x
- npm >= 6.x

### 1. Install Chat Server
```bash
cd server
npm install
npm start
```

### 2. Install Electron Client
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

### Chat Configuration  
- **Chat Server URL**: ws://localhost:3000 (default)
- **Chat Username**: Username untuk chat (berbeda dari FTP)

## Usage

1. **Jalankan Chat Server**: `cd server && npm start`
2. **Jalankan Client**: `cd client && npm start`
3. **Setup konfigurasi** FTP dan Chat pada first run
4. **Browse FTP files** di tab File Explorer
5. **Chat real-time** di tab Chat

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

### Chat Connection Issues  
- Pastikan chat server berjalan di port 3000
- Cek URL server chat di konfigurasi
- Username harus unique per session

## Future Enhancements
- [ ] Private 1-on-1 chat
- [ ] File upload via FTP
- [ ] Database untuk chat history
- [ ] End-to-end encryption
- [ ] Multi-language support

## License

MIT License
