using Microsoft.EntityFrameworkCore;
using FtpVirtualDrive.Core.Models;

namespace FtpVirtualDrive.Infrastructure.Database;

/// <summary>
/// Entity Framework database context for the FTP Virtual Drive application
/// </summary>
public class AppDbContext : DbContext
{
    /// <summary>
    /// Activity logs table
    /// </summary>
    public DbSet<ActivityLog> ActivityLogs { get; set; }

    /// <summary>
    /// File versions table
    /// </summary>
    public DbSet<FileVersion> FileVersions { get; set; }

    /// <summary>
    /// Connection history table
    /// </summary>
    public DbSet<ConnectionHistory> ConnectionHistory { get; set; }

    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options)
    {
    }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        // Configure ActivityLog entity
        modelBuilder.Entity<ActivityLog>(entity =>
        {
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Timestamp).IsRequired();
            entity.Property(e => e.Operation).IsRequired().HasConversion<string>();
            entity.Property(e => e.FilePath).IsRequired().HasMaxLength(500);
            entity.Property(e => e.Details).HasMaxLength(1000);
            entity.Property(e => e.UserName).HasMaxLength(100);
            entity.Property(e => e.ErrorMessage).HasMaxLength(1000);
            entity.Property(e => e.SourceIp).HasMaxLength(45);
            entity.Property(e => e.SessionId).HasMaxLength(100);

            // Index for performance
            entity.HasIndex(e => e.Timestamp);
            entity.HasIndex(e => e.Operation);
            entity.HasIndex(e => e.FilePath);
        });

        // Configure FileVersion entity
        modelBuilder.Entity<FileVersion>(entity =>
        {
            entity.HasKey(e => e.Id);
            entity.Property(e => e.FilePath).IsRequired().HasMaxLength(500);
            entity.Property(e => e.ContentHash).IsRequired().HasMaxLength(64);
            entity.Property(e => e.CreatedAt).IsRequired();
            entity.Property(e => e.Comment).HasMaxLength(500);
            entity.Property(e => e.CreatedBy).HasMaxLength(100);
            entity.Property(e => e.Source).HasConversion<string>();

            // Unique constraint on file path and version number
            entity.HasIndex(e => new { e.FilePath, e.VersionNumber }).IsUnique();
            entity.HasIndex(e => e.FilePath);
            entity.HasIndex(e => e.ContentHash);
        });

        // Configure ConnectionHistory entity
        modelBuilder.Entity<ConnectionHistory>(entity =>
        {
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Host).IsRequired().HasMaxLength(200);
            entity.Property(e => e.Username).IsRequired().HasMaxLength(100);
            entity.Property(e => e.ConnectionName).HasMaxLength(100);
            entity.Property(e => e.LastConnected).IsRequired();

            // Index for performance
            entity.HasIndex(e => new { e.Host, e.Port, e.Username });
            entity.HasIndex(e => e.LastConnected);
        });
    }

    /// <summary>
    /// Ensures the database is created and migrated
    /// </summary>
    public async Task EnsureDatabaseCreatedAsync()
    {
        await Database.EnsureCreatedAsync();
    }

    /// <summary>
    /// Seeds initial data if needed
    /// </summary>
    public async Task SeedDataAsync()
    {
        // Add any initial data seeding here
        await SaveChangesAsync();
    }
}

/// <summary>
/// Represents connection history for the UI
/// </summary>
public class ConnectionHistory
{
    public int Id { get; set; }
    public string Host { get; set; } = string.Empty;
    public int Port { get; set; }
    public string Username { get; set; } = string.Empty;
    public string ConnectionName { get; set; } = string.Empty;
    public DateTime LastConnected { get; set; }
    public bool IsSuccessful { get; set; }
    public int ConnectionCount { get; set; }
}
