using System.Collections.Concurrent;
using System.Text;
using FtpVirtualDrive.Core.Interfaces;
using FtpVirtualDrive.Core.Models;
using Microsoft.Extensions.Logging;

namespace FtpVirtualDrive.Infrastructure.FTP;

/// <summary>
/// FTP explorer service implementation
/// </summary>
public class FtpExplorerService : IFtpExplorerService
{
    private readonly ILogger<FtpExplorerService> _logger;
    private readonly IActivityLogger _activityLogger;
    private readonly ConcurrentDictionary<string, (IEnumerable<FtpDirectoryEntry> Entries, DateTime CacheTime)> _directoryCache = new();
    private readonly TimeSpan _cacheTimeout = TimeSpan.FromMinutes(5);
    
    private IFtpClient? _ftpClient;
    private string _currentDirectory = "/";
    private bool _isBusy;
    private bool _disposed;

    public string CurrentDirectory => _currentDirectory;
    public bool IsBusy => _isBusy;

    public event EventHandler<FtpExplorerOperationEventArgs>? OperationCompleted;
    public event EventHandler<DirectoryChangedEventArgs>? DirectoryChanged;

    public FtpExplorerService(ILogger<FtpExplorerService> logger, IActivityLogger activityLogger)
    {
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _activityLogger = activityLogger ?? throw new ArgumentNullException(nameof(activityLogger));
    }

    public async Task<bool> InitializeAsync(IFtpClient ftpClient)
    {
        try
        {
            _ftpClient = ftpClient ?? throw new ArgumentNullException(nameof(ftpClient));
            
            if (!_ftpClient.IsConnected)
            {
                _logger.LogError("FTP client is not connected");
                return false;
            }

            // Try to navigate to root and get initial listing
            var entries = await ListDirectoryAsync("/", false);
            _currentDirectory = "/";
            
            OnDirectoryChanged(null, "/", entries);
            
            _logger.LogInformation("FTP Explorer service initialized successfully");
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to initialize FTP explorer service");
            return false;
        }
    }

    public async Task<IEnumerable<FtpDirectoryEntry>> ListDirectoryAsync(string remotePath, bool useCache = true)
    {
        EnsureFtpClient();
        
        if (useCache && _directoryCache.TryGetValue(remotePath, out var cached))
        {
            if (DateTime.UtcNow - cached.CacheTime < _cacheTimeout)
            {
                return cached.Entries;
            }
        }

        return await RefreshDirectoryAsync(remotePath);
    }

    public async Task<IEnumerable<FtpDirectoryEntry>> NavigateUpAsync()
    {
        if (_currentDirectory == "/" || string.IsNullOrEmpty(_currentDirectory))
        {
            return await ListDirectoryAsync(_currentDirectory);
        }

        var parentPath = GetParentPath(_currentDirectory);
        return await NavigateToPathAsync(parentPath);
    }

    public async Task<IEnumerable<FtpDirectoryEntry>> NavigateToDirectoryAsync(string directoryName)
    {
        var newPath = CombinePaths(_currentDirectory, directoryName);
        return await NavigateToPathAsync(newPath);
    }

    public async Task<IEnumerable<FtpDirectoryEntry>> NavigateToPathAsync(string absolutePath)
    {
        EnsureFtpClient();
        
        var startTime = DateTime.UtcNow;
        try
        {
            SetBusy(true);
            
            var oldDirectory = _currentDirectory;
            var normalizedPath = NormalizePath(absolutePath);
            
            var entries = await ListDirectoryAsync(normalizedPath, true);
            _currentDirectory = normalizedPath;
            
            var duration = DateTime.UtcNow - startTime;
            
            await LogActivityAsync(OperationType.NavigateToDirectory, normalizedPath, true, 
                $"Navigated to {normalizedPath}", duration);
            
            OnDirectoryChanged(oldDirectory, _currentDirectory, entries);
            
            return entries;
        }
        catch (Exception ex)
        {
            var duration = DateTime.UtcNow - startTime;
            _logger.LogError(ex, "Failed to navigate to directory {Path}", absolutePath);
            
            await LogActivityAsync(OperationType.NavigateToDirectory, absolutePath, false, 
                ex.Message, duration);
            
            throw;
        }
        finally
        {
            SetBusy(false);
        }
    }

