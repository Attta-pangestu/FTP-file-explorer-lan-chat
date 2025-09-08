using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using FluentFTP;
using FtpVirtualDrive.Core.Interfaces;
using FtpVirtualDrive.Core.Models;
using Microsoft.Extensions.Logging;

namespace FtpVirtualDrive.Infrastructure.FTP;

/// <summary>
/// Manages a pool of FTP client connections with keep-alive support
/// </summary>
public class FtpConnectionPool : IFtpConnectionPool
{
    private readonly ILogger<FtpConnectionPool> _logger;
    private readonly IActivityLogger _activityLogger;
    private readonly FtpConnectionInfo _connectionInfo;
    private readonly Channel<PooledFtpClientWrapper> _availableClients;
    private readonly ConcurrentDictionary<Guid, PooledFtpClientWrapper> _allClients;
    private readonly SemaphoreSlim _createClientSemaphore;
    private readonly Timer _keepAliveTimer;
    private readonly Timer _cleanupTimer;
    
    private readonly int _maxPoolSize;
    private readonly int _minPoolSize;
    private readonly TimeSpan _idleTimeout;
    private readonly TimeSpan _keepAliveInterval;
    
    private long _totalRequests;
    private long _totalWaitTime;
    private DateTime _lastResetTime;
    private bool _disposed;

