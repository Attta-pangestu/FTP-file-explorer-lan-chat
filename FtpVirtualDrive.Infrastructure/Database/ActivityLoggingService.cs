using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using FtpVirtualDrive.Core.Interfaces;
using FtpVirtualDrive.Core.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace FtpVirtualDrive.Infrastructure.Database;

/// <summary>
/// Activity logging service implementation using Entity Framework
/// </summary>
public class ActivityLoggingService : IActivityLogger
{
    private readonly AppDbContext _dbContext;
    private readonly ILogger<ActivityLoggingService> _logger;

    public ActivityLoggingService(AppDbContext dbContext, ILogger<ActivityLoggingService> logger)
    {
        _dbContext = dbContext ?? throw new ArgumentNullException(nameof(dbContext));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async Task<ActivityLog> LogActivityAsync(ActivityLog activity)
    {
        try
        {
            _dbContext.ActivityLogs.Add(activity);
            await _dbContext.SaveChangesAsync();

            _logger.LogDebug("Logged activity: {Operation} on {FilePath}", activity.Operation, activity.FilePath);
            return activity;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to log activity for {Operation} on {FilePath}", 
                activity.Operation, activity.FilePath);
            throw;
        }
    }

    public async Task<IEnumerable<ActivityLog>> GetActivityLogsAsync(
        DateTime? from = null, 
        DateTime? to = null, 
        string? operationType = null)
    {
        try
        {
            var query = _dbContext.ActivityLogs.AsQueryable();

            if (from.HasValue)
                query = query.Where(log => log.Timestamp >= from.Value);

            if (to.HasValue)
                query = query.Where(log => log.Timestamp <= to.Value);

            if (!string.IsNullOrEmpty(operationType) && Enum.TryParse<OperationType>(operationType, true, out var opType))
                query = query.Where(log => log.Operation == opType);

            return await query
                .OrderByDescending(log => log.Timestamp)
                .ToListAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to retrieve activity logs");
            throw;
        }
    }

    public async Task<IEnumerable<ActivityLog>> GetRecentActivityLogsAsync(int count = 50)
    {
        try
        {
            return await _dbContext.ActivityLogs
                .OrderByDescending(log => log.Timestamp)
                .Take(count)
                .ToListAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to retrieve recent activity logs");
            throw;
        }
    }

    public async Task<bool> ExportLogsAsync(
        string filePath, 
        LogExportFormat format, 
        DateTime? from = null, 
        DateTime? to = null)
    {
        try
        {
            var logs = await GetActivityLogsAsync(from, to);
            var content = format switch
            {
                LogExportFormat.Csv => GenerateCsv(logs),
                LogExportFormat.Json => GenerateJson(logs),
                LogExportFormat.Xml => GenerateXml(logs),
                LogExportFormat.Text => GenerateText(logs),
                _ => throw new ArgumentException($"Unsupported export format: {format}")
            };

            await File.WriteAllTextAsync(filePath, content);
            _logger.LogInformation("Exported {Count} activity logs to {FilePath} in {Format} format", 
                logs.Count(), filePath, format);

            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to export activity logs to {FilePath}", filePath);
            return false;
        }
    }

    public async Task<int> CleanupOldLogsAsync(DateTime olderThan)
    {
        try
        {
            var oldLogs = await _dbContext.ActivityLogs
                .Where(log => log.Timestamp < olderThan)
                .ToListAsync();

            _dbContext.ActivityLogs.RemoveRange(oldLogs);
            await _dbContext.SaveChangesAsync();

            _logger.LogInformation("Cleaned up {Count} old activity logs older than {Date}", 
                oldLogs.Count, olderThan);

            return oldLogs.Count;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to cleanup old activity logs");
            throw;
        }
    }

