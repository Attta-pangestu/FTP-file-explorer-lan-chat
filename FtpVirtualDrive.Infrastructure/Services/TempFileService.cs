using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using FtpVirtualDrive.Core.Interfaces;
using Microsoft.Extensions.Logging;

namespace FtpVirtualDrive.Infrastructure.Services;

/// <summary>
/// Service for managing temporary file downloads and cleanup
/// </summary>
public class TempFileService : ITempFileService
{
    private readonly IFtpClient _ftpClient;
    private readonly ILogger<TempFileService> _logger;
    private string _tempFolderPath;
    private readonly SemaphoreSlim _downloadSemaphore;
    
    public TempFileService(IFtpClient ftpClient, ILogger<TempFileService> logger, string? initialTempPath = null)
    {
        _ftpClient = ftpClient ?? throw new ArgumentNullException(nameof(ftpClient));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        
        // Set initial temp folder path
        _tempFolderPath = initialTempPath ?? Path.Combine(Path.GetTempPath(), "FtpVirtualDrive");
        Directory.CreateDirectory(_tempFolderPath);
        
        // Limit concurrent downloads
        _downloadSemaphore = new SemaphoreSlim(3, 3);
        
        _logger.LogInformation("TempFileService initialized with temp folder: {TempFolder}", _tempFolderPath);
    }
    
    public async Task<string> DownloadToTempAsync(string ftpPath, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(ftpPath))
            throw new ArgumentException("FTP path cannot be null or empty", nameof(ftpPath));
        
        // Generate safe local filename based on FTP path
        var localFileName = GenerateSafeFileName(ftpPath);
        var localPath = Path.Combine(_tempFolderPath, localFileName);
        
        // Check if file already exists and is recent
        if (File.Exists(localPath))
        {
            var fileInfo = new FileInfo(localPath);
            if (DateTime.Now - fileInfo.LastWriteTime < TimeSpan.FromMinutes(30))
            {
                _logger.LogDebug("Using cached temp file: {LocalPath}", localPath);
                return localPath;
            }
        }
        
        await _downloadSemaphore.WaitAsync(cancellationToken);
        
        try
        {
            _logger.LogInformation("Downloading FTP file {FtpPath} to temp location {LocalPath}", ftpPath, localPath);
            
            var stopwatch = Stopwatch.StartNew();
            
            // Download file from FTP
            using var ftpStream = await _ftpClient.DownloadFileAsync(ftpPath);
            using var fileStream = new FileStream(localPath, FileMode.Create, FileAccess.Write);
            await ftpStream.CopyToAsync(fileStream, cancellationToken);
            
            stopwatch.Stop();
            var fileSize = new FileInfo(localPath).Length;
            
            _logger.LogInformation("Downloaded {FileSize} bytes in {ElapsedMs}ms to {LocalPath}", 
                fileSize, stopwatch.ElapsedMilliseconds, localPath);
            
            return localPath;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to download FTP file {FtpPath} to temp location", ftpPath);
            
            // Clean up partial file
            try
            {
                if (File.Exists(localPath))
                    File.Delete(localPath);
            }
            catch (Exception cleanupEx)
            {
                _logger.LogWarning(cleanupEx, "Failed to clean up partial temp file {LocalPath}", localPath);
            }
            
            throw;
        }
        finally
        {
            _downloadSemaphore.Release();
        }
    }
    
    public async Task<bool> OpenFileAsync(string localPath)
    {
        if (string.IsNullOrEmpty(localPath) || !File.Exists(localPath))
        {
            _logger.LogWarning("Cannot open file - path is invalid or file does not exist: {LocalPath}", localPath);
            return false;
        }
        
        try
        {
            _logger.LogInformation("Opening file with default application: {LocalPath}", localPath);
            
            var startInfo = new ProcessStartInfo
            {
                FileName = localPath,
                UseShellExecute = true,
                Verb = "open"
            };
            
            using var process = Process.Start(startInfo);
            
            // Don't wait for the process to exit as it might be a long-running application
            await Task.Delay(100); // Small delay to check if process started successfully
            
            _logger.LogInformation("Successfully opened file: {LocalPath}", localPath);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to open file: {LocalPath}", localPath);
            return false;
        }
    }
    
    public async Task<int> CleanupTempFilesAsync(TimeSpan maxAge)
    {
        if (!Directory.Exists(_tempFolderPath))
            return 0;
        
        var cutoffTime = DateTime.Now - maxAge;
        var cleanedCount = 0;
        
        try
        {
            var files = Directory.GetFiles(_tempFolderPath, "*", SearchOption.AllDirectories);
            
            foreach (var file in files)
            {
                try
                {
                    var fileInfo = new FileInfo(file);
                    if (fileInfo.LastAccessTime < cutoffTime)
                    {
                        File.Delete(file);
                        cleanedCount++;
                        _logger.LogDebug("Cleaned up temp file: {FilePath}", file);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to clean up temp file: {FilePath}", file);
                }
            }
            
            _logger.LogInformation("Cleaned up {CleanedCount} temporary files older than {MaxAge}", cleanedCount, maxAge);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to cleanup temp files in folder: {TempFolder}", _tempFolderPath);
        }
        
        return cleanedCount;
    }
    
    public string GetTempFolderPath() => _tempFolderPath;
    
    public void SetTempFolderPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
            throw new ArgumentException("Temp folder path cannot be null or empty", nameof(path));
        
        try
        {
            // Create the directory if it doesn't exist
            Directory.CreateDirectory(path);
            
            var oldPath = _tempFolderPath;
            _tempFolderPath = path;
            
            _logger.LogInformation("Temp folder path changed from {OldPath} to {NewPath}", oldPath, path);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to set temp folder path to {Path}", path);
            throw new InvalidOperationException($"Failed to set temp folder path: {ex.Message}", ex);
        }
    }
    
    public string TempFolderPath
    {
        get => _tempFolderPath;
        set => SetTempFolderPath(value);
    }
    
    public string? GetCachedTempFile(string ftpPath)
    {
        if (string.IsNullOrEmpty(ftpPath))
            return null;
        
        var localFileName = GenerateSafeFileName(ftpPath);
        var localPath = Path.Combine(_tempFolderPath, localFileName);
        
        return File.Exists(localPath) ? localPath : null;
    }
    
    private string GenerateSafeFileName(string ftpPath)
    {
        // Create a hash of the FTP path to ensure uniqueness
        using var sha256 = SHA256.Create();
        var pathBytes = Encoding.UTF8.GetBytes(ftpPath);
        var hashBytes = sha256.ComputeHash(pathBytes);
        var hashString = Convert.ToHexString(hashBytes)[..16]; // Take first 16 characters
        
        // Get the original filename
        var fileName = Path.GetFileName(ftpPath);
        if (string.IsNullOrEmpty(fileName))
            fileName = "unknown_file";
        
        // Remove invalid characters
        var invalidChars = Path.GetInvalidFileNameChars();
        foreach (var invalidChar in invalidChars)
        {
            fileName = fileName.Replace(invalidChar, '_');
        }
        
        // Combine hash with filename to ensure uniqueness
        var extension = Path.GetExtension(fileName);
        var nameWithoutExt = Path.GetFileNameWithoutExtension(fileName);
        
        return $"{nameWithoutExt}_{hashString}{extension}";
    }
    
    public void Dispose()
    {
        _downloadSemaphore?.Dispose();
    }
}