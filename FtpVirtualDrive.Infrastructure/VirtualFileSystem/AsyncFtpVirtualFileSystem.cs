using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Threading;
using System.Threading.Tasks;
using DokanNet;
using DokanNet.Logging;
using FtpVirtualDrive.Core.Interfaces;
using FtpVirtualDrive.Core.Models;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using FileAccess = DokanNet.FileAccess;

namespace FtpVirtualDrive.Infrastructure.VirtualFileSystem;

/// <summary>
/// Async non-blocking virtual file system implementation
/// Returns immediately with cached/default data and updates in background
/// </summary>
[SupportedOSPlatform("windows")]
public class AsyncFtpVirtualFileSystem : IDokanOperations, IVirtualDrive
{
    private readonly ILogger<AsyncFtpVirtualFileSystem> _logger;
    private readonly IFileSyncService _syncService;
    private readonly IVersionTracker _versionTracker;
    private readonly IActivityLogger _activityLogger;
    private readonly IFileOperationQueue _operationQueue;
    private readonly IMemoryCache _cache;
    
    private IFtpClient? _ftpClient;
    private FtpConnectionInfo? _connectionInfo;
    private string? _mountPoint;
    private DokanInstance? _dokanInstance;
    
    // In-memory file system cache
    private readonly ConcurrentDictionary<string, VirtualFileInfo> _virtualFiles = new();
    private readonly ConcurrentDictionary<string, VirtualDirectoryInfo> _virtualDirectories = new();
    private readonly ConcurrentDictionary<string, byte[]> _fileDataCache = new();
    private bool _disposed;

    public bool IsMounted { get; private set; }
    public string? MountedDriveLetter { get; private set; }
    public string? MountPath { get; private set; }

    public event EventHandler<VirtualFileSystemEventArgs>? FileOperation;
    public event EventHandler<MountStatusEventArgs>? MountStatusChanged;

