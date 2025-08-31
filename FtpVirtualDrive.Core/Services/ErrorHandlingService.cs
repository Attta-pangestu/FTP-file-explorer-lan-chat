using System.Text;
using FtpVirtualDrive.Core.Exceptions;
using FtpVirtualDrive.Core.Interfaces;
using FtpVirtualDrive.Core.Models;
using Microsoft.Extensions.Logging;

namespace FtpVirtualDrive.Core.Services;

/// <summary>
/// Global error handling service
/// </summary>
public class ErrorHandlingService
{
    private readonly ILogger<ErrorHandlingService> _logger;
    private readonly IActivityLogger? _activityLogger;

    public ErrorHandlingService(ILogger<ErrorHandlingService> logger, IActivityLogger? activityLogger = null)
    {
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _activityLogger = activityLogger;
    }

    /// <summary>
    /// Handles and logs exceptions, returning user-friendly error messages
    /// </summary>
    /// <param name="exception">Exception to handle</param>
    /// <param name="context">Context where the error occurred</param>
    /// <returns>User-friendly error message</returns>
    public async Task<string> HandleExceptionAsync(Exception exception, string context = "")
    {
        var userMessage = GetUserFriendlyMessage(exception);
        var logMessage = string.IsNullOrEmpty(context) 
            ? exception.Message 
            : $"{context}: {exception.Message}";

        _logger.LogError(exception, "Error in {Context}: {Message}", context, exception.Message);

        // Log to activity logger if available
        if (_activityLogger != null && exception is FtpVirtualDriveException)
        {
            try
            {
                await _activityLogger.LogActivityAsync(new ActivityLog
                {
                    Operation = OperationType.Connect, // Default operation
                    FilePath = context,
                    Success = false,
                    ErrorMessage = exception.Message,
                    Details = GetExceptionDetails(exception)
                });
            }
            catch (Exception logEx)
            {
                _logger.LogError(logEx, "Failed to log exception to activity logger");
            }
        }

        return userMessage;
    }

    /// <summary>
    /// Converts technical exceptions to user-friendly messages
    /// </summary>
    /// <param name="exception">Exception to convert</param>
    /// <returns>User-friendly message</returns>
    public static string GetUserFriendlyMessage(Exception exception)
    {
        return exception switch
        {
            FtpConnectionException ftpEx => 
                $"Unable to connect to FTP server {ftpEx.Host}:{ftpEx.Port}. Please check your network connection and credentials.",
            
            VirtualDriveException vdEx => 
                $"Virtual drive operation failed: {vdEx.Message}. Please ensure Dokan driver is installed and running.",
            
            FileSyncException syncEx => 
                $"File synchronization failed for '{Path.GetFileName(syncEx.FilePath)}'. {syncEx.Message}",
            
            VersionTrackingException vtEx => 
                $"Version tracking failed for '{Path.GetFileName(vtEx.FilePath)}'. {vtEx.Message}",
            
            CredentialException credEx => 
                $"Credential operation failed: {credEx.Message}",
            
            ActivityLoggingException => 
                "Activity logging failed. Some operations may not be recorded.",
            
            UnauthorizedAccessException => 
                "Access denied. Please check your permissions and try again.",
            
            DirectoryNotFoundException => 
                "The specified directory was not found. Please check the path and try again.",
            
            FileNotFoundException => 
                "The specified file was not found. It may have been moved or deleted.",
            
            IOException ioEx => 
                $"File operation failed: {ioEx.Message}",
            
            TimeoutException => 
                "The operation timed out. Please check your network connection and try again.",
            
            ArgumentException argEx => 
                $"Invalid input: {argEx.Message}",
            
            InvalidOperationException invOpEx => 
                $"Operation not allowed: {invOpEx.Message}",
            
            _ => $"An unexpected error occurred: {exception.Message}"
        };
    }

