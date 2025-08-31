using System.Collections.Concurrent;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using DokanNet;
using DokanNet.Logging;
using FtpVirtualDrive.Core.Interfaces;
using FtpVirtualDrive.Core.Models;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using FileAccess = DokanNet.FileAccess;

namespace FtpVirtualDrive.Infrastructure.VirtualFileSystem;

/// <summary>
/// Virtual file system implementation using Dokan.Net to mount FTP as a local drive
/// </summary>
[SupportedOSPlatform("windows")]
public class FtpVirtualFileSystem : IDokanOperations, IVirtualDrive
{
    private readonly ILogger<FtpVirtualFileSystem> _logger;
    private readonly IFileSyncService _syncService;
    private readonly IVersionTracker _versionTracker;
    private readonly IActivityLogger _activityLogger;
    private readonly IFileOperationQueue _operationQueue;
    private readonly IMemoryCache _cache;
    
    private IFtpConnectionPool? _connectionPool;
    private IFtpClient? _ftpClient; // Keep for compatibility with Dokan operations
    private FtpConnectionInfo? _connectionInfo;
    private string? _mountPoint;
    private readonly ConcurrentDictionary<string, Stream> _openFiles = new();
    private readonly ConcurrentDictionary<string, CachedFileInfo> _fileCache = new();
    private readonly ConcurrentDictionary<string, CachedDirectoryInfo> _directoryCache = new();
    private bool _disposed;
    private DokanInstance? _dokanInstance;

    public bool IsMounted { get; private set; }
    public string? MountedDriveLetter { get; private set; }
    public string? MountPath { get; private set; }

    public event EventHandler<VirtualFileSystemEventArgs>? FileOperation;
    public event EventHandler<MountStatusEventArgs>? MountStatusChanged;

    public FtpVirtualFileSystem(
        ILogger<FtpVirtualFileSystem> logger,
        IFileSyncService syncService,
        IVersionTracker versionTracker,
        IActivityLogger activityLogger,
        IFileOperationQueue operationQueue,
        IMemoryCache cache)
    {
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _syncService = syncService ?? throw new ArgumentNullException(nameof(syncService));
        _versionTracker = versionTracker ?? throw new ArgumentNullException(nameof(versionTracker));
        _activityLogger = activityLogger ?? throw new ArgumentNullException(nameof(activityLogger));
        _operationQueue = operationQueue ?? throw new ArgumentNullException(nameof(operationQueue));
        _cache = cache ?? throw new ArgumentNullException(nameof(cache));
        
        // Set thread pool minimum to avoid thread starvation
        ThreadPool.SetMinThreads(64, 64);
    }

