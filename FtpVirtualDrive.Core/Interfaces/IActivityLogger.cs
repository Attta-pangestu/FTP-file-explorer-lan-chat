using FtpVirtualDrive.Core.Models;

namespace FtpVirtualDrive.Core.Interfaces;

/// <summary>
/// Defines the contract for activity logging operations
/// </summary>
public interface IActivityLogger
{
    /// <summary>
    /// Logs an activity to the storage
    /// </summary>
    /// <param name="activity">Activity to log</param>
    /// <returns>The logged activity with assigned ID</returns>
    Task<ActivityLog> LogActivityAsync(ActivityLog activity);

    /// <summary>
    /// Gets activity logs within a date range
    /// </summary>
    /// <param name="from">Start date (optional)</param>
    /// <param name="to">End date (optional)</param>
    /// <param name="operationType">Filter by operation type (optional)</param>
    /// <returns>Collection of activity logs</returns>
    Task<IEnumerable<ActivityLog>> GetActivityLogsAsync(
        DateTime? from = null, 
        DateTime? to = null, 
        string? operationType = null);

    /// <summary>
    /// Gets recent activity logs
    /// </summary>
    /// <param name="count">Number of recent logs to retrieve</param>
    /// <returns>Collection of recent activity logs</returns>
    Task<IEnumerable<ActivityLog>> GetRecentActivityLogsAsync(int count = 50);

    /// <summary>
    /// Exports activity logs to a file
    /// </summary>
    /// <param name="filePath">Export file path</param>
    /// <param name="format">Export format</param>
    /// <param name="from">Start date (optional)</param>
    /// <param name="to">End date (optional)</param>
    /// <returns>True if export was successful</returns>
    Task<bool> ExportLogsAsync(
        string filePath, 
        LogExportFormat format, 
        DateTime? from = null, 
        DateTime? to = null);

    /// <summary>
    /// Clears old activity logs
    /// </summary>
    /// <param name="olderThan">Delete logs older than this date</param>
    /// <returns>Number of logs deleted</returns>
    Task<int> CleanupOldLogsAsync(DateTime olderThan);

    /// <summary>
    /// Gets activity statistics
    /// </summary>
    /// <param name="from">Start date (optional)</param>
    /// <param name="to">End date (optional)</param>
    /// <returns>Activity statistics</returns>
    Task<ActivityStatistics> GetStatisticsAsync(DateTime? from = null, DateTime? to = null);
}
