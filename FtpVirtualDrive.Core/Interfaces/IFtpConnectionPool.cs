using System;
using System.Threading;
using System.Threading.Tasks;

namespace FtpVirtualDrive.Core.Interfaces;

/// <summary>
/// Manages a pool of FTP client connections to avoid reconnection overhead
/// </summary>
public interface IFtpConnectionPool : IDisposable
{
    /// <summary>
    /// Get a pooled FTP client connection
    /// </summary>
    Task<IPooledFtpClient> GetClientAsync(CancellationToken cancellationToken = default);
    
    /// <summary>
    /// Get current pool statistics
    /// </summary>
    ConnectionPoolStatistics GetStatistics();
    
    /// <summary>
    /// Clear all pooled connections
    /// </summary>
    Task ClearPoolAsync();
}

/// <summary>
/// Represents a pooled FTP client that must be returned to the pool after use
/// </summary>
public interface IPooledFtpClient : IFtpClient, IDisposable
{
    /// <summary>
    /// Returns the client to the pool
    /// </summary>
    void Return();
}

/// <summary>
/// Statistics about the connection pool
/// </summary>
public record ConnectionPoolStatistics
{
    public int TotalConnections { get; init; }
    public int ActiveConnections { get; init; }
    public int IdleConnections { get; init; }
    public int FailedConnections { get; init; }
    public TimeSpan AverageWaitTime { get; init; }
    public DateTime LastResetTime { get; init; }
}