    public async Task<bool> MountAsync(string driveLetter, IFtpClient ftpClient)
    {
        if (IsMounted)
        {
            _logger.LogWarning("Virtual drive is already mounted");
            return false;
        }

        if (!ftpClient.IsConnected)
        {
            _logger.LogError("FTP client is not connected");
            return false;
        }

        try
        {
            // Store the FTP client for Dokan operations
            _ftpClient = ftpClient;
            _connectionInfo = ftpClient.ConnectionInfo;
            
            // Create connection pool if needed
            if (_connectionPool == null && _connectionInfo != null)
            {
                var loggerFactory = Microsoft.Extensions.Logging.LoggerFactory.Create(builder => {});
                _connectionPool = new FTP.FtpConnectionPool(
                    loggerFactory.CreateLogger<FTP.FtpConnectionPool>(),
                    _activityLogger,
                    _connectionInfo,
                    maxPoolSize: 8,
                    minPoolSize: 2);
            }
            
            _mountPoint = driveLetter.ToUpper() + ":";
            MountedDriveLetter = _mountPoint;
            MountPath = MountedDriveLetter + "\\";

            // Create DokanInstance using the DokanNet 2.3 API
            var dokanLogger = new ConsoleLogger("[Dokan] ");
            var dokan = new Dokan(dokanLogger);
            var dokanBuilder = new DokanInstanceBuilder(dokan)
                .ConfigureOptions(options =>
                {
                    options.MountPoint = _mountPoint + "\\";
                    // ThreadCount was removed in DokanNet 2.3 - threading is handled internally
                    options.Options = DokanOptions.DebugMode | DokanOptions.StderrOutput;
                    // Note: VolumeLabel is set via GetVolumeInformation method
                })
                .ConfigureLogger(() => dokanLogger);

            _dokanInstance = dokanBuilder.Build(this);

            // Start Dokan in a background task
            _ = Task.Run(async () =>
            {
                try
                {
                    await _dokanInstance.WaitForFileSystemClosedAsync(uint.MaxValue);
                    _logger.LogInformation("Dokan file system has been closed");
                    
                    // Update mount status when file system is closed
                    IsMounted = false;
                    OnMountStatusChanged(false, null, "File system was unmounted");
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error during Dokan mount operation");
                    OnMountStatusChanged(false, null, ex.Message);
                }
            });

            // Give it a moment to initialize
            await Task.Delay(1000);

            IsMounted = true;
            _logger.LogInformation("Successfully mounted FTP as virtual drive {DriveLetter}", MountedDriveLetter);

            await _activityLogger.LogActivityAsync(ActivityLog.CreateSuccess(
                OperationType.Connect,
                MountedDriveLetter,
                "Virtual drive mounted successfully",
                _connectionInfo?.Username));

            OnMountStatusChanged(true, MountedDriveLetter, null);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to mount virtual drive {DriveLetter}", driveLetter);
            OnMountStatusChanged(false, null, ex.Message);
            return false;
        }
    }

    public async Task<bool> UnmountAsync()
    {
        if (!IsMounted)
            return true;

        try
        {
            if (_dokanInstance != null && OperatingSystem.IsWindows())
            {
                _dokanInstance.Dispose();
                _dokanInstance = null;
            }

            // Clean up open files
            foreach (var openFile in _openFiles.Values)
            {
                openFile.Dispose();
            }
            _openFiles.Clear();
            _fileCache.Clear();
            _directoryCache.Clear();
            // Clear memory cache entries
            if (_cache is MemoryCache memCache)
            {
                memCache.Compact(1.0); // Remove all entries
            }

            var driveLetter = MountedDriveLetter;
            IsMounted = false;
            MountedDriveLetter = null;
            MountPath = null;

            _logger.LogInformation("Successfully unmounted virtual drive {DriveLetter}", driveLetter);

            await _activityLogger.LogActivityAsync(ActivityLog.CreateSuccess(
                OperationType.Disconnect,
                driveLetter ?? "Unknown",
                "Virtual drive unmounted successfully",
                _connectionInfo?.Username));

            OnMountStatusChanged(false, null, null);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to unmount virtual drive");
            OnMountStatusChanged(false, null, ex.Message);
            return false;
        }
    }

    public async Task<IEnumerable<string>> GetAvailableDriveLettersAsync()
    {
        return await Task.Run(() =>
        {
            var usedLetters = DriveInfo.GetDrives().Select(d => d.Name[0]).ToHashSet();
            var availableLetters = new List<string>();

            for (char letter = 'Z'; letter >= 'C'; letter--)
            {
                if (!usedLetters.Contains(letter))
                {
                    availableLetters.Add(letter.ToString());
                }
            }

            return availableLetters;
        });
    }

    #region IDokanOperations Implementation

    public NtStatus CreateFile(string fileName, FileAccess access, FileShare share, FileMode mode,
        FileOptions options, FileAttributes attributes, IDokanFileInfo info)
    {
        try
        {
            var operation = mode switch
            {
                FileMode.Create => OperationType.Create,
                FileMode.CreateNew => OperationType.Create,
                _ => OperationType.Open
            };

            _logger.LogDebug("CreateFile: {FileName}, Mode: {Mode}, Access: {Access}", fileName, mode, access);

            // Handle root directory access
            if (fileName == "\\" || fileName == "/")
            {
                info.IsDirectory = true;
                return NtStatus.Success;
            }

            // Handle directory operations
            if (info.IsDirectory)
            {
                return HandleDirectoryOperation(fileName, mode, operation);
            }

            // Handle file operations
            return HandleFileOperation(fileName, mode, access, operation);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in CreateFile for {FileName}", fileName);
            return NtStatus.Error;
        }
    }

