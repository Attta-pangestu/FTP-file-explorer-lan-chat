using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using System.Text.Json;
using FtpVirtualDrive.Core.Interfaces;
using FtpVirtualDrive.Core.Models;
using Microsoft.Extensions.Logging;

namespace FtpVirtualDrive.Infrastructure.Security;

/// <summary>
/// Windows Credential Manager implementation for secure credential storage
/// </summary>
public class WindowsCredentialManager : ICredentialManager
{
    private const string CredentialTargetPrefix = "FtpVirtualDrive_";
    private readonly ILogger<WindowsCredentialManager> _logger;

    public WindowsCredentialManager(ILogger<WindowsCredentialManager> logger)
    {
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async Task<bool> StoreCredentialsAsync(FtpConnectionInfo connectionInfo, string credentialName)
    {
        return await Task.Run(() =>
        {
            try
            {
                var targetName = GetTargetName(credentialName);
                var credentialData = SerializeCredentials(connectionInfo);

                var credential = new CREDENTIAL
                {
                    Type = CRED_TYPE_GENERIC,
                    TargetName = Marshal.StringToCoTaskMemUni(targetName),
                    CredentialBlobSize = (uint)Encoding.UTF8.GetByteCount(credentialData),
                    CredentialBlob = Marshal.StringToCoTaskMemAnsi(credentialData),
                    Persist = CRED_PERSIST_LOCAL_MACHINE,
                    UserName = Marshal.StringToCoTaskMemUni(connectionInfo.Username),
                    Comment = Marshal.StringToCoTaskMemUni($"FTP Virtual Drive - {connectionInfo.Host}:{connectionInfo.Port}")
                };

                var result = CredWrite(ref credential, 0);

                // Clean up allocated memory
                Marshal.FreeCoTaskMem(credential.TargetName);
                Marshal.FreeCoTaskMem(credential.CredentialBlob);
                Marshal.FreeCoTaskMem(credential.UserName);
                Marshal.FreeCoTaskMem(credential.Comment);

                if (result)
                {
                    _logger.LogInformation("Successfully stored credentials for {CredentialName}", credentialName);
                }
                else
                {
                    _logger.LogError("Failed to store credentials for {CredentialName}. Error: {Error}", 
                        credentialName, Marshal.GetLastWin32Error());
                }

                return result;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error storing credentials for {CredentialName}", credentialName);
                return false;
            }
        });
    }

    public async Task<FtpConnectionInfo?> RetrieveCredentialsAsync(string credentialName)
    {
        return await Task.Run(() =>
        {
            try
            {
                var targetName = GetTargetName(credentialName);
                
                if (CredRead(targetName, CRED_TYPE_GENERIC, 0, out var credentialPtr))
                {
                    var credential = Marshal.PtrToStructure<CREDENTIAL>(credentialPtr);
                    var credentialData = Marshal.PtrToStringAnsi(credential.CredentialBlob, (int)credential.CredentialBlobSize);
                    
                    CredFree(credentialPtr);

                    if (!string.IsNullOrEmpty(credentialData))
                    {
                        var connectionInfo = DeserializeCredentials(credentialData);
                        _logger.LogDebug("Successfully retrieved credentials for {CredentialName}", credentialName);
                        return connectionInfo;
                    }
                }
                else
                {
                    _logger.LogWarning("Credentials not found for {CredentialName}. Error: {Error}", 
                        credentialName, Marshal.GetLastWin32Error());
                }

                return null;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error retrieving credentials for {CredentialName}", credentialName);
                return null;
            }
        });
    }

    public async Task<bool> DeleteCredentialsAsync(string credentialName)
    {
        return await Task.Run(() =>
        {
            try
            {
                var targetName = GetTargetName(credentialName);
                var result = CredDelete(targetName, CRED_TYPE_GENERIC, 0);

                if (result)
                {
                    _logger.LogInformation("Successfully deleted credentials for {CredentialName}", credentialName);
                }
                else
                {
                    _logger.LogWarning("Failed to delete credentials for {CredentialName}. Error: {Error}", 
                        credentialName, Marshal.GetLastWin32Error());
                }

                return result;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error deleting credentials for {CredentialName}", credentialName);
                return false;
            }
        });
    }

    public async Task<IEnumerable<string>> ListCredentialsAsync()
    {
        return await Task.Run<IEnumerable<string>>(() =>
        {
            try
            {
                var credentials = new List<string>();
                var filter = CredentialTargetPrefix + "*";

                if (CredEnumerate(filter, 0, out var count, out var credentialPtrs))
                {
                    var ptrs = new IntPtr[count];
                    Marshal.Copy(credentialPtrs, ptrs, 0, (int)count);

                    for (int i = 0; i < count; i++)
                    {
                        var credential = Marshal.PtrToStructure<CREDENTIAL>(ptrs[i]);
                        var targetName = Marshal.PtrToStringUni(credential.TargetName);
                        
                        if (!string.IsNullOrEmpty(targetName) && targetName.StartsWith(CredentialTargetPrefix))
                        {
                            var credentialName = targetName.Substring(CredentialTargetPrefix.Length);
                            credentials.Add(credentialName);
                        }
                    }

                    CredFree(credentialPtrs);
                }

                return (IEnumerable<string>)credentials;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error listing stored credentials");
                return Array.Empty<string>();
            }
        });
    }

    public async Task<bool> CredentialsExistAsync(string credentialName)
    {
        return await Task.Run(() =>
        {
            try
            {
                var targetName = GetTargetName(credentialName);
                
                if (CredRead(targetName, CRED_TYPE_GENERIC, 0, out var credentialPtr))
                {
                    CredFree(credentialPtr);
                    return true;
                }

                return false;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error checking if credentials exist for {CredentialName}", credentialName);
                return false;
            }
        });
    }

    private static string GetTargetName(string credentialName)
    {
        return CredentialTargetPrefix + credentialName;
    }

    private static string SerializeCredentials(FtpConnectionInfo connectionInfo)
    {
        var options = new JsonSerializerOptions
        {
            WriteIndented = false
        };
        return JsonSerializer.Serialize(connectionInfo, options);
    }

    private static FtpConnectionInfo? DeserializeCredentials(string credentialData)
    {
        try
        {
            return JsonSerializer.Deserialize<FtpConnectionInfo>(credentialData);
        }
        catch
        {
            return null;
        }
    }

    #region Windows API Declarations

    private const uint CRED_TYPE_GENERIC = 1;
    private const uint CRED_PERSIST_LOCAL_MACHINE = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct CREDENTIAL
    {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredDelete(string target, uint type, uint reservedFlag);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredEnumerate(string filter, uint reservedFlag, out uint count, out IntPtr credentialPtrs);

    [DllImport("advapi32.dll")]
    private static extern void CredFree([In] IntPtr cred);

    #endregion
}
