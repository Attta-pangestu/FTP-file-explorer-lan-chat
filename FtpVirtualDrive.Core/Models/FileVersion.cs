using System.ComponentModel.DataAnnotations;

namespace FtpVirtualDrive.Core.Models;

/// <summary>
/// Represents a version of a file
/// </summary>
public class FileVersion
{
    /// <summary>
    /// Unique identifier for the file version
    /// </summary>
    public int Id { get; set; }

    /// <summary>
    /// File path this version belongs to
    /// </summary>
    [Required]
    public string FilePath { get; set; } = string.Empty;

    /// <summary>
    /// Version number (incremental)
    /// </summary>
    public int VersionNumber { get; set; }

    /// <summary>
    /// Hash of the file content for deduplication
    /// </summary>
    [Required]
    public string ContentHash { get; set; } = string.Empty;

    /// <summary>
    /// Size of the file in bytes
    /// </summary>
    public long FileSize { get; set; }

    /// <summary>
    /// File content (stored as binary data)
    /// </summary>
    public byte[] Content { get; set; } = Array.Empty<byte>();

    /// <summary>
    /// When this version was created
    /// </summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// Optional comment or description for this version
    /// </summary>
    public string? Comment { get; set; }

    /// <summary>
    /// Username who created this version
    /// </summary>
    public string? CreatedBy { get; set; }

    /// <summary>
    /// Whether this version is marked as important (won't be auto-deleted)
    /// </summary>
    public bool IsImportant { get; set; }

    /// <summary>
    /// Source of the version (Manual, AutoSync, etc.)
    /// </summary>
    public VersionSource Source { get; set; } = VersionSource.AutoSync;

    /// <summary>
    /// Gets the display name for this version
    /// </summary>
    public string DisplayName => $"Version {VersionNumber} ({CreatedAt:yyyy-MM-dd HH:mm:ss})";

    /// <summary>
    /// Gets the file size in a human-readable format
    /// </summary>
    public string FileSizeFormatted
    {
        get
        {
            string[] sizes = { "B", "KB", "MB", "GB" };
            double len = FileSize;
            int order = 0;
            while (len >= 1024 && order < sizes.Length - 1)
            {
                order++;
                len = len / 1024;
            }
            return $"{len:0.##} {sizes[order]}";
        }
    }
}

/// <summary>
/// Source of a file version
/// </summary>
public enum VersionSource
{
    /// <summary>
    /// Automatically created during sync
    /// </summary>
    AutoSync,
    
    /// <summary>
    /// Manually created by user
    /// </summary>
    Manual,
    
    /// <summary>
    /// Created during conflict resolution
    /// </summary>
    ConflictResolution,
    
    /// <summary>
    /// Initial version when file was first accessed
    /// </summary>
    Initial
}
