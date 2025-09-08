namespace FtpVirtualDrive.Core.Models;

/// <summary>
/// SSL validation modes for FTP connections
/// </summary>
public enum SslValidationMode
{
    /// <summary>
    /// Validate the certificate properly
    /// </summary>
    ValidateCertificate,
    
    /// <summary>
    /// Accept any certificate without validation
    /// </summary>
    AcceptAnyCertificate,
    
    /// <summary>
    /// Accept certificate from trusted authorities only
    /// </summary>
    TrustedAuthoritiesOnly
}

/// <summary>
/// File operation types for logging
/// </summary>
public enum OperationType
{
    Connect,
    Disconnect,
    Download,
    Upload,
    Delete,
    Create,
    Open,
    Modify,
    Rename,
    Move,
    Copy,
    ListDirectory,
    CreateDirectory,
    DeleteDirectory,
    // New operations for FTP Explorer
    OpenFile,
    EditFile,
    UploadFile,
    DownloadFile,
    PreviewFile,
    RefreshDirectory,
    NavigateUp,
    NavigateToDirectory
}

/// <summary>
/// Sync status for files
/// </summary>
public enum SyncStatus
{
    Unknown,
    InSync,
    NeedsUpload,
    NeedsDownload,
    Conflict,
    Error,
    Syncing
}

/// <summary>
/// Conflict resolution strategies
/// </summary>
public enum ConflictResolution
{
    UseLocal,
    UseRemote,
    CreateBackup,
    ManualResolve
}

/// <summary>
/// Log export formats
/// </summary>
public enum LogExportFormat
{
    Csv,
    Json,
    Xml,
    Text
}

/// <summary>
/// Validation result
/// </summary>
public record ValidationResult(bool IsValid, IEnumerable<string> Errors);

/// <summary>
/// File information from FTP server
/// </summary>
public class FtpFileInfo
{
    public string Name { get; set; } = string.Empty;
    public string FullPath { get; set; } = string.Empty;
    public bool IsDirectory { get; set; }
    public long Size { get; set; }
    public DateTime LastModified { get; set; }
    public string Permissions { get; set; } = string.Empty;
    public string Owner { get; set; } = string.Empty;
    public string Group { get; set; } = string.Empty;
}

/// <summary>
/// Event arguments for FTP operations
/// </summary>
public class FtpOperationEventArgs : EventArgs
{
    public OperationType Operation { get; set; }
    public string FilePath { get; set; } = string.Empty;
    public bool Success { get; set; }
    public string? ErrorMessage { get; set; }
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
    public long? FileSize { get; set; }
    public long? DurationMs { get; set; }
}

/// <summary>
/// Event arguments for virtual file system operations
/// </summary>
public class VirtualFileSystemEventArgs : EventArgs
{
    public string FilePath { get; set; } = string.Empty;
    public OperationType Operation { get; set; }
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
    public bool Success { get; set; }
    public string? ErrorMessage { get; set; }
}

/// <summary>
/// Event arguments for mount status changes
/// </summary>
public class MountStatusEventArgs : EventArgs
{
    public bool IsMounted { get; set; }
    public string? DriveLetter { get; set; }
    public string? ErrorMessage { get; set; }
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// Sync operation result
/// </summary>
public class SyncResult
{
    public bool Success { get; set; }
    public string? ErrorMessage { get; set; }
    public SyncStatus Status { get; set; }
    public DateTime SyncTime { get; set; } = DateTime.UtcNow;
    public long? BytesTransferred { get; set; }
}

/// <summary>
/// Event arguments for sync completion
/// </summary>
public class SyncCompletedEventArgs : EventArgs
{
    public string FilePath { get; set; } = string.Empty;
    public SyncResult Result { get; set; } = new();
    public OperationType Operation { get; set; }
}

/// <summary>
/// Event arguments for sync conflicts
/// </summary>
public class SyncConflictEventArgs : EventArgs
{
    public string FilePath { get; set; } = string.Empty;
    public DateTime LocalModified { get; set; }
    public DateTime RemoteModified { get; set; }
    public ConflictResolution Resolution { get; set; }
}

/// <summary>
/// Conflict resolution result
/// </summary>
public class ConflictResolutionResult
{
    public bool Success { get; set; }
    public ConflictResolution Resolution { get; set; }
    public string? ErrorMessage { get; set; }
    public string? BackupPath { get; set; }
}

/// <summary>
/// Activity statistics
/// </summary>
public class ActivityStatistics
{
    public int TotalOperations { get; set; }
    public int SuccessfulOperations { get; set; }
    public int FailedOperations { get; set; }
    public long TotalBytesTransferred { get; set; }
    public Dictionary<OperationType, int> OperationCounts { get; set; } = new();
    public DateTime? FirstActivity { get; set; }
    public DateTime? LastActivity { get; set; }
}
