using System.Runtime.Versioning;
using DokanNet;
using DokanNet.Logging;
using Microsoft.Extensions.Logging;

namespace FtpVirtualDrive.Infrastructure.VirtualFileSystem;

/// <summary>
/// Helper class to manage DokanNet 2.3 API interactions and isolate version-specific changes
/// </summary>
[SupportedOSPlatform("windows")]
internal class DokanMountHelper : IDisposable
{
    private readonly ILogger<DokanMountHelper> _logger;
    private Dokan? _dokan;
    private DokanInstance? _dokanInstance;
    private bool _disposed;

    public DokanMountHelper(ILogger<DokanMountHelper> logger)
    {
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>
    /// Builds and starts a DokanInstance with the specified operations and options
    /// </summary>
    /// <param name="operations">The IDokanOperations implementation</param>
    /// <param name="mountPoint">Drive letter with colon (e.g., "Z:")</param>
    /// <param name="options">Dokan mount options</param>
    /// <param name="numThreads">Number of threads to use (default: 5)</param>
    /// <returns>DokanInstance that can be disposed to unmount</returns>
    public DokanInstance BuildAndRun(
        IDokanOperations operations, 
        string mountPoint,
        DokanOptions options = DokanOptions.DebugMode | DokanOptions.StderrOutput,
        int numThreads = 5)
    {
        if (_disposed)
            throw new ObjectDisposedException(nameof(DokanMountHelper));

        try
        {
            _logger.LogDebug("Initializing Dokan wrapper");
            
            // Create the native Dokan wrapper instance with logger
            var dokanLogger = new DokanNetLogger(_logger);
            _dokan = new Dokan(dokanLogger);
            
            // Create builder with required Dokan instance
            var builder = new DokanInstanceBuilder(_dokan);
            
            // Configure options using the new API structure
            builder.ConfigureOptions(opt =>
            {
                opt.MountPoint = mountPoint.EndsWith("\\") ? mountPoint : mountPoint + "\\";
                opt.Options = options;
                
                // DokanNet 2.3+ handles threading internally
                // ThreadCount property was removed and threading is now managed automatically
            });

            // Configure logger
            builder.ConfigureLogger(() => dokanLogger);

            _logger.LogInformation("Building DokanInstance for mount point: {MountPoint}", mountPoint);
            
            // Build the instance
            _dokanInstance = builder.Build(operations);
            
            _logger.LogInformation("DokanInstance created successfully");
            
            return _dokanInstance;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to build DokanInstance");
            throw;
        }
    }

    public void Dispose()
    {
        if (_disposed) return;

        try
        {
            // Only dispose on Windows platform
            if (OperatingSystem.IsWindows())
            {
                _dokanInstance?.Dispose();
                _dokan?.Dispose();
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error disposing DokanMountHelper");
        }
        finally
        {
            _disposed = true;
            GC.SuppressFinalize(this);
        }
    }
}

/// <summary>
/// Custom logger adapter for DokanNet that implements DokanNet.Logging.ILogger
/// </summary>
internal class DokanNetLogger : DokanNet.Logging.ILogger
{
    private readonly Microsoft.Extensions.Logging.ILogger _logger;
    private readonly ConsoleLogger _fallbackLogger;

    public DokanNetLogger(Microsoft.Extensions.Logging.ILogger logger)
    {
        _logger = logger;
        _fallbackLogger = new ConsoleLogger("[Dokan] ");
    }

    public bool DebugEnabled => _logger.IsEnabled(LogLevel.Debug);

    public void Debug(string message, params object[] args)
    {
        _logger.LogDebug("[Dokan] " + message, args);
        _fallbackLogger.Debug(message, args);
    }

    public void Info(string message, params object[] args)
    {
        _logger.LogInformation("[Dokan] " + message, args);
        _fallbackLogger.Info(message, args);
    }

    public void Warn(string message, params object[] args)
    {
        _logger.LogWarning("[Dokan] " + message, args);
        _fallbackLogger.Warn(message, args);
    }

    public void Error(string message, params object[] args)
    {
        _logger.LogError("[Dokan] " + message, args);
        _fallbackLogger.Error(message, args);
    }

    public void Fatal(string message, params object[] args)
    {
        _logger.LogCritical("[Dokan] " + message, args);
        _fallbackLogger.Fatal(message, args);
    }
}
