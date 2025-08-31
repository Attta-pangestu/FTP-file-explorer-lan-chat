using System.ComponentModel.DataAnnotations;

namespace FtpVirtualDrive.Core.Models;

/// <summary>
/// Represents an activity log entry
/// </summary>
public class ActivityLog
{
    /// <summary>
    /// Unique identifier for the log entry
    /// </summary>
    public int Id { get; set; }

    /// <summary>
    /// Timestamp when the activity occurred
    /// </summary>
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// Type of operation performed
    /// </summary>
    [Required]
    public OperationType Operation { get; set; }

    /// <summary>
    /// File or directory path involved in the operation
    /// </summary>
    [Required]
    public string FilePath { get; set; } = string.Empty;

    /// <summary>
    /// Additional details about the operation
    /// </summary>
    public string? Details { get; set; }

    /// <summary>
    /// Size of the file involved (if applicable)
    /// </summary>
    public long? FileSize { get; set; }

    /// <summary>
    /// Username who performed the operation
    /// </summary>
    public string? UserName { get; set; }

    /// <summary>
    /// Whether the operation was successful
    /// </summary>
    public bool Success { get; set; } = true;

    /// <summary>
    /// Error message if the operation failed
    /// </summary>
    public string? ErrorMessage { get; set; }

    /// <summary>
    /// Duration of the operation in milliseconds
    /// </summary>
    public long? DurationMs { get; set; }

    /// <summary>
    /// Source IP address (for remote operations)
    /// </summary>
    public string? SourceIp { get; set; }

    /// <summary>
    /// Session identifier
    /// </summary>
    public string? SessionId { get; set; }

    /// <summary>
    /// Creates a log entry for a successful operation
    /// </summary>
    /// <param name="operation">Operation type</param>
    /// <param name="filePath">File path</param>
    /// <param name="details">Additional details</param>
    /// <param name="userName">User name</param>
    /// <param name="fileSize">File size</param>
    /// <returns>Activity log entry</returns>
    public static ActivityLog CreateSuccess(
        OperationType operation, 
        string filePath, 
        string? details = null, 
        string? userName = null, 
        long? fileSize = null)
    {
        return new ActivityLog
        {
            Operation = operation,
            FilePath = filePath,
            Details = details,
            UserName = userName,
            FileSize = fileSize,
            Success = true
        };
    }

    /// <summary>
    /// Creates a log entry for a failed operation
    /// </summary>
    /// <param name="operation">Operation type</param>
    /// <param name="filePath">File path</param>
    /// <param name="errorMessage">Error message</param>
    /// <param name="userName">User name</param>
    /// <returns>Activity log entry</returns>
    public static ActivityLog Failure(
        OperationType operation, 
        string filePath, 
        string errorMessage, 
        string? userName = null)
    {
        return new ActivityLog
        {
            Operation = operation,
            FilePath = filePath,
            ErrorMessage = errorMessage,
            UserName = userName,
            Success = false
        };
    }
}