    /// <summary>
    /// Gets detailed exception information for logging
    /// </summary>
    /// <param name="exception">Exception to analyze</param>
    /// <returns>Detailed exception information</returns>
    public static string GetExceptionDetails(Exception exception)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"Exception Type: {exception.GetType().Name}");
        sb.AppendLine($"Message: {exception.Message}");
        
        if (exception.InnerException != null)
        {
            sb.AppendLine($"Inner Exception: {exception.InnerException.GetType().Name}");
            sb.AppendLine($"Inner Message: {exception.InnerException.Message}");
        }
        
        sb.AppendLine($"Stack Trace: {exception.StackTrace}");
        
        return sb.ToString();
    }

    /// <summary>
    /// Validates input and returns validation errors
    /// </summary>
    /// <param name="input">Input to validate</param>
    /// <returns>Validation result</returns>
    public static ValidationResult ValidateInput(object input)
    {
        var errors = new List<string>();

        switch (input)
        {
            case string str when string.IsNullOrWhiteSpace(str):
                errors.Add("Value cannot be empty");
                break;
                
            case int port when port <= 0 || port > 65535:
                errors.Add("Port must be between 1 and 65535");
                break;
                
            case FtpConnectionInfo connInfo:
                return connInfo.Validate();
                
            default:
                // Add more validation rules as needed
                break;
        }

        return new ValidationResult(errors.Count == 0, errors);
    }
}

/// <summary>
/// Retry policy for operations that may fail temporarily
/// </summary>
public class RetryPolicy
{
    private readonly int _maxRetries;
    private readonly TimeSpan _baseDelay;
    private readonly ILogger _logger;

    public RetryPolicy(int maxRetries = 3, TimeSpan? baseDelay = null, ILogger? logger = null)
    {
        _maxRetries = maxRetries;
        _baseDelay = baseDelay ?? TimeSpan.FromSeconds(1);
        _logger = logger ?? Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance;
    }

    /// <summary>
    /// Executes an operation with retry logic
    /// </summary>
    /// <param name="operation">Operation to execute</param>
    /// <param name="operationName">Name of the operation for logging</param>
    /// <returns>Operation result</returns>
    public async Task<T> ExecuteWithRetryAsync<T>(Func<Task<T>> operation, string operationName = "Operation")
    {
        var lastException = new Exception();
        
        for (int attempt = 1; attempt <= _maxRetries; attempt++)
        {
            try
            {
                return await operation();
            }
            catch (Exception ex) when (IsRetriableException(ex) && attempt < _maxRetries)
            {
                lastException = ex;
                var delay = CalculateDelay(attempt);
                
                _logger.LogWarning("Attempt {Attempt}/{MaxRetries} failed for {OperationName}: {Message}. Retrying in {Delay}ms...", 
                    attempt, _maxRetries, operationName, ex.Message, delay.TotalMilliseconds);
                
                await Task.Delay(delay);
            }
        }
        
        _logger.LogError(lastException, "All {MaxRetries} attempts failed for {OperationName}", 
            _maxRetries, operationName);
        
        throw lastException;
    }

    /// <summary>
    /// Determines if an exception is retriable
    /// </summary>
    /// <param name="exception">Exception to check</param>
    /// <returns>True if the exception is retriable</returns>
    private static bool IsRetriableException(Exception exception)
    {
        return exception switch
        {
            TimeoutException => true,
            IOException => true,
            FtpConnectionException => true,
            FileSyncException => true,
            ArgumentException => false, // Don't retry validation errors
            UnauthorizedAccessException => false, // Don't retry auth errors
            _ => false
        };
    }

    /// <summary>
    /// Calculates exponential backoff delay
    /// </summary>
    /// <param name="attempt">Current attempt number</param>
    /// <returns>Delay duration</returns>
    private TimeSpan CalculateDelay(int attempt)
    {
        // Exponential backoff: 1s, 2s, 4s, 8s...
        var delay = TimeSpan.FromMilliseconds(_baseDelay.TotalMilliseconds * Math.Pow(2, attempt - 1));
        
        // Cap at 30 seconds
        return delay > TimeSpan.FromSeconds(30) ? TimeSpan.FromSeconds(30) : delay;
    }
}
