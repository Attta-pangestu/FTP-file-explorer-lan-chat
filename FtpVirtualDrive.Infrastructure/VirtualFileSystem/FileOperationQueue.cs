using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using FtpVirtualDrive.Core.Interfaces;
using Microsoft.Extensions.Logging;

namespace FtpVirtualDrive.Infrastructure.VirtualFileSystem;

/// <summary>
/// Queue for processing file operations asynchronously without blocking Dokan threads
/// </summary>
public class FileOperationQueue : IFileOperationQueue
{
    private readonly ILogger<FileOperationQueue> _logger;
    private readonly Channel<QueuedOperation> _channel;
    private readonly CancellationTokenSource _shutdownTokenSource;
    private readonly Task[] _processorTasks;
    private readonly SemaphoreSlim _concurrencyLimiter;
    
    private long _completedOperations;
    private long _failedOperations;
    private long _totalProcessingTime;
    private int _activeOperations;
    private bool _disposed;

    public FileOperationQueue(ILogger<FileOperationQueue> logger, int maxConcurrency = 8)
    {
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        
        if (maxConcurrency < 1)
            throw new ArgumentException("Max concurrency must be at least 1", nameof(maxConcurrency));
        
        _channel = Channel.CreateUnbounded<QueuedOperation>(new UnboundedChannelOptions
        {
            SingleWriter = false,
            SingleReader = false
        });
        
        _shutdownTokenSource = new CancellationTokenSource();
        _concurrencyLimiter = new SemaphoreSlim(maxConcurrency, maxConcurrency);
        
        // Start processor tasks
        var processorCount = Math.Min(maxConcurrency, Environment.ProcessorCount);
        _processorTasks = new Task[processorCount];
        
        for (int i = 0; i < processorCount; i++)
        {
            int taskId = i;
            _processorTasks[i] = Task.Run(() => ProcessQueueAsync(taskId), _shutdownTokenSource.Token);
        }
        
        _logger.LogInformation("File operation queue started with {ProcessorCount} processors and max concurrency {MaxConcurrency}",
            processorCount, maxConcurrency);
    }

    public async Task<TResult> EnqueueAsync<TResult>(
        Func<CancellationToken, Task<TResult>> operation,
        CancellationToken cancellationToken = default,
        TimeSpan? timeout = null)
    {
        if (_disposed)
            throw new ObjectDisposedException(nameof(FileOperationQueue));
        
        var tcs = new TaskCompletionSource<TResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var effectiveTimeout = timeout ?? TimeSpan.FromSeconds(30);
        
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _shutdownTokenSource.Token);
        using var timeoutCts = new CancellationTokenSource(effectiveTimeout);
        using var combinedCts = CancellationTokenSource.CreateLinkedTokenSource(linkedCts.Token, timeoutCts.Token);
        
        var queuedOp = new QueuedOperation
        {
            Id = Guid.NewGuid(),
            EnqueuedAt = DateTime.UtcNow,
            ExecuteAsync = async (ct) =>
            {
                try
                {
                    var result = await operation(ct);
                    tcs.TrySetResult(result);
                }
                catch (OperationCanceledException ex)
                {
                    tcs.TrySetCanceled(ex.CancellationToken);
                }
                catch (Exception ex)
                {
                    tcs.TrySetException(ex);
                }
            },
            CancellationToken = combinedCts.Token
        };
        
        // Register cancellation callback
        combinedCts.Token.Register(() =>
        {
            if (timeoutCts.IsCancellationRequested)
            {
                tcs.TrySetException(new TimeoutException($"Operation timed out after {effectiveTimeout}"));
            }
            else
            {
                tcs.TrySetCanceled(combinedCts.Token);
            }
        });
        
        if (!_channel.Writer.TryWrite(queuedOp))
        {
            throw new InvalidOperationException("Failed to enqueue operation");
        }
        