    public async Task<string> DownloadFileAsTextAsync(string filePath)
    {
        EnsureFtpClient();
        
        var startTime = DateTime.UtcNow;
        try
        {
            SetBusy(true);
            
            using var stream = await _ftpClient.DownloadFileAsync(filePath);
            using var reader = new StreamReader(stream, Encoding.UTF8, true);
            var content = await reader.ReadToEndAsync();
            
            var duration = DateTime.UtcNow - startTime;
            
            await LogActivityAsync(OperationType.OpenFile, filePath, true, 
                $"Opened file for editing ({stream.Length} bytes)", duration, stream.Length);
            
            return content;
        }
        catch (Exception ex)
        {
            var duration = DateTime.UtcNow - startTime;
            _logger.LogError(ex, "Failed to download file as text {FilePath}", filePath);
            
            await LogActivityAsync(OperationType.OpenFile, filePath, false, 
                ex.Message, duration);
            
            throw;
        }
        finally
        {
            SetBusy(false);
        }
    }

    public async Task<Stream> DownloadFileAsStreamAsync(string filePath, IProgress<double>? progress = null)
    {
        EnsureFtpClient();
        
        var startTime = DateTime.UtcNow;
        try
        {
            SetBusy(true);
            
            // For now, we'll use the basic download without progress
            // In a full implementation, we could implement progress tracking
            var stream = await _ftpClient.DownloadFileAsync(filePath);
            
            var duration = DateTime.UtcNow - startTime;
            
            await LogActivityAsync(OperationType.DownloadFile, filePath, true, 
                $"Downloaded file ({stream.Length} bytes)", duration, stream.Length);
            
            return stream;
        }
        catch (Exception ex)
        {
            var duration = DateTime.UtcNow - startTime;
            _logger.LogError(ex, "Failed to download file {FilePath}", filePath);
            
            await LogActivityAsync(OperationType.DownloadFile, filePath, false, 
                ex.Message, duration);
            
            throw;
        }
        finally
        {
            SetBusy(false);
        }
    }

    public async Task<bool> UploadTextAsync(string filePath, string content)
    {
        EnsureFtpClient();
        
        var startTime = DateTime.UtcNow;
        try
        {
            SetBusy(true);
            
            var bytes = Encoding.UTF8.GetBytes(content);
            using var stream = new MemoryStream(bytes);
            
            var success = await _ftpClient.UploadFileAsync(filePath, stream);
            
            var duration = DateTime.UtcNow - startTime;
            
            await LogActivityAsync(OperationType.EditFile, filePath, success, 
                success ? $"Saved file ({bytes.Length} bytes)" : "Failed to save file", 
                duration, bytes.Length);
            
            if (success)
            {
                // Invalidate parent directory cache
                var parentPath = GetParentPath(filePath);
                _directoryCache.TryRemove(parentPath, out _);
            }
            
            return success;
        }
        catch (Exception ex)
        {
            var duration = DateTime.UtcNow - startTime;
            _logger.LogError(ex, "Failed to upload text to {FilePath}", filePath);
            
            await LogActivityAsync(OperationType.EditFile, filePath, false, 
                ex.Message, duration);
            
            return false;
        }
        finally
        {
            SetBusy(false);
        }
    }

