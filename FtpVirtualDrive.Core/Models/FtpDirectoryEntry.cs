namespace FtpVirtualDrive.Core.Models;

/// <summary>
/// Represents a directory entry in the FTP file explorer
/// </summary>
public class FtpDirectoryEntry
{
    /// <summary>
    /// Name of the file or directory
    /// </summary>
    public string Name { get; set; } = string.Empty;
    
    /// <summary>
    /// Full path on the FTP server
    /// </summary>
    public string FullPath { get; set; } = string.Empty;
    
    /// <summary>
    /// Parent directory path
    /// </summary>
    public string ParentPath { get; set; } = string.Empty;
    
    /// <summary>
    /// File size in bytes (0 for directories)
    /// </summary>
    public long Size { get; set; }
    
    /// <summary>
    /// Whether this entry is a directory
    /// </summary>
    public bool IsDirectory { get; set; }
    
    /// <summary>
    /// Last modified date and time in UTC
    /// </summary>
    public DateTime LastModifiedUtc { get; set; }
    
    /// <summary>
    /// File permissions (if available)
    /// </summary>
    public string Permissions { get; set; } = string.Empty;
    
    /// <summary>
    /// Owner name (if available)
    /// </summary>
    public string Owner { get; set; } = string.Empty;
    
    /// <summary>
    /// Group name (if available)
    /// </summary>
    public string Group { get; set; } = string.Empty;
    
    /// <summary>
    /// File extension (without dot, empty for directories)
    /// </summary>
    public string Extension => IsDirectory ? string.Empty : 
        System.IO.Path.GetExtension(Name).TrimStart('.');
    
    /// <summary>
    /// Display name for UI
    /// </summary>
    public string DisplayName => Name;
    
    /// <summary>
    /// Formatted size string for UI display
    /// </summary>
    public string FormattedSize => IsDirectory ? "Folder" : FormatBytes(Size);
    
    /// <summary>
    /// File type description for UI
    /// </summary>
    public string FileType => GetFileTypeDescription();
    
    /// <summary>
    /// Whether the file is a text file (can be edited)
    /// </summary>
    public bool IsTextFile => !IsDirectory && IsTextFileExtension(Extension);
    
    /// <summary>
    /// Whether the file is an image file (can be previewed)
    /// </summary>
    public bool IsImageFile => !IsDirectory && IsImageFileExtension(Extension);
    
    private static string FormatBytes(long bytes)
    {
        const int scale = 1024;
        string[] orders = { "GB", "MB", "KB", "Bytes" };
        long max = (long)Math.Pow(scale, orders.Length - 1);

        foreach (string order in orders)
        {
            if (bytes > max)
                return string.Format("{0:##.##} {1}", decimal.Divide(bytes, max), order);
            max /= scale;
        }
        return "0 Bytes";
    }
    
    private string GetFileTypeDescription()
    {
        if (IsDirectory)
            return "Folder";
            
        return Extension.ToLowerInvariant() switch
        {
            "txt" => "Text Document",
            "log" => "Log File",
            "xml" => "XML Document",
            "json" => "JSON File",
            "csv" => "CSV File",
            "html" or "htm" => "HTML Document",
            "css" => "CSS Style Sheet",
            "js" => "JavaScript File",
            "cs" => "C# Source File",
            "cpp" or "cc" => "C++ Source File",
            "h" => "Header File",
            "py" => "Python Script",
            "java" => "Java Source File",
            "php" => "PHP Script",
            "sql" => "SQL Script",
            "md" => "Markdown Document",
            "yml" or "yaml" => "YAML File",
            "ini" => "Configuration File",
            "cfg" => "Configuration File",
            "conf" => "Configuration File",
            "jpg" or "jpeg" => "JPEG Image",
            "png" => "PNG Image",
            "gif" => "GIF Image",
            "bmp" => "Bitmap Image",
            "ico" => "Icon File",
            "svg" => "SVG Image",
            "pdf" => "PDF Document",
            "doc" or "docx" => "Word Document",
            "xls" or "xlsx" => "Excel Workbook",
            "ppt" or "pptx" => "PowerPoint Presentation",
            "zip" => "ZIP Archive",
            "rar" => "RAR Archive",
            "7z" => "7-Zip Archive",
            "tar" => "TAR Archive",
            "gz" => "GZIP Archive",
            "exe" => "Executable File",
            "dll" => "Dynamic Link Library",
            "msi" => "Windows Installer",
            _ => Extension.ToUpperInvariant() + " File"
        };
    }
    
    private static bool IsTextFileExtension(string extension)
    {
        var textExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "txt", "log", "xml", "json", "csv", "html", "htm", "css", "js", 
            "cs", "cpp", "cc", "h", "py", "java", "php", "sql", "md", 
            "yml", "yaml", "ini", "cfg", "conf", "bat", "cmd", "ps1",
            "vbs", "reg", "properties", "config", "settings"
        };
        
        return textExtensions.Contains(extension);
    }
    
    private static bool IsImageFileExtension(string extension)
    {
        var imageExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "jpg", "jpeg", "png", "gif", "bmp", "ico", "svg", "tiff", "tif", "webp"
        };
        
        return imageExtensions.Contains(extension);
    }
}