    public async Task<ActivityStatistics> GetStatisticsAsync(DateTime? from = null, DateTime? to = null)
    {
        try
        {
            var query = _dbContext.ActivityLogs.AsQueryable();

            if (from.HasValue)
                query = query.Where(log => log.Timestamp >= from.Value);

            if (to.HasValue)
                query = query.Where(log => log.Timestamp <= to.Value);

            var logs = await query.ToListAsync();

            return new ActivityStatistics
            {
                TotalOperations = logs.Count,
                SuccessfulOperations = logs.Count(log => log.Success),
                FailedOperations = logs.Count(log => !log.Success),
                TotalBytesTransferred = logs.Where(log => log.FileSize.HasValue).Sum(log => log.FileSize!.Value),
                OperationCounts = logs.GroupBy(log => log.Operation)
                    .ToDictionary(group => group.Key, group => group.Count()),
                FirstActivity = logs.MinBy(log => log.Timestamp)?.Timestamp,
                LastActivity = logs.MaxBy(log => log.Timestamp)?.Timestamp
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to calculate activity statistics");
            throw;
        }
    }

    private static string GenerateCsv(IEnumerable<ActivityLog> logs)
    {
        var sb = new StringBuilder();
        sb.AppendLine("Timestamp,Operation,FilePath,Success,Details,FileSize,UserName,ErrorMessage,DurationMs");

        foreach (var log in logs)
        {
            sb.AppendLine($"{log.Timestamp:yyyy-MM-dd HH:mm:ss},{log.Operation},{EscapeCsv(log.FilePath)}," +
                         $"{log.Success},{EscapeCsv(log.Details)},{log.FileSize},{EscapeCsv(log.UserName)}," +
                         $"{EscapeCsv(log.ErrorMessage)},{log.DurationMs}");
        }

        return sb.ToString();
    }

    private static string GenerateJson(IEnumerable<ActivityLog> logs)
    {
        var options = new JsonSerializerOptions
        {
            WriteIndented = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        };
        return JsonSerializer.Serialize(logs, options);
    }

    private static string GenerateXml(IEnumerable<ActivityLog> logs)
    {
        var root = new XElement("ActivityLogs");
        
        foreach (var log in logs)
        {
            root.Add(new XElement("Log",
                new XElement("Timestamp", log.Timestamp.ToString("yyyy-MM-dd HH:mm:ss")),
                new XElement("Operation", log.Operation),
                new XElement("FilePath", log.FilePath),
                new XElement("Success", log.Success),
                new XElement("Details", log.Details ?? string.Empty),
                new XElement("FileSize", log.FileSize),
                new XElement("UserName", log.UserName ?? string.Empty),
                new XElement("ErrorMessage", log.ErrorMessage ?? string.Empty),
                new XElement("DurationMs", log.DurationMs)
            ));
        }

        return root.ToString();
    }

    private static string GenerateText(IEnumerable<ActivityLog> logs)
    {
        var sb = new StringBuilder();
        sb.AppendLine("FTP Virtual Drive Activity Log");
        sb.AppendLine("==============================");
        sb.AppendLine();

        foreach (var log in logs)
        {
            sb.AppendLine($"[{log.Timestamp:yyyy-MM-dd HH:mm:ss}] {log.Operation} - {log.FilePath}");
            if (!string.IsNullOrEmpty(log.Details))
                sb.AppendLine($"  Details: {log.Details}");
            if (!log.Success && !string.IsNullOrEmpty(log.ErrorMessage))
                sb.AppendLine($"  Error: {log.ErrorMessage}");
            if (log.FileSize.HasValue)
                sb.AppendLine($"  Size: {log.FileSize} bytes");
            if (log.DurationMs.HasValue)
                sb.AppendLine($"  Duration: {log.DurationMs}ms");
            sb.AppendLine();
        }

        return sb.ToString();
    }

    private static string EscapeCsv(string? value)
    {
        if (string.IsNullOrEmpty(value))
            return string.Empty;

        if (value.Contains(',') || value.Contains('"') || value.Contains('\n'))
            return $"\"{value.Replace("\"", "\"\"")}\"";

        return value;
    }
}