        return await tcs.Task;
    }

    public async Task EnqueueAsync(
        Func<CancellationToken, Task> operation,
        CancellationToken cancellationToken = default,
        TimeSpan? timeout = null)
    {
        await EnqueueAsync<object?>(async ct =>
        {
            await operation(ct);
            return null;
        }, cancellationToken, timeout);
    }

    public QueueStatistics GetStatistics()
    {
        var avgProcessingTime = _completedOperations > 0
            ? TimeSpan.FromMilliseconds(_totalProcessingTime / _completedOperations)
            : TimeSpan.Zero;
        
        return new QueueStatistics
        {
            PendingOperations = _channel.Reader.Count,
            ActiveOperations = _activeOperations,
            CompletedOperations = _completedOperations,
            FailedOperations = _failedOperations,
            AverageProcessingTime = avgProcessingTime,
            MaxConcurrency = _concurrencyLimiter.CurrentCount
        };
    }

    private async Task ProcessQueueAsync(int taskId)
    {
        _logger.LogDebug("Processor task {TaskId} started", taskId);
        
        try
        {
            await foreach (var operation in _channel.Reader.ReadAllAsync(_shutdownTokenSource.Token))
            {
                if (operation.CancellationToken.IsCancellationRequested)
                {
                    _logger.LogDebug("Skipping cancelled operation {OperationId}", operation.Id);
                    Interlocked.Increment(ref _failedOperations);
                    continue;
                }
                
                await _concurrencyLimiter.WaitAsync(_shutdownTokenSource.Token);
                
                _ = Task.Run(async () =>
                {
                    var stopwatch = Stopwatch.StartNew();
                    Interlocked.Increment(ref _activeOperations);
                    
                    try
                    {
                        _logger.LogTrace("Executing operation {OperationId}", operation.Id);
                        await operation.ExecuteAsync(operation.CancellationToken);
                        
                        Interlocked.Increment(ref _completedOperations);
                        _logger.LogTrace("Operation {OperationId} completed in {ElapsedMs}ms",
                            operation.Id, stopwatch.ElapsedMilliseconds);
                    }
                    catch (OperationCanceledException)
                    {
                        Interlocked.Increment(ref _failedOperations);
                        _logger.LogDebug("Operation {OperationId} was cancelled", operation.Id);
                    }
                    catch (Exception ex)
                    {
                        Interlocked.Increment(ref _failedOperations);
                        _logger.LogError(ex, "Operation {OperationId} failed", operation.Id);
                    }
                    finally
                    {
                        stopwatch.Stop();
                        Interlocked.Add(ref _totalProcessingTime, stopwatch.ElapsedMilliseconds);
                        Interlocked.Decrement(ref _activeOperations);
                        _concurrencyLimiter.Release();
                    }
                }, _shutdownTokenSource.Token);
            }
        }
        catch (OperationCanceledException)
        {
            _logger.LogDebug("Processor task {TaskId} cancelled", taskId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Processor task {TaskId} failed", taskId);
        }
        
        _logger.LogDebug("Processor task {TaskId} completed", taskId);
    }

    public void Dispose()
    {
        if (_disposed)
            return;
        
        _logger.LogInformation("Shutting down file operation queue");
        
        // Signal shutdown
        _shutdownTokenSource.Cancel();
        
        // Complete the channel
        _channel.Writer.TryComplete();
        
        // Wait for processors to complete (with timeout)
        try
        {
            Task.WaitAll(_processorTasks, TimeSpan.FromSeconds(10));
        }
        catch (AggregateException ex)
        {
            _logger.LogError(ex, "Error waiting for processor tasks to complete");
        }
        
        _shutdownTokenSource.Dispose();
        _concurrencyLimiter.Dispose();
        
        _disposed = true;
        
        _logger.LogInformation("File operation queue shutdown complete. Stats: Completed={Completed}, Failed={Failed}",
            _completedOperations, _failedOperations);
    }

    private class QueuedOperation
    {
        public Guid Id { get; init; }
        public DateTime EnqueuedAt { get; init; }
        public required Func<CancellationToken, Task> ExecuteAsync { get; init; }
        public CancellationToken CancellationToken { get; init; }
    }
}