    public async Task<bool> UploadFileAsync(string remotePath, string localPath, IProgress<double>? progress = null)
    {
        EnsureFtpClient();
        
        if (!File.Exists(localPath))
        {
            throw new FileNotFoundException($"Local file not found: {localPath}");
        }
        
        var startTime = DateTime.UtcNow;
        try
        {
            SetBusy(true);
            
            using var fileStream = File.OpenRead(localPath);
            var success = await _ftpClient.UploadFileAsync(remotePath, fileStream);
            
            var duration = DateTime.UtcNow - startTime;
            
            await LogActivityAsync(OperationType.UploadFile, remotePath, success, 
                success ? $"Uploaded file ({fileStream.Length} bytes)" : "Failed to upload file", 
                duration, fileStream.Length);
            
            if (success)
            {
                // Invalidate parent directory cache
                var parentPath = GetParentPath(remotePath);
                _directoryCache.TryRemove(parentPath, out _);
            }
            
            return success;
        }
        catch (Exception ex)
        {
            var duration = DateTime.UtcNow - startTime;
            _logger.LogError(ex, "Failed to upload file from {LocalPath} to {RemotePath}", localPath, remotePath);
            
            await LogActivityAsync(OperationType.UploadFile, remotePath, false, 
                ex.Message, duration);
            
            return false;
        }
        finally
        {
            SetBusy(false);
        }
    }

    public async Task<bool> UploadStreamAsync(string remotePath, Stream content, IProgress<double>? progress = null)
    {
        EnsureFtpClient();
        
        var startTime = DateTime.UtcNow;
        try
        {
            SetBusy(true);
            
            var success = await _ftpClient.UploadFileAsync(remotePath, content);
            
            var duration = DateTime.UtcNow - startTime;
            
            await LogActivityAsync(OperationType.UploadFile, remotePath, success, 
                success ? $"Uploaded file ({content.Length} bytes)" : "Failed to upload file", 
                duration, content.Length);
            
            if (success)
            {
                // Invalidate parent directory cache
                var parentPath = GetParentPath(remotePath);
                _directoryCache.TryRemove(parentPath, out _);
            }
            
            return success;
        }
        catch (Exception ex)
        {
            var duration = DateTime.UtcNow - startTime;
            _logger.LogError(ex, "Failed to upload stream to {RemotePath}", remotePath);
            
            await LogActivityAsync(OperationType.UploadFile, remotePath, false, 
                ex.Message, duration);
            
            return false;
        }
        finally
        {
            SetBusy(false);
        }
    }

    public async Task<bool> DeleteAsync(string remotePath, bool isDirectory)
    {
        EnsureFtpClient();
        
        var startTime = DateTime.UtcNow;
        try
        {
            SetBusy(true);
            
            bool success;
            if (isDirectory)
            {
                // For directories, we might need recursive deletion
                // For now, using the basic delete which should work for empty directories
                success = await _ftpClient.DeleteFileAsync(remotePath); // FluentFTP handles both files and directories
            }
            else
            {
                success = await _ftpClient.DeleteFileAsync(remotePath);
            }
            
            var duration = DateTime.UtcNow - startTime;
            var itemType = isDirectory ? "directory" : "file";
            
            await LogActivityAsync(OperationType.Delete, remotePath, success, 
                success ? $"Deleted {itemType}" : $"Failed to delete {itemType}", duration);
            
            if (success)
            {
                // Invalidate parent directory cache
                var parentPath = GetParentPath(remotePath);
                _directoryCache.TryRemove(parentPath, out _);
            }
            
            return success;
        }
        catch (Exception ex)
        {
            var duration = DateTime.UtcNow - startTime;
            _logger.LogError(ex, "Failed to delete {Type} {RemotePath}", 
                isDirectory ? "directory" : "file", remotePath);
            
            await LogActivityAsync(OperationType.Delete, remotePath, false, 
                ex.Message, duration);
            
            return false;
        }
        finally
        {
            SetBusy(false);
        }
    }

