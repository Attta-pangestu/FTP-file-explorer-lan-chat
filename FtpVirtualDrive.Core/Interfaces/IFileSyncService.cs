using FtpVirtualDrive.Core.Models;

namespace FtpVirtualDrive.Core.Interfaces;

/// <summary>
/// Defines the contract for file synchronization operations
/// </summary>
public interface IFileSyncService
{
    /// <summary>
    /// Synchronizes a local file change to the FTP server
    /// </summary>
    /// <param name="localPath">Local file path</param>
    /// <param name="remotePath">Remote file path</param>
    /// <returns>Sync result</returns>
    Task<SyncResult> SyncFileToServerAsync(string localPath, string remotePath);

    /// <summary>
    /// Downloads a file from the FTP server to local cache
    /// </summary>
    /// <param name="remotePath">Remote file path</param>
    /// <param name="localPath">Local cache path</param>
    /// <returns>Sync result</returns>
    Task<SyncResult> SyncFileFromServerAsync(string remotePath, string localPath);

    /// <summary>
    /// Checks if a file needs synchronization
    /// </summary>
    /// <param name="localPath">Local file path</param>
    /// <param name="remotePath">Remote file path</param>
    /// <returns>True if sync is needed</returns>
    Task<bool> NeedsSyncAsync(string localPath, string remotePath);

    /// <summary>
    /// Resolves sync conflicts when both local and remote files have changed
    /// </summary>
    /// <param name="localPath">Local file path</param>
    /// <param name="remotePath">Remote file path</param>
    /// <param name="resolution">Conflict resolution strategy</param>
    /// <returns>Conflict resolution result</returns>
    Task<ConflictResolutionResult> ResolveConflictAsync(
        string localPath, 
        string remotePath, 
        ConflictResolution resolution);

    /// <summary>
    /// Gets the sync status for a file
    /// </summary>
    /// <param name="filePath">File path</param>
    /// <returns>Current sync status</returns>
    Task<SyncStatus> GetSyncStatusAsync(string filePath);

    /// <summary>
    /// Event fired when a file sync operation completes
    /// </summary>
    event EventHandler<SyncCompletedEventArgs>? SyncCompleted;

    /// <summary>
    /// Event fired when a sync conflict is detected
    /// </summary>
    event EventHandler<SyncConflictEventArgs>? ConflictDetected;
}
