using FtpVirtualDrive.Core.Models;

namespace FtpVirtualDrive.Core.Interfaces;

/// <summary>
/// Defines the contract for FTP file explorer operations
/// </summary>
public interface IFtpExplorerService : IDisposable
{
    /// <summary>
    /// Gets the current directory path
    /// </summary>
    string CurrentDirectory { get; }
    
    /// <summary>
    /// Gets whether the service is currently busy with an operation
    /// </summary>
    bool IsBusy { get; }
    
    /// <summary>
    /// Initializes the explorer service with an FTP client
    /// </summary>
    /// <param name="ftpClient">Connected FTP client</param>
    /// <returns>True if initialization was successful</returns>
    Task<bool> InitializeAsync(IFtpClient ftpClient);
    
    /// <summary>
    /// Lists directory contents at the specified path
    /// </summary>
    /// <param name="remotePath">Remote directory path</param>
    /// <param name="useCache">Whether to use cached results if available</param>
    /// <returns>Collection of directory entries</returns>
    Task<IEnumerable<FtpDirectoryEntry>> ListDirectoryAsync(string remotePath, bool useCache = true);
    
    /// <summary>
    /// Navigates to the parent directory
    /// </summary>
    /// <returns>Collection of directory entries in parent directory</returns>
    Task<IEnumerable<FtpDirectoryEntry>> NavigateUpAsync();
    
    /// <summary>
    /// Navigates to a subdirectory
    /// </summary>
    /// <param name="directoryName">Name of the subdirectory</param>
    /// <returns>Collection of directory entries in the subdirectory</returns>
    Task<IEnumerable<FtpDirectoryEntry>> NavigateToDirectoryAsync(string directoryName);
    
    /// <summary>
    /// Navigates to an absolute path
    /// </summary>
    /// <param name="absolutePath">Absolute directory path</param>
    /// <returns>Collection of directory entries at the path</returns>
    Task<IEnumerable<FtpDirectoryEntry>> NavigateToPathAsync(string absolutePath);
    
    /// <summary>
    /// Downloads a file content as text (for editing)
    /// </summary>
    /// <param name="filePath">Remote file path</param>
    /// <returns>File content as string</returns>
    Task<string> DownloadFileAsTextAsync(string filePath);
    
    /// <summary>
    /// Downloads a file content as stream (for saving locally)
    /// </summary>
    /// <param name="filePath">Remote file path</param>
    /// <param name="progress">Progress reporter</param>
    /// <returns>File content as stream</returns>
    Task<Stream> DownloadFileAsStreamAsync(string filePath, IProgress<double>? progress = null);
    
    /// <summary>
    /// Uploads text content as a file
    /// </summary>
    /// <param name="filePath">Remote file path</param>
    /// <param name="content">Text content to upload</param>
    /// <returns>True if upload was successful</returns>
    Task<bool> UploadTextAsync(string filePath, string content);
    
    /// <summary>
    /// Uploads a file from local path
    /// </summary>
    /// <param name="remotePath">Remote file path</param>
    /// <param name="localPath">Local file path</param>
    /// <param name="progress">Progress reporter</param>
    /// <returns>True if upload was successful</returns>
    Task<bool> UploadFileAsync(string remotePath, string localPath, IProgress<double>? progress = null);
    
    /// <summary>
    /// Uploads file content from stream
    /// </summary>
    /// <param name="remotePath">Remote file path</param>
    /// <param name="content">File content stream</param>
    /// <param name="progress">Progress reporter</param>
    /// <returns>True if upload was successful</returns>
    Task<bool> UploadStreamAsync(string remotePath, Stream content, IProgress<double>? progress = null);
    
    /// <summary>
    /// Deletes a file or directory
    /// </summary>
    /// <param name="remotePath">Remote path to delete</param>
    /// <param name="isDirectory">Whether the path is a directory</param>
    /// <returns>True if deletion was successful</returns>
    Task<bool> DeleteAsync(string remotePath, bool isDirectory);
    