    public AsyncFtpVirtualFileSystem(
        ILogger<AsyncFtpVirtualFileSystem> logger,
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
            _ftpClient = ftpClient;
            _connectionInfo = ftpClient.ConnectionInfo;
            _mountPoint = driveLetter.ToUpper() + ":";
            MountedDriveLetter = _mountPoint;
            MountPath = MountedDriveLetter + "\\";

            // Pre-fetch root directory synchronously to ensure files are available immediately
            await PrefetchRootDirectoryAsync();

            // Create DokanInstance
            var dokanLogger = new ConsoleLogger("[Dokan] ");
            var dokan = new Dokan(dokanLogger);
            var dokanBuilder = new DokanInstanceBuilder(dokan)
                .ConfigureOptions(options =>
                {
                    options.MountPoint = _mountPoint + "\\";
                    options.Options = DokanOptions.DebugMode | DokanOptions.StderrOutput;
                })
                .ConfigureLogger(() => dokanLogger);

            _dokanInstance = dokanBuilder.Build(this);

            // Start Dokan in background
            _ = Task.Run(async () =>
            {
                try
                {
                    await _dokanInstance.WaitForFileSystemClosedAsync(uint.MaxValue);
                    _logger.LogInformation("Dokan file system has been closed");
                    IsMounted = false;
                    OnMountStatusChanged(false, null, "File system was unmounted");
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error during Dokan mount operation");
                    OnMountStatusChanged(false, null, ex.Message);
                }
            });

            await Task.Delay(500); // Shorter wait
            IsMounted = true;
            
            _logger.LogInformation("Successfully mounted FTP as virtual drive {DriveLetter}", MountedDriveLetter);
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
            _dokanInstance?.Dispose();
            _dokanInstance = null;
            
            _virtualFiles.Clear();
            _virtualDirectories.Clear();
            _fileDataCache.Clear();
            
            IsMounted = false;
            MountedDriveLetter = null;
            MountPath = null;
            
            _logger.LogInformation("Successfully unmounted virtual drive");
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

    #region IDokanOperations - Non-blocking implementations

    public NtStatus CreateFile(string fileName, FileAccess access, FileShare share, FileMode mode,
        FileOptions options, FileAttributes attributes, IDokanFileInfo info)
    {
        try
        {
            _logger.LogDebug("CreateFile: {FileName}, Mode: {Mode}, Access: {Access}, IsDirectory: {IsDir}", 
                fileName, mode, access, info.IsDirectory);

            // Handle root directory
            if (string.IsNullOrEmpty(fileName) || fileName == "\\")
            {
                info.IsDirectory = true;
                return NtStatus.Success;
            }

            var normalizedPath = NormalizePath(fileName);

            // Handle directories
            if (info.IsDirectory || _virtualDirectories.ContainsKey(normalizedPath))
            {
                info.IsDirectory = true;
                if (mode == FileMode.CreateNew || mode == FileMode.Create)
                {
                    _virtualDirectories[normalizedPath] = new VirtualDirectoryInfo
                    {
                        Name = Path.GetFileName(fileName),
                        Path = normalizedPath,
                        LastModified = DateTime.UtcNow
                    };
                    
                    // Create directory on FTP
                    _ = _operationQueue.EnqueueAsync(async ct =>
                    {
                        try
                        {
                            var ftpPath = NormalizeFtpPath(fileName);
                            await _ftpClient!.CreateDirectoryAsync(ftpPath);
                            _logger.LogInformation("Created directory {Path} on FTP", ftpPath);
                        }
                        catch (Exception ex)
                        {
                            _logger.LogError(ex, "Failed to create directory {FileName} on FTP", fileName);
                        }
                    });
                }
                return NtStatus.Success;
            }
            
            // For existing files being opened for reading, ensure content is downloaded
            if (mode == FileMode.Open && (access & FileAccess.ReadData) != 0)
            {
                // Check if file exists in virtual cache
                if (_virtualFiles.ContainsKey(normalizedPath))
                {
                    // If we don't have the content yet, download it now
                    if (!_fileDataCache.ContainsKey(normalizedPath))
                    {
                        _logger.LogInformation("Downloading file content for {FileName}", fileName);
                        
                        try
                        {
                            var ftpPath = NormalizeFtpPath(fileName);
                            
                            // Download synchronously with timeout
                            var downloadTask = Task.Run(async () =>
                            {
                                try
                                {
                                    var stream = await _ftpClient!.DownloadFileAsync(ftpPath);
                                    using var ms = new MemoryStream();
                                    await stream.CopyToAsync(ms);
                                    return ms.ToArray();
                                }
                                catch (Exception ex)
                                {
                                    _logger.LogError(ex, "Error downloading from FTP: {Path}", ftpPath);
                                    throw;
                                }
                            });
                            
                            if (downloadTask.Wait(TimeSpan.FromSeconds(30))) // Increased timeout
                            {
                                var data = downloadTask.Result;
                                _fileDataCache[normalizedPath] = data;
                                
                                // Update file info with actual size
                                if (_virtualFiles.TryGetValue(normalizedPath, out var vf))
                                {
                                    vf.Size = data.Length;
                                    vf.IsPending = false;
                                }
                                
                                _logger.LogInformation("Downloaded {Bytes} bytes for {FileName}", data.Length, fileName);
                            }
                            else
                            {
                                _logger.LogWarning("Timeout downloading file {Path}", ftpPath);
                                // Still allow opening with empty content
                                _fileDataCache[normalizedPath] = new byte[0];
                            }
                        }
                        catch (Exception ex)
                        {
                            _logger.LogError(ex, "Failed to download file {FileName}", fileName);
                            // Allow opening with empty content on error
                            _fileDataCache[normalizedPath] = new byte[0];
                        }
                    }
                    return NtStatus.Success;
                }
                
                // File not in cache - might not exist
                _logger.LogWarning("File not found in cache: {FileName}", fileName);
                return NtStatus.ObjectNameNotFound;
            }

            // Handle file creation
            if (mode == FileMode.Create || mode == FileMode.CreateNew || mode == FileMode.OpenOrCreate)
            {
                _logger.LogDebug("Creating new file: {FileName}", fileName);
                
                // Create virtual file immediately
                _virtualFiles[normalizedPath] = new VirtualFileInfo
                {
                    Name = Path.GetFileName(fileName),
                    Path = normalizedPath,
                    Size = 0,
                    LastModified = DateTime.UtcNow,
                    IsNew = true
                };
                _fileDataCache[normalizedPath] = new byte[0];
                return NtStatus.Success;
            }

            // For Append or other operations on existing files
            if (_virtualFiles.ContainsKey(normalizedPath))
            {
                _logger.LogDebug("File exists in cache: {FileName}", fileName);
                return NtStatus.Success;
            }

            _logger.LogWarning("File operation on unknown file: {FileName}, Mode: {Mode}", fileName, mode);
            return NtStatus.ObjectNameNotFound;
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
            var normalizedPath = NormalizePath(fileName);
            
            // Return cached data immediately if available
            if (_fileDataCache.TryGetValue(normalizedPath, out var data))
            {
                if (data != null && offset < data.Length)
                {
                    bytesRead = Math.Min(buffer.Length, data.Length - (int)offset);
                    Array.Copy(data, offset, buffer, 0, bytesRead);
                }
                return NtStatus.Success;
            }

            // Return empty for now, data will be loaded in background
            return NtStatus.Success;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error reading file {FileName}", fileName);
            return NtStatus.Error;
        }
    }

    public NtStatus WriteFile(string fileName, byte[] buffer, out int bytesWritten, long offset, IDokanFileInfo info)
    {
        bytesWritten = buffer.Length;

        try
        {
            var normalizedPath = NormalizePath(fileName);
            
            _logger.LogDebug("WriteFile: {FileName}, Offset: {Offset}, Length: {Length}", fileName, offset, buffer.Length);
            
            // Update cache immediately
            if (!_fileDataCache.TryGetValue(normalizedPath, out var data))
            {
                data = new byte[offset + buffer.Length];
            }
            else if (data.Length < offset + buffer.Length)
            {
                var newData = new byte[offset + buffer.Length];
                Array.Copy(data, newData, data.Length);
                data = newData;
            }

            Array.Copy(buffer, 0, data, offset, buffer.Length);
            _fileDataCache[normalizedPath] = data;

            // Update virtual file info
            if (_virtualFiles.TryGetValue(normalizedPath, out var vFile))
            {
                vFile.Size = data.Length;
                vFile.LastModified = DateTime.UtcNow;
                vFile.IsModified = true;
            }
            else
            {
                _virtualFiles[normalizedPath] = new VirtualFileInfo
                {
                    Name = Path.GetFileName(fileName),
                    Path = normalizedPath,
                    Size = data.Length,
                    LastModified = DateTime.UtcNow,
                    IsModified = true
                };
            }

            // Don't upload on every write - wait for cleanup/close
            return NtStatus.Success;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error writing file {FileName}", fileName);
            return NtStatus.Error;
        }
    }

    public NtStatus GetFileInformation(string fileName, out FileInformation fileInfo, IDokanFileInfo info)
    {
        fileInfo = new FileInformation();

        try
        {
            // Handle root directory
            if (string.IsNullOrEmpty(fileName) || fileName == "\\" || fileName == "/")
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

            var normalizedPath = NormalizePath(fileName);
            
            // Check virtual files
            if (_virtualFiles.TryGetValue(normalizedPath, out var vFile))
            {
                fileInfo = new FileInformation
                {
                    FileName = vFile.Name,
                    Length = vFile.Size,
                    LastWriteTime = vFile.LastModified,
                    LastAccessTime = vFile.LastModified,
                    CreationTime = vFile.LastModified,
                    Attributes = FileAttributes.Normal
                };
                return NtStatus.Success;
            }

            // Check virtual directories
            if (_virtualDirectories.TryGetValue(normalizedPath, out var vDir))
            {
                fileInfo = new FileInformation
                {
                    FileName = vDir.Name,
                    Length = 0,
                    LastWriteTime = vDir.LastModified,
                    LastAccessTime = vDir.LastModified,
                    CreationTime = vDir.LastModified,
                    Attributes = FileAttributes.Directory
                };
                return NtStatus.Success;
            }

            // Return default for unknown files - will be updated in background
            fileInfo = new FileInformation
            {
                FileName = Path.GetFileName(fileName),
                Length = 0,
                LastWriteTime = DateTime.UtcNow,
                LastAccessTime = DateTime.UtcNow,
                CreationTime = DateTime.UtcNow,
                Attributes = FileAttributes.Normal
            };

            // Fetch actual info in background
            _ = _operationQueue.EnqueueAsync(async ct =>
            {
                try
                {
                    var ftpInfo = await _ftpClient!.GetFileInfoAsync(NormalizeFtpPath(fileName));
                    if (ftpInfo != null)
                    {
                        if (ftpInfo.IsDirectory)
                        {
                            _virtualDirectories[normalizedPath] = new VirtualDirectoryInfo
                            {
                                Name = ftpInfo.Name,
                                Path = normalizedPath,
                                LastModified = ftpInfo.LastModified
                            };
                        }
                        else
                        {
                            _virtualFiles[normalizedPath] = new VirtualFileInfo
                            {
                                Name = ftpInfo.Name,
                                Path = normalizedPath,
                                Size = ftpInfo.Size,
                                LastModified = ftpInfo.LastModified
                            };
                        }
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogDebug(ex, "Failed to get file info for {FileName}", fileName);
                }
            });

            return NtStatus.Success;
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
            var normalizedPath = NormalizePath(fileName);
            var cacheKey = $"dir_{normalizedPath}";
            
            _logger.LogDebug("FindFiles called for: {Path}, normalized: {NormalizedPath}", fileName, normalizedPath);
            
            // Return cached directory listing if available
            if (_cache.TryGetValue<List<FileInformation>>(cacheKey, out var cached))
            {
                _logger.LogDebug("Returning cached listing for {Path} with {Count} items", normalizedPath, cached.Count);
                files = cached;
                return NtStatus.Success;
            }

            // Build list from virtual cache first
            files = new List<FileInformation>
            {
                new FileInformation
                {
                    FileName = ".",
                    Attributes = FileAttributes.Directory,
                    LastWriteTime = DateTime.UtcNow
                },
                new FileInformation
                {
                    FileName = "..",
                    Attributes = FileAttributes.Directory,
                    LastWriteTime = DateTime.UtcNow
                }
            };

            // Add any already-cached virtual files/directories for this path
            var dirPrefix = normalizedPath.TrimEnd('\\') + "\\";
            
            foreach (var vFile in _virtualFiles.Values)
            {
                if (vFile.Path.StartsWith(dirPrefix) && 
                    vFile.Path.LastIndexOf('\\') == dirPrefix.Length - 1)
                {
                    files.Add(new FileInformation
                    {
                        FileName = vFile.Name,
                        Length = vFile.Size,
                        LastWriteTime = vFile.LastModified,
                        LastAccessTime = vFile.LastModified,
                        CreationTime = vFile.LastModified,
                        Attributes = FileAttributes.Normal
                    });
                }
            }
            
            foreach (var vDir in _virtualDirectories.Values)
            {
                if (vDir.Path.StartsWith(dirPrefix) && 
                    vDir.Path.LastIndexOf('\\') == dirPrefix.Length - 1)
                {
                    files.Add(new FileInformation
                    {
                        FileName = vDir.Name,
                        Length = 0,
                        LastWriteTime = vDir.LastModified,
                        LastAccessTime = vDir.LastModified,
                        CreationTime = vDir.LastModified,
                        Attributes = FileAttributes.Directory
                    });
                }
            }

            // Fetch actual listing in background and update cache
            _ = _operationQueue.EnqueueAsync(async ct =>
            {
                try
                {
                    var ftpPath = NormalizeFtpPath(fileName);
                    var ftpFiles = await _ftpClient!.ListDirectoryAsync(ftpPath);
                    var fileList = new List<FileInformation>
                    {
                        new FileInformation
                        {
                            FileName = ".",
                            Attributes = FileAttributes.Directory,
                            LastWriteTime = DateTime.UtcNow
                        },
                        new FileInformation
                        {
                            FileName = "..",
                            Attributes = FileAttributes.Directory,
                            LastWriteTime = DateTime.UtcNow
                        }
                    };

                    foreach (var ftpFile in ftpFiles)
                    {
                        if (ftpFile.Name == "." || ftpFile.Name == "..") 
                            continue;

                        var itemPath = normalizedPath.TrimEnd('\\') + "\\" + ftpFile.Name.ToLowerInvariant();
                        
                        fileList.Add(new FileInformation
                        {
                            FileName = ftpFile.Name,
                            Length = ftpFile.Size,
                            LastWriteTime = ftpFile.LastModified,
                            LastAccessTime = ftpFile.LastModified,
                            CreationTime = ftpFile.LastModified,
                            Attributes = ftpFile.IsDirectory ? FileAttributes.Directory : FileAttributes.Normal
                        });

                        // Update virtual cache
                        if (ftpFile.IsDirectory)
                        {
                            _virtualDirectories[itemPath] = new VirtualDirectoryInfo
                            {
                                Name = ftpFile.Name,
                                Path = itemPath,
                                LastModified = ftpFile.LastModified
                            };
                        }
                        else
                        {
                            _virtualFiles[itemPath] = new VirtualFileInfo
                            {
                                Name = ftpFile.Name,
                                Path = itemPath,
                                Size = ftpFile.Size,
                                LastModified = ftpFile.LastModified
                            };
                        }
                    }

                    // Cache the result with both . and .. entries
                    _cache.Set(cacheKey, fileList, TimeSpan.FromMinutes(1));
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to list directory {Path}", fileName);
                }
            });

            return NtStatus.Success;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error finding files in {FileName}", fileName);
            return NtStatus.Error;
        }
    }

    public void CleanupFile(string fileName, IDokanFileInfo info)
    {
        // Upload modified files to FTP
        var normalizedPath = NormalizePath(fileName);
        
        if (_virtualFiles.TryGetValue(normalizedPath, out var vFile) && (vFile.IsModified || vFile.IsNew))
        {
            if (_fileDataCache.TryGetValue(normalizedPath, out var data))
            {
                _logger.LogDebug("Uploading modified file {FileName} to FTP", fileName);
                
                _ = _operationQueue.EnqueueAsync(async ct =>
                {
                    try
                    {
                        using var stream = new MemoryStream(data);
                        await _ftpClient!.UploadFileAsync(NormalizeFtpPath(fileName), stream);
                        _logger.LogInformation("Successfully uploaded {FileName} to FTP", fileName);
                        vFile.IsModified = false;
                        vFile.IsNew = false;
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "Failed to upload file {FileName} to FTP", fileName);
                    }
                });
            }
        }
    }

    public void CloseFile(string fileName, IDokanFileInfo info)
    {
        // Nothing to do - cleanup handles it
    }

    public NtStatus DeleteFile(string fileName, IDokanFileInfo info)
    {
        try
        {
            var normalizedPath = NormalizePath(fileName);
            
            // Remove from cache immediately
            _virtualFiles.TryRemove(normalizedPath, out _);
            _fileDataCache.TryRemove(normalizedPath, out _);

            // Queue deletion in background
            _ = _operationQueue.EnqueueAsync(async ct =>
            {
                try
                {
                    await _ftpClient!.DeleteFileAsync(NormalizeFtpPath(fileName));
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to delete file {FileName}", fileName);
                }
            });

            return NtStatus.Success;
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
            var oldPath = NormalizePath(oldName);
            var newPath = NormalizePath(newName);

            // Move in cache immediately
            if (_virtualFiles.TryRemove(oldPath, out var vFile))
            {
                vFile.Path = newPath;
                vFile.Name = Path.GetFileName(newName);
                _virtualFiles[newPath] = vFile;
            }

            if (_fileDataCache.TryRemove(oldPath, out var data))
            {
                _fileDataCache[newPath] = data;
            }

            // Queue FTP move in background
            _ = _operationQueue.EnqueueAsync(async ct =>
            {
                try
                {
                    var stream = await _ftpClient!.DownloadFileAsync(NormalizeFtpPath(oldName));
                    await _ftpClient.UploadFileAsync(NormalizeFtpPath(newName), stream);
                    await _ftpClient.DeleteFileAsync(NormalizeFtpPath(oldName));
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to move file from {OldName} to {NewName}", oldName, newName);
                }
            });

            return NtStatus.Success;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error moving file from {OldName} to {NewName}", oldName, newName);
            return NtStatus.Error;
        }
    }

    #endregion

    #region Unchanged IDokanOperations methods

    public NtStatus SetFileAttributes(string fileName, FileAttributes attributes, IDokanFileInfo info)
        => NtStatus.Success;

    public NtStatus SetFileTime(string fileName, DateTime? creationTime, DateTime? lastAccessTime,
        DateTime? lastWriteTime, IDokanFileInfo info)
        => NtStatus.Success;

    public NtStatus GetDiskFreeSpace(out long freeBytesAvailable, out long totalNumberOfBytes,
        out long totalNumberOfFreeBytes, IDokanFileInfo info)
    {
        freeBytesAvailable = 1024L * 1024L * 1024L * 1024L; // 1TB
        totalNumberOfBytes = 1024L * 1024L * 1024L * 1024L;
        totalNumberOfFreeBytes = 1024L * 1024L * 1024L * 1024L;
        return NtStatus.Success;
    }

    public NtStatus GetVolumeInformation(out string volumeLabel, out FileSystemFeatures features,
        out string fileSystemName, out uint maximumComponentLength, IDokanFileInfo info)
    {
        volumeLabel = $"FTP Drive ({_connectionInfo?.Host})";
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
        => NtStatus.NotImplemented;

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
        => CleanupFile(fileName, info);

    public NtStatus FlushFileBuffers(string fileName, IDokanFileInfo info)
        => NtStatus.Success;

    public NtStatus FindFilesWithPattern(string fileName, string searchPattern, 
        out IList<FileInformation> files, IDokanFileInfo info)
        => FindFiles(fileName, out files, info);

    public NtStatus DeleteDirectory(string fileName, IDokanFileInfo info)
    {
        var normalizedPath = NormalizePath(fileName);
        _virtualDirectories.TryRemove(normalizedPath, out _);
        
        _ = _operationQueue.EnqueueAsync(async ct =>
        {
            try
            {
                await _ftpClient!.DeleteFileAsync(NormalizeFtpPath(fileName));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to delete directory {FileName}", fileName);
            }
        });
        
        return NtStatus.Success;
    }

    public NtStatus SetEndOfFile(string fileName, long length, IDokanFileInfo info)
    {
        var normalizedPath = NormalizePath(fileName);
        if (_fileDataCache.TryGetValue(normalizedPath, out var data))
        {
            var newData = new byte[length];
            Array.Copy(data, newData, Math.Min(data.Length, length));
            _fileDataCache[normalizedPath] = newData;
        }
        return NtStatus.Success;
    }

    public NtStatus SetAllocationSize(string fileName, long length, IDokanFileInfo info)
        => NtStatus.Success;

    public NtStatus LockFile(string fileName, long offset, long length, IDokanFileInfo info)
        => NtStatus.NotImplemented;

    public NtStatus UnlockFile(string fileName, long offset, long length, IDokanFileInfo info)
        => NtStatus.NotImplemented;

    #endregion

    #region Helper Methods

    private async Task PrefetchRootDirectoryAsync()
    {
        try
        {
            _logger.LogInformation("Pre-fetching root directory...");
            var files = await _ftpClient!.ListDirectoryAsync("/");
            
            var rootItems = new List<FileInformation>
            {
                new FileInformation
                {
                    FileName = ".",
                    Attributes = FileAttributes.Directory,
                    LastWriteTime = DateTime.UtcNow
                },
                new FileInformation
                {
                    FileName = "..",
                    Attributes = FileAttributes.Directory,
                    LastWriteTime = DateTime.UtcNow
                }
            };
            
            foreach (var file in files)
            {
                if (file.Name == "." || file.Name == "..") continue;
                
                var path = "\\" + file.Name.ToLowerInvariant();
                
                if (file.IsDirectory)
                {
                    _virtualDirectories[path] = new VirtualDirectoryInfo
                    {
                        Name = file.Name,
                        Path = path,
                        LastModified = file.LastModified
                    };
                }
                else
                {
                    _virtualFiles[path] = new VirtualFileInfo
                    {
                        Name = file.Name,
                        Path = path,
                        Size = file.Size,
                        LastModified = file.LastModified
                    };
                }
                
                rootItems.Add(new FileInformation
                {
                    FileName = file.Name,
                    Length = file.Size,
                    LastWriteTime = file.LastModified,
                    LastAccessTime = file.LastModified,
                    CreationTime = file.LastModified,
                    Attributes = file.IsDirectory ? FileAttributes.Directory : FileAttributes.Normal
                });
            }
            
            // Cache root directory listing
            _cache.Set("dir_\\", rootItems, TimeSpan.FromMinutes(5));
            
            _logger.LogInformation("Pre-fetched {Count} items", files.Count());
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to pre-fetch root directory");
        }
    }

    private static string NormalizePath(string path)
    {
        if (string.IsNullOrEmpty(path)) return "\\";
        path = path.Replace('/', '\\');
        if (!path.StartsWith("\\")) path = "\\" + path;
        return path.TrimEnd('\\').ToLowerInvariant();
    }

    private static string NormalizeFtpPath(string windowsPath)
    {
        if (string.IsNullOrEmpty(windowsPath) || windowsPath == "\\" || windowsPath == "/")
            return "/";
        
        var ftpPath = windowsPath.Replace('\\', '/');
        if (!ftpPath.StartsWith("/")) ftpPath = "/" + ftpPath;
        
        while (ftpPath.Contains("//"))
            ftpPath = ftpPath.Replace("//", "/");
        
        return ftpPath;
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

    #endregion

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

    public void Dispose()
    {
        if (_disposed) return;
        
        _ = UnmountAsync();
        _disposed = true;
        GC.SuppressFinalize(this);
    }

    #region Internal Classes

    private class VirtualFileInfo
    {
        public string Name { get; set; } = "";
        public string Path { get; set; } = "";
        public long Size { get; set; }
        public DateTime LastModified { get; set; }
        public bool IsNew { get; set; }
        public bool IsModified { get; set; }
        public bool IsPending { get; set; }
        public bool IsReadOnly { get; set; }
    }

    private class VirtualDirectoryInfo
    {
        public string Name { get; set; } = "";
        public string Path { get; set; } = "";
        public DateTime LastModified { get; set; }
    }

    #endregion
}