    public async Task<bool> RenameAsync(string oldPath, string newName)
    {
        EnsureFtpClient();
        
        var startTime = DateTime.UtcNow;
        try
        {
            SetBusy(true);
            
            var success = await _ftpClient.RenameAsync(oldPath, newName);
            
            var duration = DateTime.UtcNow - startTime;
            
            await LogActivityAsync(OperationType.Rename, oldPath, success, 
                success ? $"Renamed to {newName}" : "Failed to rename", duration);
            
            if (success)
            {
                // Invalidate parent directory cache
                var parentPath = GetParentPath(oldPath);
                _directoryCache.TryRemove(parentPath, out _);
            }
            
            return success;
        }
        catch (Exception ex)
        {
            var duration = DateTime.UtcNow - startTime;
            _logger.LogError(ex, "Failed to rename {OldPath} to {NewName}", oldPath, newName);
            
            await LogActivityAsync(OperationType.Rename, oldPath, false, 
                ex.Message, duration);
            
            return false;
        }
        finally
        {
            SetBusy(false);
        }
    }

    public async Task<bool> CreateDirectoryAsync(string parentPath, string directoryName)
    {
        EnsureFtpClient();
        
        var newDirectoryPath = CombinePaths(parentPath, directoryName);
        var startTime = DateTime.UtcNow;
        try
        {
            SetBusy(true);
            
            var success = await _ftpClient.CreateDirectoryAsync(newDirectoryPath);
            
            var duration = DateTime.UtcNow - startTime;
            
            await LogActivityAsync(OperationType.CreateDirectory, newDirectoryPath, success, 
                success ? "Directory created" : "Failed to create directory", duration);
            
            if (success)
            {
                // Invalidate parent directory cache
                _directoryCache.TryRemove(parentPath, out _);
            }
            
            return success;
        }
        catch (Exception ex)
        {
            var duration = DateTime.UtcNow - startTime;
            _logger.LogError(ex, "Failed to create directory {DirectoryPath}", newDirectoryPath);
            
            await LogActivityAsync(OperationType.CreateDirectory, newDirectoryPath, false, 
                ex.Message, duration);
            
            return false;
        }
        finally
        {
            SetBusy(false);
        }
    }

    public async Task<IEnumerable<FtpDirectoryEntry>> RefreshDirectoryAsync(string remotePath)
    {
        EnsureFtpClient();
        
        var startTime = DateTime.UtcNow;
        try
        {
            SetBusy(true);
            
            var ftpFiles = await _ftpClient.ListDirectoryAsync(remotePath);
            var entries = ftpFiles.Select(f => new FtpDirectoryEntry
            {
                Name = f.Name,
                FullPath = f.FullPath,
                ParentPath = remotePath,
                Size = f.Size,
                IsDirectory = f.IsDirectory,
                LastModifiedUtc = f.LastModified.ToUniversalTime(),
                Permissions = f.Permissions,
                Owner = f.Owner,
                Group = f.Group
            }).OrderBy(e => e.IsDirectory ? 0 : 1).ThenBy(e => e.Name).ToList();
            
            // Update cache
            _directoryCache.AddOrUpdate(remotePath, 
                (entries, DateTime.UtcNow), 
                (key, oldValue) => (entries, DateTime.UtcNow));
            
            var duration = DateTime.UtcNow - startTime;
            
            await LogActivityAsync(OperationType.RefreshDirectory, remotePath, true, 
                $"Refreshed directory ({entries.Count} items)", duration);
            
            return entries;
        }
        catch (Exception ex)
        {
            var duration = DateTime.UtcNow - startTime;
            _logger.LogError(ex, "Failed to refresh directory {RemotePath}", remotePath);
            
            await LogActivityAsync(OperationType.RefreshDirectory, remotePath, false, 
                ex.Message, duration);
            
            throw;
        }
        finally
        {
            SetBusy(false);
        }
    }

    public void ClearCache()
    {
        _directoryCache.Clear();
        _logger.LogDebug("Directory cache cleared");
    }

