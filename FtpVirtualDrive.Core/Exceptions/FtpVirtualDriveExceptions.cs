namespace FtpVirtualDrive.Core.Exceptions;

/// <summary>
/// Base exception for FTP Virtual Drive operations
/// </summary>
public abstract class FtpVirtualDriveException : Exception
{
    protected FtpVirtualDriveException(string message) : base(message) { }
    protected FtpVirtualDriveException(string message, Exception innerException) : base(message, innerException) { }
}

/// <summary>
/// Exception thrown when FTP connection fails
/// </summary>
public class FtpConnectionException : FtpVirtualDriveException
{
    public string Host { get; }
    public int Port { get; }
    public string Username { get; }

    public FtpConnectionException(string host, int port, string username, string message) 
        : base($"Failed to connect to FTP server {host}:{port} as {username}: {message}")
    {
        Host = host;
        Port = port;
        Username = username;
    }

    public FtpConnectionException(string host, int port, string username, string message, Exception innerException) 
        : base($"Failed to connect to FTP server {host}:{port} as {username}: {message}", innerException)
    {
        Host = host;
        Port = port;
        Username = username;
    }
}

/// <summary>
/// Exception thrown when virtual drive operations fail
/// </summary>
public class VirtualDriveException : FtpVirtualDriveException
{
    public string? DriveLetter { get; }

    public VirtualDriveException(string message) : base(message) { }
    
    public VirtualDriveException(string driveLetter, string message) : base($"Virtual drive {driveLetter}: {message}")
    {
        DriveLetter = driveLetter;
    }

    public VirtualDriveException(string message, Exception innerException) : base(message, innerException) { }
}

/// <summary>
/// Exception thrown when file synchronization fails
/// </summary>
public class FileSyncException : FtpVirtualDriveException
{
    public string FilePath { get; }
    public string Operation { get; }

    public FileSyncException(string filePath, string operation, string message) 
        : base($"File sync failed for {filePath} during {operation}: {message}")
    {
        FilePath = filePath;
        Operation = operation;
    }

    public FileSyncException(string filePath, string operation, string message, Exception innerException) 
        : base($"File sync failed for {filePath} during {operation}: {message}", innerException)
    {
        FilePath = filePath;
        Operation = operation;
    }
}

/// <summary>
/// Exception thrown when version tracking operations fail
/// </summary>
public class VersionTrackingException : FtpVirtualDriveException
{
    public string FilePath { get; }
    public int? VersionId { get; }

    public VersionTrackingException(string filePath, string message) 
        : base($"Version tracking failed for {filePath}: {message}")
    {
        FilePath = filePath;
    }

    public VersionTrackingException(string filePath, int versionId, string message) 
        : base($"Version tracking failed for {filePath} (version {versionId}): {message}")
    {
        FilePath = filePath;
        VersionId = versionId;
    }

    public VersionTrackingException(string filePath, string message, Exception innerException) 
        : base($"Version tracking failed for {filePath}: {message}", innerException)
    {
        FilePath = filePath;
    }
}

/// <summary>
/// Exception thrown when credential operations fail
/// </summary>
public class CredentialException : FtpVirtualDriveException
{
    public string CredentialName { get; }

    public CredentialException(string credentialName, string message) 
        : base($"Credential operation failed for '{credentialName}': {message}")
    {
        CredentialName = credentialName;
    }

    public CredentialException(string credentialName, string message, Exception innerException) 
        : base($"Credential operation failed for '{credentialName}': {message}", innerException)
    {
        CredentialName = credentialName;
    }
}

/// <summary>
/// Exception thrown when activity logging fails
/// </summary>
public class ActivityLoggingException : FtpVirtualDriveException
{
    public ActivityLoggingException(string message) : base($"Activity logging failed: {message}") { }
    public ActivityLoggingException(string message, Exception innerException) : base($"Activity logging failed: {message}", innerException) { }
}
