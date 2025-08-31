using FtpVirtualDrive.Core.Models;

namespace FtpVirtualDrive.Core.Interfaces;

/// <summary>
/// Defines the contract for credential management operations
/// </summary>
public interface ICredentialManager
{
    /// <summary>
    /// Stores FTP credentials securely
    /// </summary>
    /// <param name="connectionInfo">Connection information to store</param>
    /// <param name="credentialName">Name to identify the credential</param>
    /// <returns>True if storage was successful</returns>
    Task<bool> StoreCredentialsAsync(FtpConnectionInfo connectionInfo, string credentialName);

    /// <summary>
    /// Retrieves stored FTP credentials
    /// </summary>
    /// <param name="credentialName">Name of the credential to retrieve</param>
    /// <returns>Connection information or null if not found</returns>
    Task<FtpConnectionInfo?> RetrieveCredentialsAsync(string credentialName);

    /// <summary>
    /// Deletes stored credentials
    /// </summary>
    /// <param name="credentialName">Name of the credential to delete</param>
    /// <returns>True if deletion was successful</returns>
    Task<bool> DeleteCredentialsAsync(string credentialName);

    /// <summary>
    /// Lists all stored credential names
    /// </summary>
    /// <returns>Collection of credential names</returns>
    Task<IEnumerable<string>> ListCredentialsAsync();

    /// <summary>
    /// Checks if credentials exist for the given name
    /// </summary>
    /// <param name="credentialName">Name of the credential to check</param>
    /// <returns>True if credentials exist</returns>
    Task<bool> CredentialsExistAsync(string credentialName);
}