    public IEnumerable<PathBreadcrumb> GetBreadcrumbs(string currentPath)
    {
        var breadcrumbs = new List<PathBreadcrumb>();
        
        if (string.IsNullOrEmpty(currentPath) || currentPath == "/")
        {
            breadcrumbs.Add(new PathBreadcrumb
            {
                Name = "Root",
                FullPath = "/",
                IsCurrent = true
            });
            return breadcrumbs;
        }
        
        // Add root
        breadcrumbs.Add(new PathBreadcrumb
        {
            Name = "Root",
            FullPath = "/",
            IsCurrent = false
        });
        
        var normalizedPath = currentPath.TrimStart('/').TrimEnd('/');
        var segments = normalizedPath.Split('/');
        var currentBreadcrumbPath = "";
        
        for (int i = 0; i < segments.Length; i++)
        {
            var segment = segments[i];
            currentBreadcrumbPath += "/" + segment;
            
            breadcrumbs.Add(new PathBreadcrumb
            {
                Name = segment,
                FullPath = currentBreadcrumbPath,
                IsCurrent = i == segments.Length - 1
            });
        }
        
        return breadcrumbs;
    }

    private void EnsureFtpClient()
    {
        if (_ftpClient == null || !_ftpClient.IsConnected)
        {
            throw new InvalidOperationException("FTP client is not connected. Initialize the service first.");
        }
    }

    private void SetBusy(bool busy)
    {
        _isBusy = busy;
    }

    private static string NormalizePath(string path)
    {
        if (string.IsNullOrEmpty(path))
            return "/";
            
        path = path.Replace('\\', '/');
        if (!path.StartsWith('/'))
            path = "/" + path;
            
        // Remove double slashes
        while (path.Contains("//"))
            path = path.Replace("//", "/");
            
        return path;
    }

    private static string GetParentPath(string path)
    {
        if (string.IsNullOrEmpty(path) || path == "/")
            return "/";
            
        path = path.TrimEnd('/');
        var lastSlash = path.LastIndexOf('/');
        
        if (lastSlash <= 0)
            return "/";
            
        return path.Substring(0, lastSlash);
    }

    private static string CombinePaths(string basePath, string relativePath)
    {
        if (string.IsNullOrEmpty(basePath))
            basePath = "/";
        if (string.IsNullOrEmpty(relativePath))
            return basePath;
            
        basePath = basePath.TrimEnd('/');
        relativePath = relativePath.TrimStart('/');
        
        return basePath + "/" + relativePath;
    }

    private async Task LogActivityAsync(OperationType operation, string filePath, bool success, 
        string details, TimeSpan? duration = null, long? fileSize = null)
    {
        try
        {
            var activity = success 
                ? ActivityLog.CreateSuccess(operation, filePath, details, _ftpClient?.ConnectionInfo?.Username, fileSize)
                : ActivityLog.Failure(operation, filePath, details, _ftpClient?.ConnectionInfo?.Username);
                
            await _activityLogger.LogActivityAsync(activity);
            
            OnOperationCompleted(new FtpExplorerOperationEventArgs
            {
                Operation = operation,
                FilePath = filePath,
                Success = success,
                ErrorMessage = success ? null : details,
                FileSize = fileSize,
                DurationMs = duration?.Milliseconds,
                Details = details
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to log activity for operation {Operation} on {FilePath}", operation, filePath);
        }
    }

    private void OnDirectoryChanged(string? oldDirectory, string newDirectory, IEnumerable<FtpDirectoryEntry> entries)
    {
        DirectoryChanged?.Invoke(this, new DirectoryChangedEventArgs
        {
            OldDirectory = oldDirectory,
            NewDirectory = newDirectory,
            Entries = entries
        });
    }

    private void OnOperationCompleted(FtpExplorerOperationEventArgs args)
    {
        OperationCompleted?.Invoke(this, args);
    }

    public void Dispose()
    {
        if (_disposed) return;
        
        _directoryCache.Clear();
        _ftpClient = null;
        
        _disposed = true;
        GC.SuppressFinalize(this);
    }
}
