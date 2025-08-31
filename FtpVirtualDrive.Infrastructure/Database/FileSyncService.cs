using System.Collections.Concurrent;
using System.Security.Cryptography;
using FtpVirtualDrive.Core.Interfaces;
using FtpVirtualDrive.Core.Models;
using Microsoft.Extensions.Logging;

namespace FtpVirtualDrive.Infrastructure.Database;

/// <summary>
/// File synchronization service implementation
/// </summary>
public class FileSyncService : IFileSyncService
{
    private readonly IFtpClient _ftpClient;
    private readonly IVersionTracker _versionTracker;
    private readonly IActivityLogger _activityLogger;
    private readonly ILogger<FileSyncService> _logger;
    private readonly ConcurrentDictionary<string, SyncStatus> _syncStatuses = new();

    public event EventHandler<SyncCompletedEventArgs>? SyncCompleted;
    public event EventHandler<SyncConflictEventArgs>? ConflictDetected;

    public FileSyncService(
        IFtpClient ftpClient,
        IVersionTracker versionTracker,
        IActivityLogger activityLogger,
        ILogger<FileSyncService> logger)
    {
        _ftpClient = ftpClient ?? throw new ArgumentNullException(nameof(ftpClient));
        _versionTracker = versionTracker ?? throw new ArgumentNullException(nameof(versionTracker));
        _activityLogger = activityLogger ?? throw new ArgumentNullException(nameof(activityLogger));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async Task<SyncResult> SyncFileToServerAsync(string localPath, string remotePath)
    {
        var startTime = DateTime.UtcNow;
        _syncStatuses[localPath] = SyncStatus.Syncing;

        try
        {
            if (!File.Exists(localPath))
            {
                return new SyncResult
                {
                    Success = false,
                    ErrorMessage = "Local file does not exist",
                    Status = SyncStatus.Error
                };
            }

            var content = await File.ReadAllBytesAsync(localPath);
            var contentHash = _versionTracker.CalculateContentHash(content);

            // Check if we need to sync
            if (!await NeedsSyncAsync(localPath, remotePath))
            {
                _syncStatuses[localPath] = SyncStatus.InSync;
                return new SyncResult
                {
                    Success = true,
                    Status = SyncStatus.InSync,
                    BytesTransferred = 0
                };
            }

            // Upload to FTP server
            using var stream = new MemoryStream(content);
            var uploadSuccess = await _ftpClient.UploadFileAsync(remotePath, stream);

            if (!uploadSuccess)
            {
                _syncStatuses[localPath] = SyncStatus.Error;
                return new SyncResult
                {
                    Success = false,
                    ErrorMessage = "Failed to upload file to server",
                    Status = SyncStatus.Error
                };
            }

            // Save version locally
            await _versionTracker.SaveVersionAsync(remotePath, content, contentHash);

            var duration = DateTime.UtcNow - startTime;
            _syncStatuses[localPath] = SyncStatus.InSync;

            await _activityLogger.LogActivityAsync(ActivityLog.CreateSuccess(
                OperationType.Upload,
                remotePath,
                $"Synced to server ({content.Length} bytes)",
                _ftpClient.ConnectionInfo?.Username,
                content.Length));

            var result = new SyncResult
            {
                Success = true,
                Status = SyncStatus.InSync,
                BytesTransferred = content.Length,
                SyncTime = DateTime.UtcNow
            };

            OnSyncCompleted(new SyncCompletedEventArgs
            {
                FilePath = localPath,
                Result = result,
                Operation = OperationType.Upload
            });

            _logger.LogInformation("Successfully synced file {LocalPath} to server in {Duration}ms",
                localPath, duration.TotalMilliseconds);

            return result;
        }
        catch (Exception ex)
        {
            var duration = DateTime.UtcNow - startTime;
            _syncStatuses[localPath] = SyncStatus.Error;

            _logger.LogError(ex, "Failed to sync file {LocalPath} to server", localPath);

            await _activityLogger.LogActivityAsync(ActivityLog.Failure(
                OperationType.Upload,
                remotePath,
                ex.Message,
                _ftpClient.ConnectionInfo?.Username));

            var result = new SyncResult
            {
                Success = false,
                ErrorMessage = ex.Message,
                Status = SyncStatus.Error
            };

            OnSyncCompleted(new SyncCompletedEventArgs
            {
                FilePath = localPath,
                Result = result,
                Operation = OperationType.Upload
            });

            return result;
        }
    }

    public async Task<SyncResult> SyncFileFromServerAsync(string remotePath, string localPath)
    {
        var startTime = DateTime.UtcNow;
        _syncStatuses[localPath] = SyncStatus.Syncing;

        try
        {
            // Download from FTP server
            using var remoteStream = await _ftpClient.DownloadFileAsync(remotePath);
            var content = new byte[remoteStream.Length];
            await remoteStream.ReadExactlyAsync(content.AsMemory());

            var contentHash = _versionTracker.CalculateContentHash(content);

            // Check if file exists locally and compare
            if (File.Exists(localPath))
            {
                var localContent = await File.ReadAllBytesAsync(localPath);
                var localHash = _versionTracker.CalculateContentHash(localContent);

                if (localHash == contentHash)
                {
                    _syncStatuses[localPath] = SyncStatus.InSync;
                    return new SyncResult
                    {
                        Success = true,
                        Status = SyncStatus.InSync,
                        BytesTransferred = 0
                    };
                }
            }

            // Create directory if it doesn't exist
            var directory = Path.GetDirectoryName(localPath);
            if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
            {
                Directory.CreateDirectory(directory);
            }

            // Write file locally
            await File.WriteAllBytesAsync(localPath, content);

            // Save version
            await _versionTracker.SaveVersionAsync(remotePath, content, contentHash);

            var duration = DateTime.UtcNow - startTime;
            _syncStatuses[localPath] = SyncStatus.InSync;

            await _activityLogger.LogActivityAsync(ActivityLog.CreateSuccess(
                OperationType.Download,
                remotePath,
                $"Synced from server ({content.Length} bytes)",
                _ftpClient.ConnectionInfo?.Username,
                content.Length));

            var result = new SyncResult
            {
                Success = true,
                Status = SyncStatus.InSync,
                BytesTransferred = content.Length,
                SyncTime = DateTime.UtcNow
            };

            OnSyncCompleted(new SyncCompletedEventArgs
            {
                FilePath = localPath,
                Result = result,
                Operation = OperationType.Download
            });

            _logger.LogInformation("Successfully synced file {RemotePath} from server in {Duration}ms",
                remotePath, duration.TotalMilliseconds);

            return result;
        }
        catch (Exception ex)
        {
            var duration = DateTime.UtcNow - startTime;
            _syncStatuses[localPath] = SyncStatus.Error;

            _logger.LogError(ex, "Failed to sync file {RemotePath} from server", remotePath);

            await _activityLogger.LogActivityAsync(ActivityLog.Failure(
                OperationType.Download,
                remotePath,
                ex.Message,
                _ftpClient.ConnectionInfo?.Username));

            var result = new SyncResult
            {
                Success = false,
                ErrorMessage = ex.Message,
                Status = SyncStatus.Error
            };

            OnSyncCompleted(new SyncCompletedEventArgs
            {
                FilePath = localPath,
                Result = result,
                Operation = OperationType.Download
            });

            return result;
        }
    }

    public async Task<bool> NeedsSyncAsync(string localPath, string remotePath)
    {
        try
        {
            // Get local file info
            if (!File.Exists(localPath))
                return true;

            var localInfo = new FileInfo(localPath);
            var localContent = await File.ReadAllBytesAsync(localPath);
            var localHash = _versionTracker.CalculateContentHash(localContent);

            // Get latest version from our tracking
            var latestVersion = await _versionTracker.GetLatestVersionAsync(remotePath);
            if (latestVersion == null)
                return true;

            // Compare hashes
            return localHash != latestVersion.ContentHash;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error checking sync status for {LocalPath}", localPath);
            return true; // Assume sync is needed if we can't determine
        }
    }

    public async Task<ConflictResolutionResult> ResolveConflictAsync(
        string localPath, 
        string remotePath, 
        ConflictResolution resolution)
    {
        try
        {
            var localModified = File.GetLastWriteTimeUtc(localPath);
            var remoteInfo = await _ftpClient.GetFileInfoAsync(remotePath);
            var remoteModified = remoteInfo?.LastModified ?? DateTime.MinValue;

            OnConflictDetected(new SyncConflictEventArgs
            {
                FilePath = localPath,
                LocalModified = localModified,
                RemoteModified = remoteModified,
                Resolution = resolution
            });

            switch (resolution)
            {
                case ConflictResolution.UseLocal:
                    var localResult = await SyncFileToServerAsync(localPath, remotePath);
                    return new ConflictResolutionResult
                    {
                        Success = localResult.Success,
                        Resolution = resolution,
                        ErrorMessage = localResult.ErrorMessage
                    };

                case ConflictResolution.UseRemote:
                    var remoteResult = await SyncFileFromServerAsync(remotePath, localPath);
                    return new ConflictResolutionResult
                    {
                        Success = remoteResult.Success,
                        Resolution = resolution,
                        ErrorMessage = remoteResult.ErrorMessage
                    };

                case ConflictResolution.CreateBackup:
                    var backupPath = $"{localPath}.backup.{DateTime.UtcNow:yyyyMMdd_HHmmss}";
                    File.Copy(localPath, backupPath);
                    
                    var backupResult = await SyncFileFromServerAsync(remotePath, localPath);
                    return new ConflictResolutionResult
                    {
                        Success = backupResult.Success,
                        Resolution = resolution,
                        ErrorMessage = backupResult.ErrorMessage,
                        BackupPath = backupPath
                    };

                default:
                    return new ConflictResolutionResult
                    {
                        Success = false,
                        Resolution = resolution,
                        ErrorMessage = "Manual resolution required"
                    };
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error resolving conflict for {LocalPath}", localPath);
            return new ConflictResolutionResult
            {
                Success = false,
                Resolution = resolution,
                ErrorMessage = ex.Message
            };
        }
    }

    public async Task<SyncStatus> GetSyncStatusAsync(string filePath)
    {
        try
        {
            if (_syncStatuses.TryGetValue(filePath, out var status))
                return status;

            // Determine status by comparing with server
            var needsSync = await NeedsSyncAsync(filePath, filePath);
            var syncStatus = needsSync ? SyncStatus.NeedsUpload : SyncStatus.InSync;
            
            _syncStatuses[filePath] = syncStatus;
            return syncStatus;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting sync status for {FilePath}", filePath);
            return SyncStatus.Error;
        }
    }

    private void OnSyncCompleted(SyncCompletedEventArgs args)
    {
        SyncCompleted?.Invoke(this, args);
    }

    private void OnConflictDetected(SyncConflictEventArgs args)
    {
        ConflictDetected?.Invoke(this, args);
    }
}