    public NtStatus ReadFile(string fileName, byte[] buffer, out int bytesRead, long offset, IDokanFileInfo info)
    {
        bytesRead = 0;

        try
        {
            if (!_openFiles.TryGetValue(fileName, out var stream))
            {
                // File not in cache, download from FTP with timeout
                var timeoutTask = Task.Delay(TimeSpan.FromSeconds(15));
                var ftpTask = Task.Run(async () => await _ftpClient!.DownloadFileAsync(NormalizeFtpPath(fileName)));
                
                var completedTask = Task.WaitAny(ftpTask, timeoutTask);
                
                if (completedTask == 0 && ftpTask.IsCompletedSuccessfully)
                {
                    var ftpStream = ftpTask.Result;
                    _openFiles[fileName] = ftpStream;
                    stream = ftpStream;

                    _ = Task.Run(async () =>
                    {
                        await _activityLogger.LogActivityAsync(ActivityLog.CreateSuccess(
                            OperationType.Download, fileName, $"Downloaded for read access", 
                            _ftpClient.ConnectionInfo?.Username, stream.Length));
                    });
                }
                else
                {
                    _logger.LogWarning("FTP file download timed out for {FileName}", fileName);
                    return NtStatus.IoTimeout;
                }
            }

            stream.Position = offset;
            bytesRead = stream.Read(buffer, 0, buffer.Length);

            return NtStatus.Success;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error reading file {FileName} at offset {Offset}", fileName, offset);
            return NtStatus.Error;
        }
    }

    public NtStatus WriteFile(string fileName, byte[] buffer, out int bytesWritten, long offset, IDokanFileInfo info)
    {
        bytesWritten = 0;

        try
        {
            if (!_openFiles.TryGetValue(fileName, out var stream))
            {
                // Create new stream for writing
                stream = new MemoryStream();
                _openFiles[fileName] = stream;
            }

            if (stream.Length < offset)
            {
                // Extend stream if necessary
                stream.SetLength(offset);
            }

            stream.Position = offset;
            stream.Write(buffer, 0, buffer.Length);
            bytesWritten = buffer.Length;

            // Mark file as modified in cache
            var cacheKey = $"file_{fileName}";
            _cache.Set(cacheKey, new CachedFileInfo 
            { 
                Name = Path.GetFileName(fileName),
                LastModified = DateTime.UtcNow, 
                IsModified = true 
            }, TimeSpan.FromMinutes(5));

            // Log write operation (capture bytesWritten value for async logging)
            var writtenBytes = bytesWritten;
            _ = Task.Run(async () =>
            {
                await _activityLogger.LogActivityAsync(ActivityLog.CreateSuccess(
                    OperationType.Modify, fileName, $"File data written at offset {offset}", 
                    _ftpClient?.ConnectionInfo?.Username, writtenBytes));
            });

            return NtStatus.Success;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error writing to file {FileName} at offset {Offset}", fileName, offset);
            return NtStatus.Error;
        }
    }

