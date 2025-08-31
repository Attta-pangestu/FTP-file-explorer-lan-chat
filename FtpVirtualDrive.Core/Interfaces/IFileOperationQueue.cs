using System;
using System.Threading;
using System.Threading.Tasks;

namespace FtpVirtualDrive.Core.Interfaces;

/// <summary>
/// Queue for processing file operations asynchronously
/// </summary>
public interface IFileOperationQueue : IDisposable
{
    /// <summary>
    /// Enqueue a file operation for async processing
    /// </summary>
    Task<TResult> EnqueueAsync<TResult>(
        Func<CancellationToken, Task<TResult>> operation,
        CancellationToken cancellationToken = default,
        TimeSpan? timeout = null);
    
    /// <summary>
    /// Enqueue a file operation without result
    /// </summary>
    Task EnqueueAsync(
        Func<CancellationToken, Task> operation,
        CancellationToken cancellationToken = default,
        TimeSpan? timeout = null);
    
    /// <summary>
    /// Get current queue statistics
    /// </summary>
    QueueStatistics GetStatistics();
}

/// <summary>
/// Statistics about the operation queue
/// </summary>
public record QueueStatistics
{
    public int PendingOperations { get; init; }
    public int ActiveOperations { get; init; }
    public long CompletedOperations { get; init; }
    public long FailedOperations { get; init; }
    public TimeSpan AverageProcessingTime { get; init; }
    public int MaxConcurrency { get; init; }
}
