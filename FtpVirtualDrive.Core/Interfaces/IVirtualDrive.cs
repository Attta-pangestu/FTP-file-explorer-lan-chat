using FtpVirtualDrive.Core.Models;

namespace FtpVirtualDrive.Core.Interfaces;

/// <summary>
/// Defines the contract for virtual drive operations
/// </summary>
public interface IVirtualDrive : IDisposable
{
    /// <summary>
    /// Gets a value indicating whether the drive is currently mounted
    /// </summary>
    bool IsMounted { get; }

    /// <summary>
    /// Gets the mounted drive letter (e.g., "Z:")
    /// </summary>
    string? MountedDriveLetter { get; }

    /// <summary>
    /// Gets the mount point path
    /// </summary>
    string? MountPath { get; }

    /// <summary>
    /// Mounts the FTP server as a virtual drive
    /// </summary>
    /// <param name="driveLetter">Preferred drive letter (e.g., "Z")</param>
    /// <param name="ftpClient">FTP client for file operations</param>
    /// <returns>True if mounting was successful</returns>
    Task<bool> MountAsync(string driveLetter, IFtpClient ftpClient);

    /// <summary>
    /// Unmounts the virtual drive
    /// </summary>
    /// <returns>True if unmounting was successful</returns>
    Task<bool> UnmountAsync();

    /// <summary>
    /// Gets the available drive letters
    /// </summary>
    /// <returns>Collection of available drive letters</returns>
    Task<IEnumerable<string>> GetAvailableDriveLettersAsync();

    /// <summary>
    /// Event fired when a file operation occurs on the virtual drive
    /// </summary>
    event EventHandler<VirtualFileSystemEventArgs>? FileOperation;

    /// <summary>
    /// Event fired when the mount status changes
    /// </summary>
    event EventHandler<MountStatusEventArgs>? MountStatusChanged;
}
