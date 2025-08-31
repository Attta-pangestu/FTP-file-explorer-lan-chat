# Dokan Integration Guide

## Overview

This document provides guidance for integrating DokanNet 2.3.0.1 with the FTP Virtual Drive application.

## Prerequisites

### Required Software
- **Windows OS**: Dokan file system driver only supports Windows
- **.NET 9.0**: Required for application runtime
- **Dokan Driver**: Version 2.0.6 or higher (automatically installed with DokanNet NuGet package)

### NuGet Packages
```xml
<PackageReference Include="DokanNet" Version="2.3.0.1" />
```

## Key API Changes in DokanNet 2.3

### Breaking Changes from v1.x

1. **DokanInstanceBuilder Constructor**
   - **Old**: `new DokanInstanceBuilder()`
   - **New**: `new DokanInstanceBuilder(dokan)` - requires Dokan instance

2. **Dokan Constructor**
   - **Old**: `new Dokan()`  
   - **New**: `new Dokan(logger)` - requires ILogger parameter

3. **Threading Configuration**
   - **Removed**: `options.ThreadCount` property
   - **New**: Threading is managed internally by DokanNet

4. **Platform Support**
   - **Required**: `[SupportedOSPlatform("windows")]` attribute on classes using Dokan APIs

## Implementation Pattern

### Recommended Setup

```csharp
[SupportedOSPlatform("windows")]
public class FtpVirtualFileSystem : IDokanOperations
{
    public async Task<bool> MountAsync(string driveLetter, IFtpClient ftpClient)
    {
        // Create logger and Dokan wrapper
        var dokanLogger = new ConsoleLogger("[Dokan] ");
        var dokan = new Dokan(dokanLogger);
        
        // Build instance with proper options
        var builder = new DokanInstanceBuilder(dokan)
            .ConfigureOptions(options =>
            {
                options.MountPoint = driveLetter + ":\\";
                options.Options = DokanOptions.DebugMode | DokanOptions.StderrOutput;
            })
            .ConfigureLogger(() => dokanLogger);
            
        var dokanInstance = builder.Build(this);
        
        // Handle background mounting
        _ = Task.Run(async () =>
        {
            await dokanInstance.WaitForFileSystemClosedAsync(uint.MaxValue);
            // Handle unmount cleanup
        });
        
        return true;
    }
}
```

### Safe Disposal Pattern

```csharp
public void Dispose()
{
    if (OperatingSystem.IsWindows())
    {
        _dokanInstance?.Dispose();
        _dokan?.Dispose();
    }
}
```

## Common Issues & Solutions

### Build Errors

#### CS7036: Missing required parameter 'dokan'
**Problem**: `new DokanInstanceBuilder()` called without parameters  
**Solution**: Pass Dokan instance: `new DokanInstanceBuilder(dokan)`

#### CS1061: 'DOKAN_OPTIONS' does not contain 'ThreadCount'
**Problem**: ThreadCount property was removed in v2.3  
**Solution**: Remove ThreadCount assignment - threading is now handled internally

#### CA1416: Platform-specific API usage
**Problem**: Dokan APIs called without platform guards  
**Solution**: Add `[SupportedOSPlatform("windows")]` and wrap dispose calls

### Runtime Issues

#### Mount Failure: "Dokan driver not found"
**Solution**: 
1. Install Dokan driver manually from [dokan-dev.github.io](https://dokan-dev.github.io)
2. Restart application as Administrator
3. Check Windows services for "Dokan" service status

#### Access Denied Errors
**Solution**:
1. Run application as Administrator
2. Check Windows Defender / antivirus exclusions
3. Verify drive letter is not in use

#### File Operations Fail
**Solution**:
1. Verify FTP connection is active before mounting
2. Check FTP server permissions for the authenticated user
3. Enable debug logging: `DokanOptions.DebugMode | DokanOptions.StderrOutput`

## Performance Considerations

### File Caching Strategy
- Cache frequently accessed files in memory
- Use `ConcurrentDictionary<string, Stream>` for thread-safe file handle management
- Implement cleanup in `CleanupFile()` method

### Background Operations
- Use `Task.Run()` for FTP upload/download operations
- Implement async logging to avoid blocking file operations
- Handle FTP timeouts gracefully

### Memory Management
- Dispose streams properly in cleanup methods
- Use `MemoryStream` for write operations
- Clear caches on unmount

## Debugging

### Enable Detailed Logging

```csharp
var options = new DOKAN_OPTIONS
{
    Options = DokanOptions.DebugMode | DokanOptions.StderrOutput,
    // ... other options
};
```

### Log File Locations
- Application logs: `logs/app-{date}.log`
- Dokan driver logs: Check Windows Event Viewer > Applications and Services > Dokan

### Common Debug Steps
1. Check if Dokan driver is loaded: `sc query dokan1`
2. Verify no other applications are using the target drive letter
3. Test FTP connection independently before mounting
4. Use Process Monitor to trace file system calls

## Testing Checklist

### Pre-deployment Verification
- [ ] Mount virtual drive successfully
- [ ] Drive appears in Windows Explorer
- [ ] Create new file via Explorer
- [ ] Edit file in Notepad/Word
- [ ] Save file and verify FTP upload
- [ ] Delete file and verify FTP removal  
- [ ] Unmount cleanly without errors
- [ ] Check activity logs in SQLite database

### Performance Tests
- [ ] Large file upload (>100MB)
- [ ] Multiple concurrent file operations
- [ ] Long-running mount sessions (>1 hour)
- [ ] Memory usage stability
- [ ] FTP connection recovery after network interruption

## Troubleshooting Commands

```powershell
# Check Dokan driver status
sc query dokan1

# List mounted drives
Get-WmiObject -Class Win32_LogicalDisk | Select DeviceID, DriveType, ProviderName

# Check file system events
Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Dokan'} -MaxEvents 50

# Test FTP connection manually
Test-NetConnection -ComputerName "your-ftp-server" -Port 21
```

## Version History

- **v2.3.0.1**: Current version with simplified threading and improved logging
- **v1.5.x**: Legacy version (deprecated) - requires migration

For additional support, refer to the [DokanNet GitHub Issues](https://github.com/dokan-dev/dokan-dotnet/issues) page.
