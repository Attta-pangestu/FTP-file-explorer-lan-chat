using System.Security.Cryptography;
using System.Text;
using FtpVirtualDrive.Core.Interfaces;
using FtpVirtualDrive.Core.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace FtpVirtualDrive.Infrastructure.Database;

/// <summary>
/// Version tracking service implementation using Entity Framework
/// </summary>
public class VersionTrackingService : IVersionTracker
{
    private readonly AppDbContext _dbContext;
    private readonly ILogger<VersionTrackingService> _logger;

    public VersionTrackingService(AppDbContext dbContext, ILogger<VersionTrackingService> logger)
    {
        _dbContext = dbContext ?? throw new ArgumentNullException(nameof(dbContext));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async Task<FileVersion> SaveVersionAsync(string filePath, byte[] content, string contentHash)
    {
        try
        {
            // Check if this exact content already exists
            var existingVersion = await _dbContext.FileVersions
                .FirstOrDefaultAsync(v => v.FilePath == filePath && v.ContentHash == contentHash);

            if (existingVersion != null)
            {
                _logger.LogDebug("Content hash {Hash} already exists for {FilePath}, skipping duplicate version", 
                    contentHash, filePath);
                return existingVersion;
            }

            // Get the next version number
            var nextVersionNumber = await GetNextVersionNumberAsync(filePath);

            var fileVersion = new FileVersion
            {
                FilePath = filePath,
                VersionNumber = nextVersionNumber,
                ContentHash = contentHash,
                FileSize = content.Length,
                Content = content,
                CreatedAt = DateTime.UtcNow,
                CreatedBy = Environment.UserName,
                Source = VersionSource.AutoSync
            };

            _dbContext.FileVersions.Add(fileVersion);
            await _dbContext.SaveChangesAsync();

            _logger.LogInformation("Saved version {VersionNumber} for file {FilePath} (Hash: {Hash})", 
                fileVersion.VersionNumber, filePath, contentHash);

            return fileVersion;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to save version for file {FilePath}", filePath);
            throw;
        }
    }

    public async Task<IEnumerable<FileVersion>> GetVersionsAsync(string filePath)
    {
        try
        {
            return await _dbContext.FileVersions
                .Where(v => v.FilePath == filePath)
                .OrderByDescending(v => v.VersionNumber)
                .ToListAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to retrieve versions for file {FilePath}", filePath);
            throw;
        }
    }

    public async Task<byte[]?> GetVersionContentAsync(string filePath, int versionId)
    {
        try
        {
            var version = await _dbContext.FileVersions
                .FirstOrDefaultAsync(v => v.Id == versionId && v.FilePath == filePath);

            return version?.Content;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to retrieve content for version {VersionId} of file {FilePath}", 
                versionId, filePath);
            throw;
        }
    }

    public async Task<FileVersion?> GetLatestVersionAsync(string filePath)
    {
        try
        {
            return await _dbContext.FileVersions
                .Where(v => v.FilePath == filePath)
                .OrderByDescending(v => v.VersionNumber)
                .FirstOrDefaultAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to retrieve latest version for file {FilePath}", filePath);
            throw;
        }
    }

    public async Task<bool> RollbackToVersionAsync(string filePath, int versionId)
    {
        try
        {
            var version = await _dbContext.FileVersions
                .FirstOrDefaultAsync(v => v.Id == versionId && v.FilePath == filePath);

            if (version == null)
            {
                _logger.LogWarning("Version {VersionId} not found for file {FilePath}", versionId, filePath);
                return false;
            }

            // Create a new version from the rollback content
            var newHash = CalculateContentHash(version.Content);
            var newVersion = new FileVersion
            {
                FilePath = filePath,
                VersionNumber = await GetNextVersionNumberAsync(filePath),
                ContentHash = newHash,
                FileSize = version.Content.Length,
                Content = version.Content,
                CreatedAt = DateTime.UtcNow,
                CreatedBy = Environment.UserName,
                Source = VersionSource.Manual,
                Comment = $"Rolled back to version {version.VersionNumber}"
            };

            _dbContext.FileVersions.Add(newVersion);
            await _dbContext.SaveChangesAsync();

            _logger.LogInformation("Rolled back file {FilePath} to version {VersionNumber}", 
                filePath, version.VersionNumber);

            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to rollback file {FilePath} to version {VersionId}", 
                filePath, versionId);
            return false;
        }
    }

    public async Task<int> CleanupOldVersionsAsync(string filePath, int versionsToKeep = 10)
    {
        try
        {
            var versions = await _dbContext.FileVersions
                .Where(v => v.FilePath == filePath && !v.IsImportant)
                .OrderByDescending(v => v.VersionNumber)
                .Skip(versionsToKeep)
                .ToListAsync();

            if (versions.Count == 0)
                return 0;

            _dbContext.FileVersions.RemoveRange(versions);
            await _dbContext.SaveChangesAsync();

            _logger.LogInformation("Cleaned up {Count} old versions for file {FilePath}", 
                versions.Count, filePath);

            return versions.Count;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to cleanup old versions for file {FilePath}", filePath);
            throw;
        }
    }

    public string CalculateContentHash(byte[] content)
    {
        using var sha256 = SHA256.Create();
        var hashBytes = sha256.ComputeHash(content);
        return Convert.ToHexString(hashBytes).ToLowerInvariant();
    }

    private async Task<int> GetNextVersionNumberAsync(string filePath)
    {
        var maxVersion = await _dbContext.FileVersions
            .Where(v => v.FilePath == filePath)
            .MaxAsync(v => (int?)v.VersionNumber);

        return (maxVersion ?? 0) + 1;
    }
}
