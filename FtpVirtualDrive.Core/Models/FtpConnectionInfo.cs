using System.ComponentModel.DataAnnotations;

namespace FtpVirtualDrive.Core.Models;

/// <summary>
/// Represents FTP connection information
/// </summary>
public class FtpConnectionInfo
{
    /// <summary>
    /// FTP server hostname or IP address
    /// </summary>
    [Required]
    public string Host { get; set; } = string.Empty;

    /// <summary>
    /// FTP server port (default: 21 for FTP, 990 for FTPS)
    /// </summary>
    [Range(1, 65535)]
    public int Port { get; set; } = 21;

    /// <summary>
    /// Username for authentication
    /// </summary>
    [Required]
    public string Username { get; set; } = string.Empty;

    /// <summary>
    /// Password for authentication
    /// </summary>
    [Required]
    public string Password { get; set; } = string.Empty;

    /// <summary>
    /// Whether to use SSL/TLS encryption (FTPS)
    /// </summary>
    public bool UseSSL { get; set; } = true;

    /// <summary>
    /// SSL validation mode
    /// </summary>
    public SslValidationMode SslValidation { get; set; } = SslValidationMode.ValidateCertificate;

    /// <summary>
    /// Connection timeout in seconds
    /// </summary>
    public int TimeoutSeconds { get; set; } = 30;

    /// <summary>
    /// Whether to use passive mode
    /// </summary>
    public bool UsePassiveMode { get; set; } = true;

    /// <summary>
    /// Connection name for identification
    /// </summary>
    public string ConnectionName { get; set; } = string.Empty;

    /// <summary>
    /// Gets the display string for this connection
    /// </summary>
    public string DisplayName => string.IsNullOrEmpty(ConnectionName) 
        ? $"{Username}@{Host}:{Port}" 
        : ConnectionName;

    /// <summary>
    /// Validates the connection information
    /// </summary>
    /// <returns>Validation result</returns>
    public ValidationResult Validate()
    {
        var errors = new List<string>();

        if (string.IsNullOrWhiteSpace(Host))
            errors.Add("Host is required");

        if (Port <= 0 || Port > 65535)
            errors.Add("Port must be between 1 and 65535");

        if (string.IsNullOrWhiteSpace(Username))
            errors.Add("Username is required");

        if (string.IsNullOrWhiteSpace(Password))
            errors.Add("Password is required");

        if (TimeoutSeconds <= 0)
            errors.Add("Timeout must be greater than 0");

        return new ValidationResult(errors.Count == 0, errors);
    }

    /// <summary>
    /// Creates a copy without the password for logging purposes
    /// </summary>
    /// <returns>Connection info without sensitive data</returns>
    public FtpConnectionInfo ToSafeInfo()
    {
        return new FtpConnectionInfo
        {
            Host = Host,
            Port = Port,
            Username = Username,
            Password = "***",
            UseSSL = UseSSL,
            SslValidation = SslValidation,
            TimeoutSeconds = TimeoutSeconds,
            UsePassiveMode = UsePassiveMode,
            ConnectionName = ConnectionName
        };
    }
}
