using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography.X509Certificates;
using FtpVirtualDrive.Core.Interfaces;
using FtpVirtualDrive.Core.Models;
using FluentFTP;
using Microsoft.Extensions.Logging;

namespace FtpVirtualDrive.Infrastructure.FTP;

/// <summary>
/// FTP client service implementation using FluentFTP
/// </summary>
public class FtpClientService : Core.Interfaces.IFtpClient
{
    private readonly ILogger<FtpClientService> _logger;
    private readonly IActivityLogger _activityLogger;
    private AsyncFtpClient? _ftpClient;
    private readonly ConcurrentDictionary<string, DateTime> _fileCache = new();
    private bool _disposed;

    public bool IsConnected => _ftpClient?.IsConnected ?? false;
    public FtpConnectionInfo? ConnectionInfo { get; private set; }

    public event EventHandler<FtpOperationEventArgs>? OperationCompleted;

    public FtpClientService(ILogger<FtpClientService> logger, IActivityLogger activityLogger)
    {
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _activityLogger = activityLogger ?? throw new ArgumentNullException(nameof(activityLogger));
    }

    /// <summary>
    /// Sets an already connected FTP client (used by connection pool)
    /// </summary>
    internal void SetInternalClient(AsyncFtpClient client, FtpConnectionInfo connectionInfo)
    {
        _ftpClient = client;
        ConnectionInfo = connectionInfo;
    }

