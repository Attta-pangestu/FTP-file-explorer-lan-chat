using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace FtpVirtualDrive.Core.Interfaces;

/// <summary>
/// Service for managing temporary file downloads and cleanup
/// </summary>
public interface ITempFileService
{
    /// <summary>
    /// Downloads a file from FTP to temporary folder and returns the local path
    /// </summary>
    /// <param name="ftpPath">Remote FTP file path</param>
    /// <param name="cancellationToken">Cancellation token</param>
    /// <returns>Local temporary file path</returns>
    Task<string> DownloadToTempAsync(string ftpPath, CancellationToken cancellationToken = default);
    
    /// <summary>
    /// Opens a file using the default system application
    /// </summary>
    /// <param name="localPath">Local file path</param>
    /// <returns>True if successfully opened</returns>
    Task<bool> OpenFileAsync(string localPath);
    
    /// <summary>
    /// Cleans up temporary files older than specified age
    /// </summary>
    /// <param name="maxAge">Maximum age of files to keep</param>
    /// <returns>Number of files cleaned up</returns>
    Task<int> CleanupTempFilesAsync(TimeSpan maxAge);
    
    /// <summary>
    /// Gets the current temporary folder path for FTP files
    /// </summary>
    string GetTempFolderPath();
    
    /// <summary>
    /// Sets the temporary folder path for FTP files
    /// </summary>
    /// <param name="path">New temporary folder path</param>
    void SetTempFolderPath(string path);
    
    /// <summary>
    /// Gets or sets the temporary folder path for FTP files
    /// </summary>
    string TempFolderPath { get; set; }
    
    /// <summary>
    /// Checks if a file exists in temporary folder
    /// </summary>
    /// <param name="ftpPath">Remote FTP file path</param>
    /// <returns>Local path if exists, null otherwise</returns>
    string? GetCachedTempFile(string ftpPath);
}