    public NtStatus GetFileInformation(string fileName, out FileInformation fileInfo, IDokanFileInfo info)
    {
        fileInfo = new FileInformation();

        try
        {
            _logger.LogDebug("GetFileInformation called for: {FileName}", fileName);

            // Handle root directory
            if (fileName == "\\" || fileName == "/" || string.IsNullOrEmpty(fileName))
            {
                fileInfo = new FileInformation
                {
                    FileName = ".",
                    Length = 0,
                    LastWriteTime = DateTime.UtcNow,
                    LastAccessTime = DateTime.UtcNow,
                    CreationTime = DateTime.UtcNow,
                    Attributes = FileAttributes.Directory
                };
                return NtStatus.Success;
            }

            var cacheKey = $"file_{fileName}";
            if (_cache.TryGetValue<CachedFileInfo>(cacheKey, out var cached))
            {
                fileInfo = cached.ToFileInformation();
                return NtStatus.Success;
            }

            // Normalize path for FTP
            var ftpPath = NormalizeFtpPath(fileName);
            
            // Use Task.Run with timeout to avoid blocking
            var timeoutTask = Task.Delay(TimeSpan.FromSeconds(5));
            var ftpTask = Task.Run(async () => await _ftpClient!.GetFileInfoAsync(ftpPath));
            
            var completedTask = Task.WaitAny(ftpTask, timeoutTask);
            
            if (completedTask == 0 && ftpTask.IsCompletedSuccessfully)
            {
                var ftpFileInfo = ftpTask.Result;
                if (ftpFileInfo == null)
                {
                    _logger.LogWarning("File not found on FTP server: {FtpPath}", ftpPath);
                    return NtStatus.ObjectNameNotFound;
                }

                fileInfo = new FileInformation
                {
                    FileName = Path.GetFileName(fileName) ?? ftpFileInfo.Name,
                    Length = ftpFileInfo.Size,
                    LastWriteTime = ftpFileInfo.LastModified,
                    LastAccessTime = ftpFileInfo.LastModified,
                    CreationTime = ftpFileInfo.LastModified,
                    Attributes = ftpFileInfo.IsDirectory ? FileAttributes.Directory : FileAttributes.Normal
                };

                // Cache the file info
                _fileCache[fileName] = new CachedFileInfo
                {
                    Name = ftpFileInfo.Name,
                    Size = ftpFileInfo.Size,
                    LastModified = ftpFileInfo.LastModified,
                    IsDirectory = ftpFileInfo.IsDirectory
                };

                return NtStatus.Success;
            }
            else
            {
                _logger.LogWarning("FTP file info request timed out for {FtpPath}", ftpPath);
                return NtStatus.IoTimeout;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting file information for {FileName}", fileName);
            return NtStatus.ObjectNameNotFound;
        }
    }

    public NtStatus FindFiles(string fileName, out IList<FileInformation> files, IDokanFileInfo info)
    {
        files = new List<FileInformation>();

        try
        {
            _logger.LogDebug("FindFiles called for: {FileName}", fileName);

            // Handle root directory
            var ftpPath = NormalizeFtpPath(fileName);
            if (string.IsNullOrEmpty(ftpPath) || ftpPath == "/")
            {
                ftpPath = "/"; // FTP root directory
            }

            // Check cache first to avoid FTP call
            var cacheKey = $"dir_{ftpPath}";
            if (_directoryCache.TryGetValue(cacheKey, out var cachedFiles) && 
                DateTime.UtcNow - cachedFiles.CachedAt < TimeSpan.FromMinutes(5))
            {
                files = cachedFiles.Files;
                _logger.LogDebug("Returning cached directory listing for {FtpPath} with {Count} files", ftpPath, files.Count);
                return NtStatus.Success;
            }

            // Use Task.Run with timeout to avoid blocking
            var timeoutTask = Task.Delay(TimeSpan.FromSeconds(10));
            var ftpTask = Task.Run(async () => await _ftpClient!.ListDirectoryAsync(ftpPath));
            
            var completedTask = Task.WaitAny(ftpTask, timeoutTask);
            
            if (completedTask == 0 && ftpTask.IsCompletedSuccessfully)
            {
                var ftpFiles = ftpTask.Result;
                var fileList = new List<FileInformation>();
                
                foreach (var ftpFile in ftpFiles)
                {
                    // Skip hidden files and current/parent directory entries
                    if (ftpFile.Name.StartsWith(".") && (ftpFile.Name == "." || ftpFile.Name == ".."))
                        continue;

                    fileList.Add(new FileInformation
                    {
                        FileName = ftpFile.Name,
                        Length = ftpFile.Size,
                        LastWriteTime = ftpFile.LastModified,
                        LastAccessTime = ftpFile.LastModified,
                        CreationTime = ftpFile.LastModified,
                        Attributes = ftpFile.IsDirectory ? FileAttributes.Directory : FileAttributes.Normal
                    });
                }

                files = fileList;
                
                // Cache the result
                _directoryCache[cacheKey] = new CachedDirectoryInfo
                {
                    Files = fileList,
                    CachedAt = DateTime.UtcNow
                };

                _logger.LogDebug("Found {Count} files in {FtpPath}", files.Count, ftpPath);
                return NtStatus.Success;
            }
            else
            {
                _logger.LogWarning("FTP directory listing timed out for {FtpPath}", ftpPath);
                return NtStatus.IoTimeout;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error finding files in {FileName}", fileName);
            return NtStatus.Error;
        }
    }

    public void CleanupFile(string fileName, IDokanFileInfo info)
    {
        try
        {
            if (_openFiles.TryRemove(fileName, out var stream))
            {
                // Save changes before closing if file was modified
                if (_fileCache.TryGetValue(fileName, out var cached) && cached.IsModified)
                {
                    _ = Task.Run(async () =>
                    {
                        try
                        {
                            stream.Position = 0;
                            await _ftpClient!.UploadFileAsync(fileName, stream);
                            
                            // Save version
                            var content = ((MemoryStream)stream).ToArray();
                            var hash = _versionTracker.CalculateContentHash(content);
                            await _versionTracker.SaveVersionAsync(fileName, content, hash);

                            await _activityLogger.LogActivityAsync(ActivityLog.CreateSuccess(
                                OperationType.Modify, fileName, "File modified and uploaded",
                                _ftpClient.ConnectionInfo?.Username, content.Length));

                            OnFileOperation(new VirtualFileSystemEventArgs
                            {
                                FilePath = fileName,
                                Operation = OperationType.Modify,
                                Success = true
                            });
                        }
                        catch (Exception ex)
                        {
                            _logger.LogError(ex, "Failed to sync modified file {FileName}", fileName);
                            
                            OnFileOperation(new VirtualFileSystemEventArgs
                            {
                                FilePath = fileName,
                                Operation = OperationType.Modify,
                                Success = false,
                                ErrorMessage = ex.Message
                            });
                        }
                    });
                }

                stream.Dispose();
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during cleanup of file {FileName}", fileName);
        }
    }

    public void CloseFile(string fileName, IDokanFileInfo info)
    {
        // File is closed, but cleanup will handle the actual disposal
        _logger.LogDebug("CloseFile called for {FileName}", fileName);
    }

    public NtStatus DeleteFile(string fileName, IDokanFileInfo info)
    {
        try
        {
            // Use timeout for delete operation
            var timeoutTask = Task.Delay(TimeSpan.FromSeconds(10));
            var ftpTask = Task.Run(async () => await _ftpClient!.DeleteFileAsync(NormalizeFtpPath(fileName)));
            
            var completedTask = Task.WaitAny(ftpTask, timeoutTask);
            
            if (completedTask == 0 && ftpTask.IsCompletedSuccessfully)
            {
                var success = ftpTask.Result;
                if (!success)
                    return NtStatus.Error;

                _fileCache.TryRemove(fileName, out _);
                _openFiles.TryRemove(fileName, out var stream);
                stream?.Dispose();

                _ = Task.Run(async () =>
                {
                    await _activityLogger.LogActivityAsync(ActivityLog.CreateSuccess(
                        OperationType.Delete, fileName, "File deleted",
                        _ftpClient.ConnectionInfo?.Username));
                });

                OnFileOperation(new VirtualFileSystemEventArgs
                {
                    FilePath = fileName,
                    Operation = OperationType.Delete,
                    Success = true
                });

                return NtStatus.Success;
            }
            else
            {
                _logger.LogWarning("FTP delete operation timed out for {FileName}", fileName);
                return NtStatus.IoTimeout;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error deleting file {FileName}", fileName);
            return NtStatus.Error;
        }
    }

    public NtStatus MoveFile(string oldName, string newName, bool replace, IDokanFileInfo info)
    {
        try
        {
            // Use timeout for all move operations
            var timeoutTask = Task.Delay(TimeSpan.FromSeconds(30)); // Longer timeout for move operations
            var moveTask = Task.Run(async () =>
            {
                // Download, upload to new location, delete old
                var stream = await _ftpClient!.DownloadFileAsync(NormalizeFtpPath(oldName));
                var uploadSuccess = await _ftpClient.UploadFileAsync(NormalizeFtpPath(newName), stream);
                
                if (uploadSuccess)
                {
                    var deleteSuccess = await _ftpClient.DeleteFileAsync(NormalizeFtpPath(oldName));
                    return new { Stream = stream, UploadSuccess = uploadSuccess, DeleteSuccess = deleteSuccess };
                }
                
                return new { Stream = stream, UploadSuccess = uploadSuccess, DeleteSuccess = false };
            });
            
            var completedTask = Task.WaitAny(moveTask, timeoutTask);
            
            if (completedTask == 0 && moveTask.IsCompletedSuccessfully)
            {
                var result = moveTask.Result;
                
                if (result.UploadSuccess && result.DeleteSuccess)
                {
                    _fileCache.TryRemove(oldName, out _);
                    
                    _ = Task.Run(async () =>
                    {
                        try
                        {
                            // Save version for moved file
                            result.Stream.Position = 0;
                            var content = new byte[result.Stream.Length];
                            await result.Stream.ReadExactlyAsync(content, 0, content.Length);
                            var hash = _versionTracker.CalculateContentHash(content);
                            await _versionTracker.SaveVersionAsync(newName, content, hash);

                            await _activityLogger.LogActivityAsync(ActivityLog.CreateSuccess(
                                OperationType.Move, $"{oldName} -> {newName}", "File moved with versioning",
                                _ftpClient.ConnectionInfo?.Username, result.Stream.Length));
                        }
                        catch (Exception ex)
                        {
                            _logger.LogError(ex, "Failed to version moved file {NewName}", newName);
                            // Still log the move operation even if versioning failed
                            await _activityLogger.LogActivityAsync(ActivityLog.CreateSuccess(
                                OperationType.Move, $"{oldName} -> {newName}", "File moved (versioning failed)",
                                _ftpClient.ConnectionInfo?.Username, result.Stream.Length));
                        }
                    });

                    OnFileOperation(new VirtualFileSystemEventArgs
                    {
                        FilePath = $"{oldName} -> {newName}",
                        Operation = OperationType.Move,
                        Success = true
                    });

                    return NtStatus.Success;
                }
                
                return NtStatus.Error;
            }
            else
            {
                _logger.LogWarning("FTP move operation timed out for {OldName} -> {NewName}", oldName, newName);
                return NtStatus.IoTimeout;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error moving file from {OldName} to {NewName}", oldName, newName);
            
            OnFileOperation(new VirtualFileSystemEventArgs
            {
                FilePath = $"{oldName} -> {newName}",
                Operation = OperationType.Move,
                Success = false,
                ErrorMessage = ex.Message
            });
            
            return NtStatus.Error;
        }
    }

    public NtStatus SetFileAttributes(string fileName, FileAttributes attributes, IDokanFileInfo info)
    {
        // FTP doesn't typically support setting attributes directly
        return NtStatus.Success;
    }

    public NtStatus SetFileTime(string fileName, DateTime? creationTime, DateTime? lastAccessTime,
        DateTime? lastWriteTime, IDokanFileInfo info)
    {
        // FTP doesn't typically support setting file times directly
        return NtStatus.Success;
    }

    public NtStatus GetDiskFreeSpace(out long freeBytesAvailable, out long totalNumberOfBytes,
        out long totalNumberOfFreeBytes, IDokanFileInfo info)
    {
        // Return large values for virtual drive
        freeBytesAvailable = 1024L * 1024L * 1024L * 1024L; // 1TB
        totalNumberOfBytes = 1024L * 1024L * 1024L * 1024L; // 1TB
        totalNumberOfFreeBytes = 1024L * 1024L * 1024L * 1024L; // 1TB
        return NtStatus.Success;
    }

    public NtStatus GetVolumeInformation(out string volumeLabel, out FileSystemFeatures features,
        out string fileSystemName, out uint maximumComponentLength, IDokanFileInfo info)
    {
        volumeLabel = $"FTP Drive ({_ftpClient?.ConnectionInfo?.Host})";
        features = FileSystemFeatures.None;
        fileSystemName = "FTPFS";
        maximumComponentLength = 256;
        return NtStatus.Success;
    }

    public NtStatus GetFileSecurity(string fileName, out FileSystemSecurity? security,
        AccessControlSections sections, IDokanFileInfo info)
    {
        security = null;
        return NtStatus.NotImplemented;
    }

    public NtStatus SetFileSecurity(string fileName, FileSystemSecurity security,
        AccessControlSections sections, IDokanFileInfo info)
    {
        return NtStatus.NotImplemented;
    }

    public NtStatus Mounted(string mountPoint, IDokanFileInfo info)
    {
        _logger.LogInformation("Virtual drive mounted at {MountPoint}", mountPoint);
        return NtStatus.Success;
    }

    public NtStatus Unmounted(IDokanFileInfo info)
    {
        _logger.LogInformation("Virtual drive unmounted");
        return NtStatus.Success;
    }

    public NtStatus FindStreams(string fileName, out IList<FileInformation> streams, IDokanFileInfo info)
    {
        streams = new List<FileInformation>();
        return NtStatus.NotImplemented;
    }

    public void Cleanup(string fileName, IDokanFileInfo info)
    {
        CleanupFile(fileName, info);
    }

    public NtStatus FlushFileBuffers(string fileName, IDokanFileInfo info)
    {
        return NtStatus.Success;
    }

    public NtStatus FindFilesWithPattern(string fileName, string searchPattern, out IList<FileInformation> files, IDokanFileInfo info)
    {
        return FindFiles(fileName, out files, info);
    }

    public NtStatus DeleteDirectory(string fileName, IDokanFileInfo info)
    {
        try
        {
            // Use timeout for directory deletion
            var timeoutTask = Task.Delay(TimeSpan.FromSeconds(10));
            var ftpTask = Task.Run(async () => await _ftpClient!.DeleteFileAsync(NormalizeFtpPath(fileName)));
            
            var completedTask = Task.WaitAny(ftpTask, timeoutTask);
            
            if (completedTask == 0 && ftpTask.IsCompletedSuccessfully)
            {
                var success = ftpTask.Result;
                return success ? NtStatus.Success : NtStatus.Error;
            }
            else
            {
                _logger.LogWarning("FTP directory deletion timed out for {FileName}", fileName);
                return NtStatus.IoTimeout;
            }
        }
        catch
        {
            return NtStatus.Error;
        }
    }

    public NtStatus SetEndOfFile(string fileName, long length, IDokanFileInfo info)
    {
        try
        {
            if (_openFiles.TryGetValue(fileName, out var stream))
            {
                stream.SetLength(length);
                return NtStatus.Success;
            }
            return NtStatus.ObjectNameNotFound;
        }
        catch
        {
            return NtStatus.Error;
        }
    }

    public NtStatus SetAllocationSize(string fileName, long length, IDokanFileInfo info)
    {
        // Not applicable for FTP
        return NtStatus.Success;
    }

    public NtStatus LockFile(string fileName, long offset, long length, IDokanFileInfo info)
    {
        // File locking not supported in FTP
        return NtStatus.NotImplemented;
    }

    public NtStatus UnlockFile(string fileName, long offset, long length, IDokanFileInfo info)
    {
        // File unlocking not supported in FTP
        return NtStatus.NotImplemented;
    }

    #endregion

    #region Helper Methods

    private NtStatus HandleDirectoryOperation(string dirName, FileMode mode, OperationType operation)
    {
        try
        {
            if (mode == FileMode.Create || mode == FileMode.CreateNew)
            {
                // Use timeout for directory creation
                var timeoutTask = Task.Delay(TimeSpan.FromSeconds(10));
                var ftpTask = Task.Run(async () => await _ftpClient!.CreateDirectoryAsync(NormalizeFtpPath(dirName)));
                
                var completedTask = Task.WaitAny(ftpTask, timeoutTask);
                
                if (completedTask == 0 && ftpTask.IsCompletedSuccessfully)
                {
                    var success = ftpTask.Result;
                    return success ? NtStatus.Success : NtStatus.Error;
                }
                else
                {
                    _logger.LogWarning("FTP directory creation timed out for {DirName}", dirName);
                    return NtStatus.IoTimeout;
                }
            }

            return NtStatus.Success;
        }
        catch
        {
            return NtStatus.Error;
        }
    }

    private NtStatus HandleFileOperation(string fileName, FileMode mode, FileAccess access, OperationType operation)
    {
        try
        {
            if (mode == FileMode.Create || mode == FileMode.CreateNew)
            {
                // Create new empty file
                _openFiles[fileName] = new MemoryStream();
                _fileCache[fileName] = new CachedFileInfo
                {
                    Name = Path.GetFileName(fileName),
                    Size = 0,
                    LastModified = DateTime.UtcNow,
                    IsModified = true
                };
            }
            else if (access.HasFlag(FileAccess.ReadData) && !_openFiles.ContainsKey(fileName))
            {
                // Download file for reading with timeout
                try
                {
                    var timeoutTask = Task.Delay(TimeSpan.FromSeconds(15));
                    var ftpTask = Task.Run(async () => await _ftpClient!.DownloadFileAsync(NormalizeFtpPath(fileName)));
                    
                    var completedTask = Task.WaitAny(ftpTask, timeoutTask);
                    
                    if (completedTask == 0 && ftpTask.IsCompletedSuccessfully)
                    {
                        var stream = ftpTask.Result;
                        _openFiles[fileName] = stream;
                    }
                    else
                    {
                        _logger.LogWarning("FTP file download timed out during CreateFile for {FileName}", fileName);
                        return NtStatus.IoTimeout;
                    }
                }
                catch
                {
                    return NtStatus.ObjectNameNotFound;
                }
            }

            return NtStatus.Success;
        }
        catch
        {
            return NtStatus.Error;
        }
    }

    private void OnFileOperation(VirtualFileSystemEventArgs args)
    {
        FileOperation?.Invoke(this, args);
    }

    private void OnMountStatusChanged(bool isMounted, string? driveLetter, string? errorMessage)
    {
        MountStatusChanged?.Invoke(this, new MountStatusEventArgs
        {
            IsMounted = isMounted,
            DriveLetter = driveLetter,
            ErrorMessage = errorMessage
        });
    }

    private static string NormalizeFtpPath(string windowsPath)
    {
        if (string.IsNullOrEmpty(windowsPath) || windowsPath == "\\" || windowsPath == "/")
            return "/";

        // Convert Windows path separators to FTP path separators
        var ftpPath = windowsPath.Replace('\\', '/');
        
        // Ensure path starts with /
        if (!ftpPath.StartsWith("/"))
            ftpPath = "/" + ftpPath;

        // Remove duplicate slashes
        while (ftpPath.Contains("//"))
            ftpPath = ftpPath.Replace("//", "/");

        return ftpPath;
    }

    #endregion

    public void Dispose()
    {
        if (_disposed) return;

        try
        {
            _ = UnmountAsync();
            
            foreach (var stream in _openFiles.Values)
            {
                stream.Dispose();
            }
            _openFiles.Clear();
            _fileCache.Clear();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error disposing virtual file system");
        }

        _disposed = true;
        GC.SuppressFinalize(this);
    }
}

/// <summary>
/// Cached file information for performance
/// </summary>
internal record CachedFileInfo
{
    public string Name { get; init; } = string.Empty;
    public long Size { get; init; }
    public DateTime LastModified { get; init; }
    public bool IsDirectory { get; init; }
    public bool IsModified { get; init; }

    public FileInformation ToFileInformation()
    {
        return new FileInformation
        {
            FileName = Name,
            Length = Size,
            LastWriteTime = LastModified,
            LastAccessTime = LastModified,
            CreationTime = LastModified,
            Attributes = IsDirectory ? FileAttributes.Directory : FileAttributes.Normal
        };
    }
}

/// <summary>
/// Cached directory information for performance
/// </summary>
internal record CachedDirectoryInfo
{
    public IList<FileInformation> Files { get; init; } = new List<FileInformation>();
    public DateTime CachedAt { get; init; }
}