    public async Task<bool> ConnectAsync(FtpConnectionInfo connectionInfo)
    {
        if (connectionInfo == null)
            throw new ArgumentNullException(nameof(connectionInfo));

        var validation = connectionInfo.Validate();
        if (!validation.IsValid)
        {
            var errorMessage = string.Join(", ", validation.Errors);
            _logger.LogError("Invalid connection info: {Errors}", errorMessage);
            await LogActivityAsync(ActivityLog.Failure(OperationType.Connect, connectionInfo.Host, errorMessage, connectionInfo.Username));
            return false;
        }

        try
        {
            await DisconnectAsync(); // Ensure clean state

            _ftpClient = new AsyncFtpClient(
                connectionInfo.Host, 
                connectionInfo.Username, 
                connectionInfo.Password, 
                connectionInfo.Port);

            // Configure FTP client settings
            ConfigureFtpClient(connectionInfo);

            var startTime = DateTime.UtcNow;
            await _ftpClient.AutoConnect();

            var duration = DateTime.UtcNow - startTime;
            ConnectionInfo = connectionInfo;

            _logger.LogInformation("Successfully connected to FTP server {Host}:{Port} as {Username}", 
                connectionInfo.Host, connectionInfo.Port, connectionInfo.Username);

            await LogActivityAsync(ActivityLog.CreateSuccess(
                OperationType.Connect, 
                connectionInfo.Host, 
                $"Connected successfully in {duration.TotalMilliseconds:F0}ms", 
                connectionInfo.Username));

            OnOperationCompleted(new FtpOperationEventArgs
            {
                Operation = OperationType.Connect,
                FilePath = connectionInfo.Host,
                Success = true,
                DurationMs = (long)duration.TotalMilliseconds
            });

            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to connect to FTP server {Host}:{Port}", 
                connectionInfo.Host, connectionInfo.Port);

            await LogActivityAsync(ActivityLog.Failure(
                OperationType.Connect, 
                connectionInfo.Host, 
                ex.Message, 
                connectionInfo.Username));

            OnOperationCompleted(new FtpOperationEventArgs
            {
                Operation = OperationType.Connect,
                FilePath = connectionInfo.Host,
                Success = false,
                ErrorMessage = ex.Message
            });

            return false;
        }
    }

    public async Task<bool> DisconnectAsync()
    {
        if (_ftpClient == null || !_ftpClient.IsConnected)
            return true;

        try
        {
            var host = ConnectionInfo?.Host ?? "Unknown";
            var username = ConnectionInfo?.Username ?? "Unknown";

            await _ftpClient.Disconnect();
            _ftpClient.Dispose();
            _ftpClient = null;

            _logger.LogInformation("Disconnected from FTP server");
            await LogActivityAsync(ActivityLog.CreateSuccess(OperationType.Disconnect, host, "Disconnected successfully", username));

            OnOperationCompleted(new FtpOperationEventArgs
            {
                Operation = OperationType.Disconnect,
                FilePath = host,
                Success = true
            });

            ConnectionInfo = null;
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during FTP disconnect");
            return false;
        }
    }

    public async Task<Stream> DownloadFileAsync(string remotePath)
    {
        EnsureConnected();

        var startTime = DateTime.UtcNow;
        try
        {
            var stream = new MemoryStream();
            await _ftpClient!.DownloadStream(stream, remotePath);
            stream.Position = 0;

            var duration = DateTime.UtcNow - startTime;
            _logger.LogDebug("Downloaded file {RemotePath} ({Size} bytes) in {Duration}ms", 
                remotePath, stream.Length, duration.TotalMilliseconds);

            await LogActivityAsync(ActivityLog.CreateSuccess(
                OperationType.Download, 
                remotePath, 
                $"Downloaded {stream.Length} bytes", 
                ConnectionInfo?.Username, 
                stream.Length));

            OnOperationCompleted(new FtpOperationEventArgs
            {
                Operation = OperationType.Download,
                FilePath = remotePath,
                Success = true,
                FileSize = stream.Length,
                DurationMs = (long)duration.TotalMilliseconds
            });

            return stream;
        }
        catch (Exception ex)
        {
            var duration = DateTime.UtcNow - startTime;
            _logger.LogError(ex, "Failed to download file {RemotePath}", remotePath);

            await LogActivityAsync(ActivityLog.Failure(
                OperationType.Download, 
                remotePath, 
                ex.Message, 
                ConnectionInfo?.Username));

            OnOperationCompleted(new FtpOperationEventArgs
            {
                Operation = OperationType.Download,
                FilePath = remotePath,
                Success = false,
                ErrorMessage = ex.Message,
                DurationMs = (long)duration.TotalMilliseconds
            });

            throw;
        }
    }

    public async Task<bool> UploadFileAsync(string remotePath, Stream content)
    {
        EnsureConnected();

        var startTime = DateTime.UtcNow;
        var originalPosition = content.Position;
        
        try
        {
            content.Position = 0;
            var result = await _ftpClient!.UploadStream(content, remotePath, FtpRemoteExists.Overwrite);

            var duration = DateTime.UtcNow - startTime;
            var fileSize = content.Length;

            _logger.LogDebug("Uploaded file {RemotePath} ({Size} bytes) in {Duration}ms", 
                remotePath, fileSize, duration.TotalMilliseconds);

            await LogActivityAsync(ActivityLog.CreateSuccess(
                OperationType.Upload, 
                remotePath, 
                $"Uploaded {fileSize} bytes", 
                ConnectionInfo?.Username, 
                fileSize));

            OnOperationCompleted(new FtpOperationEventArgs
            {
                Operation = OperationType.Upload,
                FilePath = remotePath,
                Success = result == FtpStatus.Success,
                FileSize = fileSize,
                DurationMs = (long)duration.TotalMilliseconds
            });

            return result == FtpStatus.Success;
        }
        catch (Exception ex)
        {
            var duration = DateTime.UtcNow - startTime;
            content.Position = originalPosition; // Restore position

            _logger.LogError(ex, "Failed to upload file {RemotePath}", remotePath);

            await LogActivityAsync(ActivityLog.Failure(
                OperationType.Upload, 
                remotePath, 
                ex.Message, 
                ConnectionInfo?.Username));

            OnOperationCompleted(new FtpOperationEventArgs
            {
                Operation = OperationType.Upload,
                FilePath = remotePath,
                Success = false,
                ErrorMessage = ex.Message,
                DurationMs = (long)duration.TotalMilliseconds
            });

            return false;
        }
    }

    public async Task<bool> DeleteFileAsync(string remotePath)
    {
        EnsureConnected();

        try
        {
            await _ftpClient!.DeleteFile(remotePath);

            _logger.LogDebug("Deleted file {RemotePath}", remotePath);
            await LogActivityAsync(ActivityLog.CreateSuccess(OperationType.Delete, remotePath, "File deleted", ConnectionInfo?.Username));

            OnOperationCompleted(new FtpOperationEventArgs
            {
                Operation = OperationType.Delete,
                FilePath = remotePath,
                Success = true
            });

            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to delete file {RemotePath}", remotePath);
            await LogActivityAsync(ActivityLog.Failure(OperationType.Delete, remotePath, ex.Message, ConnectionInfo?.Username));

            OnOperationCompleted(new FtpOperationEventArgs
            {
                Operation = OperationType.Delete,
                FilePath = remotePath,
                Success = false,
                ErrorMessage = ex.Message
            });

            return false;
        }
    }

    public async Task<IEnumerable<FtpFileInfo>> ListDirectoryAsync(string remotePath)
    {
        EnsureConnected();

        try
        {
            var ftpItems = await _ftpClient!.GetListing(remotePath);
            var fileInfos = ftpItems.Select(item => new FtpFileInfo
            {
                Name = item.Name,
                FullPath = item.FullName,
                IsDirectory = item.Type == FtpObjectType.Directory,
                Size = item.Size,
                LastModified = item.Modified,
                Permissions = item.Chmod.ToString(),
                Owner = item.RawOwner ?? string.Empty,
                Group = item.RawGroup ?? string.Empty
            }).ToList();

            await LogActivityAsync(ActivityLog.CreateSuccess(
                OperationType.ListDirectory, 
                remotePath, 
                $"Listed {fileInfos.Count} items", 
                ConnectionInfo?.Username));

            return fileInfos;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to list directory {RemotePath}", remotePath);
            await LogActivityAsync(ActivityLog.Failure(OperationType.ListDirectory, remotePath, ex.Message, ConnectionInfo?.Username));
            throw;
        }
    }

    public async Task<bool> CreateDirectoryAsync(string remotePath)
    {
        EnsureConnected();

        try
        {
            await _ftpClient!.CreateDirectory(remotePath);
            await LogActivityAsync(ActivityLog.CreateSuccess(OperationType.CreateDirectory, remotePath, "Directory created", ConnectionInfo?.Username));
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to create directory {RemotePath}", remotePath);
            await LogActivityAsync(ActivityLog.Failure(OperationType.CreateDirectory, remotePath, ex.Message, ConnectionInfo?.Username));
            return false;
        }
    }

    public async Task<bool> FileExistsAsync(string remotePath)
    {
        EnsureConnected();

        try
        {
            return await _ftpClient!.FileExists(remotePath);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to check if file exists {RemotePath}", remotePath);
            return false;
        }
    }

    public async Task<FtpFileInfo?> GetFileInfoAsync(string remotePath)
    {
        EnsureConnected();

        try
        {
            var ftpItem = await _ftpClient!.GetObjectInfo(remotePath);
            if (ftpItem == null) return null;

            return new FtpFileInfo
            {
                Name = ftpItem.Name,
                FullPath = ftpItem.FullName,
                IsDirectory = ftpItem.Type == FtpObjectType.Directory,
                Size = ftpItem.Size,
                LastModified = ftpItem.Modified,
                Permissions = ftpItem.Chmod.ToString(),
                Owner = ftpItem.RawOwner ?? string.Empty,
                Group = ftpItem.RawGroup ?? string.Empty
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get file info for {RemotePath}", remotePath);
            return null;
        }
    }

    private void ConfigureFtpClient(FtpConnectionInfo connectionInfo)
    {
        if (_ftpClient == null) return;

        // Configure encryption
        if (connectionInfo.UseSSL)
        {
            _ftpClient.Config.EncryptionMode = FtpEncryptionMode.Explicit;
            _ftpClient.Config.SslProtocols = System.Security.Authentication.SslProtocols.Tls12 | System.Security.Authentication.SslProtocols.Tls13;
            
            // Configure SSL validation
            _ftpClient.Config.ValidateAnyCertificate = connectionInfo.SslValidation == SslValidationMode.AcceptAnyCertificate;
            
            if (connectionInfo.SslValidation == SslValidationMode.ValidateCertificate)
            {
                _ftpClient.ValidateCertificate += (control, e) =>
                {
                    // Custom certificate validation logic can be added here
                    e.Accept = e.PolicyErrors == System.Net.Security.SslPolicyErrors.None;
                };
            }
        }
        else
        {
            _ftpClient.Config.EncryptionMode = FtpEncryptionMode.None;
        }

        // Configure other settings
        _ftpClient.Config.DataConnectionType = connectionInfo.UsePassiveMode ? 
            FtpDataConnectionType.PASV : FtpDataConnectionType.PORT;
        _ftpClient.Config.ConnectTimeout = connectionInfo.TimeoutSeconds * 1000;
        _ftpClient.Config.ReadTimeout = connectionInfo.TimeoutSeconds * 1000;
        _ftpClient.Config.DataConnectionConnectTimeout = connectionInfo.TimeoutSeconds * 1000;
        _ftpClient.Config.DataConnectionReadTimeout = connectionInfo.TimeoutSeconds * 1000;

        // Configure logging
        _ftpClient.Config.LogToConsole = false;
    }

    private void EnsureConnected()
    {
        if (!IsConnected)
            throw new InvalidOperationException("FTP client is not connected. Call ConnectAsync first.");
    }

    private async Task LogActivityAsync(ActivityLog activity)
    {
        try
        {
            await _activityLogger.LogActivityAsync(activity);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to log activity");
        }
    }

    private void OnOperationCompleted(FtpOperationEventArgs args)
    {
        OperationCompleted?.Invoke(this, args);
    }

    public void Dispose()
    {
        if (_disposed) return;

        try
        {
            _ftpClient?.Dispose();
            _ftpClient = null;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error disposing FTP client");
        }

        _disposed = true;
        GC.SuppressFinalize(this);
    }
}
