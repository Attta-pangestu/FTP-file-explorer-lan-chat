using FtpVirtualDrive.Core.Models;

namespace FtpVirtualDrive.Core.Interfaces;

/// <summary>
/// Defines the contract for file version tracking operations
/// </summary>
public interface IVersionTracker
{
    /// <summary>
    /// Saves a new version of a file
    /// </summary>
    /// <param name="filePath">File path</param>
    /// <param name="content">File content</param>
    /// <param name="contentHash">Content hash for deduplication</param>
    /// <returns>The created file version</returns>
    Task<FileVersion> SaveVersionAsync(string filePath, byte[] content, string contentHash);

    /// <summary>
    /// Gets all versions for a specific file
    /// </summary>
    /// <param name="filePath">File path</param>
    /// <returns>Collection of file versions</returns>
    Task<IEnumerable<FileVersion>> GetVersionsAsync(string filePath);

    /// <summary>
    /// Gets the content of a specific file version
    /// </summary>
    /// <param name="filePath">File path</param>
    /// <param name="versionId">Version ID</param>
    /// <returns>File content</returns>
    Task<byte[]?> GetVersionContentAsync(string filePath, int versionId);

    /// <summary>
    /// Gets the latest version of a file
    /// </summary>
    /// <param name="filePath">File path</param>
    /// <returns>Latest file version or null if not found</returns>
    Task<FileVersion?> GetLatestVersionAsync(string filePath);

    /// <summary>
    /// Rolls back a file to a specific version
    /// </summary>
    /// <param name="filePath">File path</param>
    /// <param name="versionId">Version ID to rollback to</param>
    /// <returns>True if rollback was successful</returns>
    Task<bool> RollbackToVersionAsync(string filePath, int versionId);

    /// <summary>
    /// Deletes old versions to save space (keeps specified number of recent versions)
    /// </summary>
    /// <param name="filePath">File path</param>
    /// <param name="versionsToKeep">Number of versions to keep</param>
    /// <returns>Number of versions deleted</returns>
    Task<int> CleanupOldVersionsAsync(string filePath, int versionsToKeep = 10);

    /// <summary>
    /// Calculates the hash of file content
    /// </summary>
    /// <param name="content">File content</param>
    /// <returns>Content hash</returns>
    string CalculateContentHash(byte[] content);
}
