using FtpVirtualDrive.Core.Models;

namespace FtpVirtualDrive.Core.Interfaces;

/// <summary>
/// Defines the contract for FTP client operations
/// </summary>
public interface IFtpClient : IDisposable
{
    /// <summary>
    /// Gets a value indicating whether the client is currently connected
    /// </summary>
    bool IsConnected { get; }

    /// <summary>
    /// Gets the current connection information
    /// </summary>
    FtpConnectionInfo? ConnectionInfo { get; }

    /// <summary>
    /// Establishes a connection to the FTP server
    /// </summary>
    /// <param name="connectionInfo">Connection parameters</param>
    /// <returns>True if connection was successful</returns>
    Task<bool> ConnectAsync(FtpConnectionInfo connectionInfo);

    /// <summary>
    /// Disconnects from the FTP server
    /// </summary>
    /// <returns>True if disconnection was successful</returns>
    Task<bool> DisconnectAsync();

    /// <summary>
    /// Downloads a file from the FTP server
    /// </summary>
    /// <param name="remotePath">Remote file path</param>
    /// <returns>File content as stream</returns>
    Task<Stream> DownloadFileAsync(string remotePath);

    /// <summary>
    /// Uploads a file to the FTP server
    /// </summary>
    /// <param name="remotePath">Remote file path</param>
    /// <param name="content">File content</param>
    /// <returns>True if upload was successful</returns>
    Task<bool> UploadFileAsync(string remotePath, Stream content);

    /// <summary>
    /// Deletes a file from the FTP server
    /// </summary>
    /// <param name="remotePath">Remote file path</param>
    /// <returns>True if deletion was successful</returns>
    Task<bool> DeleteFileAsync(string remotePath);

    /// <summary>
    /// Lists files and directories in the specified remote path
    /// </summary>
    /// <param name="remotePath">Remote directory path</param>
    /// <returns>Collection of file and directory information</returns>
    Task<IEnumerable<FtpFileInfo>> ListDirectoryAsync(string remotePath);

    /// <summary>
    /// Creates a directory on the FTP server
    /// </summary>
    /// <param name="remotePath">Remote directory path</param>
    /// <returns>True if creation was successful</returns>
    Task<bool> CreateDirectoryAsync(string remotePath);

    /// <summary>
    /// Checks if a file exists on the FTP server
    /// </summary>
    /// <param name="remotePath">Remote file path</param>
    /// <returns>True if file exists</returns>
    Task<bool> FileExistsAsync(string remotePath);

    /// <summary>
    /// Gets file information from the FTP server
    /// </summary>
    /// <param name="remotePath">Remote file path</param>
    /// <returns>File information</returns>
    Task<FtpFileInfo?> GetFileInfoAsync(string remotePath);

    /// <summary>
    /// Event fired when an FTP operation is completed
    /// </summary>
    event EventHandler<FtpOperationEventArgs>? OperationCompleted;
}
