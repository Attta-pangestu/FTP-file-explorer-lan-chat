# FTP Virtual Drive

A .NET 9 desktop application that mounts FTP/FTPS servers as local virtual drives in Windows, allowing users to work with remote files as if they were local.

## Features

- **FTP/FTPS Connection**: Secure connection to FTP servers with SSL/TLS support
- **Virtual Drive Mounting**: Mount FTP servers as Windows drive letters (e.g., Z:)
- **Native App Integration**: Open and edit files directly in Microsoft Office, Notepad++, etc.
- **Auto-Sync**: Automatic synchronization of file changes back to the FTP server
- **Version Tracking**: Client-side versioning with rollback capabilities
- **Activity Logging**: Comprehensive logging of all file operations
- **Credential Management**: Secure storage using Windows Credential Manager

## Architecture

The application follows Clean Architecture principles with clear separation of concerns:

```
├── FtpVirtualDrive.Core/           # Business logic and interfaces
├── FtpVirtualDrive.Infrastructure/ # External integrations (FTP, Database, etc.)
├── FtpVirtualDrive.UI/            # WPF user interface
└── FtpVirtualDrive.Tests/         # Unit and integration tests
```

## Prerequisites

1. **.NET 9 Runtime** - Download from [Microsoft .NET](https://dotnet.microsoft.com/download)
2. **Dokan Driver** - Download from [Dokan Library](https://github.com/dokan-dev/dokany/releases)
   - Required for virtual drive mounting
   - Install the latest stable release

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd FtpVirtualDrive
   ```

2. Build the solution:
   ```bash
   dotnet build
   ```

3. Run the application:
   ```bash
   dotnet run --project FtpVirtualDrive.UI
   ```

## Usage

### Connecting to FTP Server

1. **Enter Connection Details**:
   - Host: FTP server IP address or domain name
   - Port: FTP port (21 for FTP, 990 for FTPS)
   - Username: FTP account username
   - Password: FTP account password
   - Enable "Use SSL/TLS (FTPS)" for secure connections

2. **Save Credentials** (Optional):
   - Enter a connection name
   - Click "Save Credentials" to store securely in Windows Credential Manager

3. **Connect**:
   - Click "Connect" to establish FTP connection

### Mounting Virtual Drive

1. **Select Drive Letter**:
   - Choose an available drive letter from the dropdown

2. **Mount Drive**:
   - Click "Mount Drive" to create the virtual drive
   - The FTP server will appear as a local drive in Windows Explorer

3. **Access Files**:
   - Navigate to the mounted drive in Windows Explorer
   - Open files directly in their native applications
   - Edit and save files normally - changes sync automatically

### Activity Monitoring

- The **Activity Log** panel shows real-time file operations
- Operations include: downloads, uploads, edits, deletions, etc.
- Each entry shows timestamp, operation type, file path, and status
- Export logs to CSV, JSON, XML, or text formats

### File Versioning

- File versions are automatically tracked when changes are made
- Access version history through the application interface
- Rollback files to previous versions when needed

## Configuration

### FTP Server Setup

Ensure your FTP server supports:
- FTPS (FTP over SSL/TLS) for security
- Passive mode connections
- File modification timestamps

### Security Considerations

- Always use FTPS (SSL/TLS) for production environments
- Credentials are stored securely using Windows Credential Manager
- All network communications are encrypted when using FTPS

## Troubleshooting

### Common Issues

1. **"Failed to mount virtual drive"**
   - Ensure Dokan driver is installed
   - Try running as Administrator
   - Check if the selected drive letter is available

2. **"Connection failed"**
   - Verify FTP server credentials
   - Check network connectivity
   - Ensure FTP server allows the connection from your IP
   - Try different ports (21 for FTP, 990 for FTPS)

3. **"Files not syncing"**
   - Check FTP server permissions
   - Verify network stability
   - Look at activity logs for detailed error information

### Logs

Application logs are stored in:
- **File Logs**: `logs/app-{date}.log`
- **Database**: `%APPDATA%/FtpVirtualDrive/app.db`

## Development

### Building from Source

```bash
# Restore packages
dotnet restore

# Build solution
dotnet build

# Run tests
dotnet test

# Publish for distribution
dotnet publish FtpVirtualDrive.UI -c Release -r win-x64 --self-contained
```

### Key Technologies

- **.NET 9**: Core framework
- **WPF**: User interface framework
- **FluentFTP**: FTP/FTPS client library
- **Dokan.Net**: Virtual file system driver
- **Entity Framework Core**: Database ORM
- **SQLite**: Local database storage
- **Serilog**: Structured logging

### Architecture Patterns

- **Clean Architecture**: Separation of concerns
- **MVVM**: Model-View-ViewModel pattern for UI
- **Dependency Injection**: Service registration and resolution
- **Repository Pattern**: Data access abstraction
- **Observer Pattern**: Event-driven communication

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For issues and support:
1. Check the troubleshooting section above
2. Review application logs for detailed error information
3. Create an issue on GitHub with:
   - Operating system version
   - .NET version
   - Dokan driver version
   - FTP server type and version
   - Detailed error description and logs