    public FtpConnectionPool(
        ILogger<FtpConnectionPool> logger,
        IActivityLogger activityLogger,
        FtpConnectionInfo connectionInfo,
        int maxPoolSize = 8,
        int minPoolSize = 2)
    {
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _activityLogger = activityLogger ?? throw new ArgumentNullException(nameof(activityLogger));
        _connectionInfo = connectionInfo ?? throw new ArgumentNullException(nameof(connectionInfo));
        
        _maxPoolSize = Math.Max(maxPoolSize, 1);
        _minPoolSize = Math.Min(Math.Max(minPoolSize, 1), _maxPoolSize);
        _idleTimeout = TimeSpan.FromMinutes(5);
        _keepAliveInterval = TimeSpan.FromSeconds(90);
        
        _availableClients = Channel.CreateUnbounded<PooledFtpClientWrapper>(new UnboundedChannelOptions
        {
            SingleWriter = false,
            SingleReader = false
        });
        
        _allClients = new ConcurrentDictionary<Guid, PooledFtpClientWrapper>();
        _createClientSemaphore = new SemaphoreSlim(_maxPoolSize, _maxPoolSize);
        _lastResetTime = DateTime.UtcNow;
        
        // Setup keep-alive timer to send NOOP commands
        _keepAliveTimer = new Timer(SendKeepAlive, null, _keepAliveInterval, _keepAliveInterval);
        
        // Setup cleanup timer to remove idle connections
        _cleanupTimer = new Timer(CleanupIdleConnections, null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
        
        // Pre-create minimum number of connections
        _ = Task.Run(async () => await WarmupPoolAsync());
    }

    public async Task<IPooledFtpClient> GetClientAsync(CancellationToken cancellationToken = default)
    {
        if (_disposed)
            throw new ObjectDisposedException(nameof(FtpConnectionPool));
        
        var stopwatch = Stopwatch.StartNew();
        Interlocked.Increment(ref _totalRequests);
        
        try
        {
            // Try to get an existing client from the pool
            if (_availableClients.Reader.TryRead(out var existingClient))
            {
                if (await ValidateClientAsync(existingClient))
                {
                    existingClient.MarkInUse();
                    return existingClient;
                }
                else
                {
                    // Client is invalid, remove it
                    RemoveClient(existingClient);
                }
            }
            
            // Check if we can create a new client
            if (_allClients.Count < _maxPoolSize)
            {
                await _createClientSemaphore.WaitAsync(cancellationToken);
                try
                {
                    if (_allClients.Count < _maxPoolSize)
                    {
                        var newClient = await CreateClientAsync(cancellationToken);
                        if (newClient != null)
                        {
                            newClient.MarkInUse();
                            return newClient;
                        }
                    }
                }
                finally
                {
                    _createClientSemaphore.Release();
                }
            }
            
            // Wait for a client to become available
            var client = await _availableClients.Reader.ReadAsync(cancellationToken);
            
            // Validate before returning
            if (!await ValidateClientAsync(client))
            {
                RemoveClient(client);
                // Recursively try again
                return await GetClientAsync(cancellationToken);
            }
            
            client.MarkInUse();
            return client;
        }
        finally
        {
            stopwatch.Stop();
            Interlocked.Add(ref _totalWaitTime, stopwatch.ElapsedMilliseconds);
        }
    }

    public ConnectionPoolStatistics GetStatistics()
    {
        var activeCount = 0;
        var idleCount = 0;
        
        foreach (var client in _allClients.Values)
        {
            if (client.IsInUse)
                activeCount++;
            else
                idleCount++;
        }
        
        var avgWaitTime = _totalRequests > 0 
            ? TimeSpan.FromMilliseconds(_totalWaitTime / _totalRequests)
            : TimeSpan.Zero;
        
        return new ConnectionPoolStatistics
        {
            TotalConnections = _allClients.Count,
            ActiveConnections = activeCount,
            IdleConnections = idleCount,
            FailedConnections = 0, // Track this if needed
            AverageWaitTime = avgWaitTime,
            LastResetTime = _lastResetTime
        };
    }

    public async Task ClearPoolAsync()
    {
        _logger.LogInformation("Clearing FTP connection pool");
        
        // Close the channel to prevent new readers
        _availableClients.Writer.TryComplete();
        
        // Dispose all clients
        foreach (var client in _allClients.Values)
        {
            try
            {
                await client.DisposeAsync();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error disposing pooled client");
            }
        }
        
        _allClients.Clear();
        
        // Reset statistics
        _totalRequests = 0;
        _totalWaitTime = 0;
        _lastResetTime = DateTime.UtcNow;
    }

    private async Task<PooledFtpClientWrapper?> CreateClientAsync(CancellationToken cancellationToken)
    {
        try
        {
            _logger.LogDebug("Creating new FTP client for pool");
            
            var ftpClient = new AsyncFtpClient(
                _connectionInfo.Host,
                _connectionInfo.Username,
                _connectionInfo.Password,
                _connectionInfo.Port);
            
            // Configure client settings
            ConfigureFtpClient(ftpClient);
            
            // Connect
            await ftpClient.AutoConnect(cancellationToken);
            
            var wrapper = new PooledFtpClientWrapper(
                ftpClient,
                this,
                _logger,
                _activityLogger,
                _connectionInfo);
            
            if (_allClients.TryAdd(wrapper.Id, wrapper))
            {
                _logger.LogDebug("Successfully created and added FTP client to pool. Total: {Count}", _allClients.Count);
                return wrapper;
            }
            
            await ftpClient.Disconnect();
            ftpClient.Dispose();
            return null;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to create FTP client for pool");
            return null;
        }
    }

    private void ConfigureFtpClient(AsyncFtpClient ftpClient)
    {
        // Configure encryption
        if (_connectionInfo.UseSSL)
        {
            ftpClient.Config.EncryptionMode = FtpEncryptionMode.Explicit;
            ftpClient.Config.SslProtocols = System.Security.Authentication.SslProtocols.Tls12 | 
                                           System.Security.Authentication.SslProtocols.Tls13;
            ftpClient.Config.ValidateAnyCertificate = _connectionInfo.SslValidation == SslValidationMode.AcceptAnyCertificate;
        }
        else
        {
            ftpClient.Config.EncryptionMode = FtpEncryptionMode.None;
        }
        
        // Configure connection settings
        ftpClient.Config.DataConnectionType = _connectionInfo.UsePassiveMode ? 
            FtpDataConnectionType.AutoPassive : FtpDataConnectionType.AutoActive;
        
        // Set timeouts
        ftpClient.Config.ConnectTimeout = _connectionInfo.TimeoutSeconds * 1000;
        ftpClient.Config.ReadTimeout = _connectionInfo.TimeoutSeconds * 1000;
        ftpClient.Config.DataConnectionConnectTimeout = _connectionInfo.TimeoutSeconds * 1000;
        ftpClient.Config.DataConnectionReadTimeout = _connectionInfo.TimeoutSeconds * 1000;
        
        // Enable stale data check
        ftpClient.Config.StaleDataCheck = true;
        // Note: FluentFTP's AsyncFtpClient handles keep-alive internally
        // We'll use our own timer-based keep-alive mechanism
        
        // Disable logging to console
        ftpClient.Config.LogToConsole = false;
    }

    private async Task<bool> ValidateClientAsync(PooledFtpClientWrapper client)
    {
        try
        {
            if (!client.IsConnected)
                return false;
            
            // Check if connection is still alive with a quick operation
            await client.InternalClient.GetWorkingDirectory();
            return true;
        }
        catch
        {
            return false;
        }
    }

    private void RemoveClient(PooledFtpClientWrapper client)
    {
        if (_allClients.TryRemove(client.Id, out _))
        {
            _ = Task.Run(async () =>
            {
                try
                {
                    await client.DisposeAsync();
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error disposing removed client");
                }
            });
            
            _logger.LogDebug("Removed client from pool. Remaining: {Count}", _allClients.Count);
        }
    }

    private async Task WarmupPoolAsync()
    {
        try
        {
            _logger.LogInformation("Warming up connection pool with {MinSize} connections", _minPoolSize);
            
            var tasks = new Task<PooledFtpClientWrapper?>[_minPoolSize];
            for (int i = 0; i < _minPoolSize; i++)
            {
                tasks[i] = CreateClientAsync(CancellationToken.None);
            }
            
            var clients = await Task.WhenAll(tasks);
            
            foreach (var client in clients)
            {
                if (client != null)
                {
                    client.Return();
                }
            }
            
            _logger.LogInformation("Connection pool warmed up with {Count} connections", _allClients.Count);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error warming up connection pool");
        }
    }

    private void SendKeepAlive(object? state)
    {
        if (_disposed) return;
        
        _ = Task.Run(async () =>
        {
            foreach (var client in _allClients.Values)
            {
                if (!client.IsInUse && client.IsConnected)
                {
                    try
                    {
                        // Send NOOP command to keep connection alive
                        await client.InternalClient.Execute("NOOP");
                    }
                    catch (Exception ex)
                    {
                        _logger.LogDebug(ex, "Failed to send keep-alive for client {Id}", client.Id);
                    }
                }
            }
        });
    }

    private void CleanupIdleConnections(object? state)
    {
        if (_disposed) return;
        
        _ = Task.Run(async () =>
        {
            var now = DateTime.UtcNow;
            var toRemove = new List<PooledFtpClientWrapper>();
            
            foreach (var client in _allClients.Values)
            {
                // Keep minimum pool size
                if (_allClients.Count <= _minPoolSize)
                    break;
                
                if (!client.IsInUse && (now - client.LastUsedTime) > _idleTimeout)
                {
                    toRemove.Add(client);
                }
            }
            
            foreach (var client in toRemove)
            {
                RemoveClient(client);
            }
            
            if (toRemove.Count > 0)
            {
                _logger.LogDebug("Cleaned up {Count} idle connections", toRemove.Count);
            }
        });
    }

    internal void ReturnClient(PooledFtpClientWrapper client)
    {
        if (_disposed)
        {
            RemoveClient(client);
            return;
        }
        
        client.MarkReturned();
        
        if (!_availableClients.Writer.TryWrite(client))
        {
            // Channel is full or closed, dispose the client
            RemoveClient(client);
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        
        _keepAliveTimer?.Dispose();
        _cleanupTimer?.Dispose();
        _createClientSemaphore?.Dispose();
        
        _ = ClearPoolAsync();
        
        GC.SuppressFinalize(this);
    }
}

/// <summary>
/// Wrapper for pooled FTP client
/// </summary>
internal class PooledFtpClientWrapper : IPooledFtpClient
{
    private readonly FtpConnectionPool _pool;
    private readonly ILogger _logger;
    private readonly IActivityLogger _activityLogger;
    private readonly FtpClientService _clientService;
    
    public Guid Id { get; }
    public bool IsInUse { get; private set; }
    public DateTime LastUsedTime { get; private set; }
    public AsyncFtpClient InternalClient { get; }
    
    public bool IsConnected => InternalClient?.IsConnected ?? false;
    public FtpConnectionInfo? ConnectionInfo { get; }

    public event EventHandler<FtpOperationEventArgs>? OperationCompleted
    {
        add => _clientService.OperationCompleted += value;
        remove => _clientService.OperationCompleted -= value;
    }

    public PooledFtpClientWrapper(
        AsyncFtpClient ftpClient,
        FtpConnectionPool pool,
        ILogger logger,
        IActivityLogger activityLogger,
        FtpConnectionInfo connectionInfo)
    {
        Id = Guid.NewGuid();
        InternalClient = ftpClient ?? throw new ArgumentNullException(nameof(ftpClient));
        _pool = pool ?? throw new ArgumentNullException(nameof(pool));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _activityLogger = activityLogger ?? throw new ArgumentNullException(nameof(activityLogger));
        ConnectionInfo = connectionInfo;
        LastUsedTime = DateTime.UtcNow;
        
        // Create a wrapped service that uses this specific client
        _clientService = new FtpClientService(
            logger as ILogger<FtpClientService> ?? new Microsoft.Extensions.Logging.Abstractions.NullLogger<FtpClientService>(),
            activityLogger);
        
        // Set the internal client directly
        _clientService.SetInternalClient(InternalClient, connectionInfo);
    }

    public void MarkInUse()
    {
        IsInUse = true;
        LastUsedTime = DateTime.UtcNow;
    }

    public void MarkReturned()
    {
        IsInUse = false;
        LastUsedTime = DateTime.UtcNow;
    }

    public void Return()
    {
        _pool.ReturnClient(this);
    }

    // Delegate all IFtpClient methods to the wrapped service
    public Task<bool> ConnectAsync(FtpConnectionInfo connectionInfo) => Task.FromResult(IsConnected);
    public Task<bool> DisconnectAsync() => Task.FromResult(true);
    public Task<Stream> DownloadFileAsync(string remotePath) => _clientService.DownloadFileAsync(remotePath);
    public Task<bool> UploadFileAsync(string remotePath, Stream content) => _clientService.UploadFileAsync(remotePath, content);
    public Task<bool> DeleteFileAsync(string remotePath) => _clientService.DeleteFileAsync(remotePath);
    public Task<IEnumerable<FtpFileInfo>> ListDirectoryAsync(string remotePath) => _clientService.ListDirectoryAsync(remotePath);
    public Task<bool> CreateDirectoryAsync(string remotePath) => _clientService.CreateDirectoryAsync(remotePath);
    public Task<bool> RenameAsync(string remotePath, string newName) => _clientService.RenameAsync(remotePath, newName);
    public Task<bool> FileExistsAsync(string remotePath) => _clientService.FileExistsAsync(remotePath);
    public Task<FtpFileInfo?> GetFileInfoAsync(string remotePath) => _clientService.GetFileInfoAsync(remotePath);

    public void Dispose()
    {
        Return();
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (InternalClient?.IsConnected == true)
            {
                await InternalClient.Disconnect();
            }
            InternalClient?.Dispose();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error disposing pooled FTP client");
        }
    }
}
