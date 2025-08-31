using System.IO;
using System.Windows;
using FtpVirtualDrive.Core.Interfaces;
using FtpVirtualDrive.Infrastructure.Database;
using FtpVirtualDrive.Infrastructure.FTP;
using FtpVirtualDrive.Infrastructure.Security;
using FtpVirtualDrive.Infrastructure.VirtualFileSystem;
using FtpVirtualDrive.UI.ViewModels;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Serilog;
using Serilog.Extensions.Logging;

namespace FtpVirtualDrive.UI;

/// <summary>
/// Interaction logic for App.xaml
/// </summary>
public partial class App : Application
{
    private ServiceProvider? _serviceProvider;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // Configure Serilog
        Log.Logger = new LoggerConfiguration()
            .MinimumLevel.Debug()
            .WriteTo.File("logs/app-.log", rollingInterval: RollingInterval.Day)
            .WriteTo.Debug()
            .CreateLogger();

        // Configure services
        var services = new ServiceCollection();
        ConfigureServices(services);
        _serviceProvider = services.BuildServiceProvider();

        // Initialize database
        InitializeDatabase();

        // Show main window
        var mainWindow = _serviceProvider.GetRequiredService<MainWindow>();
        MainWindow = mainWindow;
        mainWindow.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        // Cleanup
        try
        {
            var virtualDrive = _serviceProvider?.GetService<IVirtualDrive>();
            virtualDrive?.UnmountAsync().Wait(5000); // Wait max 5 seconds

            var ftpClient = _serviceProvider?.GetService<IFtpClient>();
            ftpClient?.DisconnectAsync().Wait(5000);
        }
        catch (Exception ex)
        {
            Log.Logger?.Error(ex, "Error during application shutdown");
        }

        _serviceProvider?.Dispose();
        Log.CloseAndFlush();
        base.OnExit(e);
    }

    private static void ConfigureServices(IServiceCollection services)
    {
        // Configure logging
        services.AddLogging(builder =>
        {
            builder.ClearProviders();
            builder.AddSerilog(Log.Logger);
        });

        // Configure database
        var dbPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), 
            "FtpVirtualDrive", "app.db");
        var dbDirectory = Path.GetDirectoryName(dbPath);
        if (!Directory.Exists(dbDirectory))
            Directory.CreateDirectory(dbDirectory!);

        services.AddDbContext<AppDbContext>(options =>
            options.UseSqlite($"Data Source={dbPath}"));

        // Register caching and queue services
        services.AddMemoryCache();
        services.AddSingleton<IFileOperationQueue>(sp => 
            new FileOperationQueue(sp.GetRequiredService<ILogger<FileOperationQueue>>(), maxConcurrency: 8));
        
        // Register services
        services.AddSingleton<IFtpClient, FtpClientService>();
        // Use the new AsyncFtpVirtualFileSystem for better performance
        services.AddSingleton<IVirtualDrive, AsyncFtpVirtualFileSystem>();
        services.AddScoped<IVersionTracker, VersionTrackingService>();
        services.AddScoped<IActivityLogger, ActivityLoggingService>();
        services.AddScoped<IFileSyncService, FileSyncService>();
        services.AddSingleton<ICredentialManager, WindowsCredentialManager>();

        // Register ViewModels
        services.AddTransient<MainViewModel>();

        // Register Views
        services.AddTransient<MainWindow>();
    }

    private void InitializeDatabase()
    {
        try
        {
            using var scope = _serviceProvider!.CreateScope();
            var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            
            dbContext.Database.EnsureCreated();
            Log.Logger?.Information("Database initialized successfully");
        }
        catch (Exception ex)
        {
            Log.Logger?.Error(ex, "Failed to initialize database");
            MessageBox.Show($"Failed to initialize database: {ex.Message}", 
                "Database Error", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown();
        }
    }
}