    /// <summary>
    /// Renames a file or directory
    /// </summary>
    /// <param name="oldPath">Current path</param>
    /// <param name="newName">New name</param>
    /// <returns>True if rename was successful</returns>
    Task<bool> RenameAsync(string oldPath, string newName);
    
    /// <summary>
    /// Creates a new directory
    /// </summary>
    /// <param name="parentPath">Parent directory path</param>
    /// <param name="directoryName">New directory name</param>
    /// <returns>True if creation was successful</returns>
    Task<bool> CreateDirectoryAsync(string parentPath, string directoryName);
    
    /// <summary>
    /// Refreshes the cache for a directory
    /// </summary>
    /// <param name="remotePath">Directory path to refresh</param>
    /// <returns>Refreshed directory entries</returns>
    Task<IEnumerable<FtpDirectoryEntry>> RefreshDirectoryAsync(string remotePath);
    
    /// <summary>
    /// Clears all cached directory listings
    /// </summary>
    void ClearCache();
    
    /// <summary>
    /// Gets the path breadcrumb trail
    /// </summary>
    /// <param name="currentPath">Current directory path</param>
    /// <returns>List of path segments for breadcrumb navigation</returns>
    IEnumerable<PathBreadcrumb> GetBreadcrumbs(string currentPath);
    
    /// <summary>
    /// Event fired when a file operation is completed
    /// </summary>
    event EventHandler<FtpExplorerOperationEventArgs>? OperationCompleted;
    
    /// <summary>
    /// Event fired when the current directory changes
    /// </summary>
    event EventHandler<DirectoryChangedEventArgs>? DirectoryChanged;
}

/// <summary>
/// Represents a breadcrumb segment in the path navigation
/// </summary>
public class PathBreadcrumb
{
    /// <summary>
    /// Display name for the segment
    /// </summary>
    public string Name { get; set; } = string.Empty;
    
    /// <summary>
    /// Full path to this segment
    /// </summary>
    public string FullPath { get; set; } = string.Empty;
    
    /// <summary>
    /// Whether this is the current/active segment
    /// </summary>
    public bool IsCurrent { get; set; }
}

/// <summary>
/// Event arguments for FTP explorer operations
/// </summary>
public class FtpExplorerOperationEventArgs : EventArgs
{
    /// <summary>
    /// Type of operation performed
    /// </summary>
    public OperationType Operation { get; set; }
    
    /// <summary>
    /// File or directory path involved in the operation
    /// </summary>
    public string FilePath { get; set; } = string.Empty;
    
    /// <summary>
    /// Whether the operation was successful
    /// </summary>
    public bool Success { get; set; }
    
    /// <summary>
    /// Error message if operation failed
    /// </summary>
    public string? ErrorMessage { get; set; }
    
    /// <summary>
    /// Operation timestamp
    /// </summary>
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
    
    /// <summary>
    /// File size for upload/download operations
    /// </summary>
    public long? FileSize { get; set; }
    
    /// <summary>
    /// Duration of the operation in milliseconds
    /// </summary>
    public long? DurationMs { get; set; }
    
    /// <summary>
    /// Additional operation details
    /// </summary>
    public string? Details { get; set; }
}

/// <summary>
/// Event arguments for directory change events
/// </summary>
public class DirectoryChangedEventArgs : EventArgs
{
    /// <summary>
    /// Previous directory path
    /// </summary>
    public string? OldDirectory { get; set; }
    
    /// <summary>
    /// New current directory path
    /// </summary>
    public string NewDirectory { get; set; } = string.Empty;
    
    /// <summary>
    /// Directory entries in the new directory
    /// </summary>
    public IEnumerable<FtpDirectoryEntry> Entries { get; set; } = Enumerable.Empty<FtpDirectoryEntry>();
}
