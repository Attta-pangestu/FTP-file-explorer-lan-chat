using System;
using System.IO;
using System.Windows;
using WpfApplication = System.Windows.Application;
using WpfMessageBox = System.Windows.MessageBox;
using FtpVirtualDrive.Core.Interfaces;
using FtpVirtualDrive.Infrastructure.Database;
using FtpVirtualDrive.Infrastructure.FTP;
using FtpVirtualDrive.Infrastructure.Security;
using FtpVirtualDrive.Infrastructure.VirtualFileSystem;
using FtpVirtualDrive.Infrastructure.Services;
using FtpVirtualDrive.UI.ViewModels;
using FtpVirtualDrive.UI.Views;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Serilog;
using Serilog.Extensions.Logging;

namespace FtpVirtualDrive.UI;

/// <summary>
/// Interaction logic for App.xaml
/// </summary>
public partial class App : System.Windows.Application
{
    private ServiceProvider? _serviceProvider;
    
    public ServiceProvider? ServiceProvider => _serviceProvider;

    protected override void OnStartup(StartupEventArgs e)
    {
        try
        {
            base.OnStartup(e);

            // Ensure logs directory exists
            Directory.CreateDirectory("logs");

            // Configure Serilog with immediate flush
            Log.Logger = new LoggerConfiguration()
                .MinimumLevel.Debug()
                .WriteTo.File("logs/app-.log", rollingInterval: RollingInterval.Day, flushToDiskInterval: TimeSpan.FromSeconds(1))
                .WriteTo.Debug()
                .CreateLogger();

            Log.Logger.Information("=== APPLICATION STARTUP INITIATED ===");
            Log.Logger.Information("Current Directory: {CurrentDir}", Directory.GetCurrentDirectory());
            Log.Logger.Information("Application Version: {Version}", System.Reflection.Assembly.GetExecutingAssembly().GetName().Version);
            Log.CloseAndFlush(); // Force immediate write

            // Check Dokan driver installation first
            Log.Logger.Information("Starting Dokan driver check...");
            Log.CloseAndFlush();
            
            if (!IsDokanDriverInstalled())
            {
                var errorMessage = "Dokan driver is not installed.\n\n" +
                                 "To enable virtual drive mounting, please:\n" +
                                 "1. Download Dokan Library from: https://github.com/dokan-dev/dokany/releases\n" +
                                 "2. Install the latest stable release (recommended: v2.0.6.1000 or later)\n" +
                                 "3. Restart this application\n\n" +
                                 "Note: You may need administrator privileges to install the driver.";
                
                Log.Logger.Error("Dokan driver not found - application cannot function without it");
                Log.CloseAndFlush();
                WpfMessageBox.Show(errorMessage, "Dokan Driver Required", MessageBoxButton.OK, MessageBoxImage.Warning);
                Shutdown(1);
                return;
            }

            Log.Logger.Information("Dokan driver detected successfully");
            Log.CloseAndFlush();

            // Configure services
            var services = new ServiceCollection();
            ConfigureServices(services);
            _serviceProvider = services.BuildServiceProvider();

            Log.Logger.Information("Services configured successfully");

            // Initialize database
            InitializeDatabase();

            Log.Logger.Information("Database initialized successfully");

            // Show main window
            var mainWindow = _serviceProvider.GetRequiredService<MainWindow>();
            MainWindow = mainWindow;
            mainWindow.Show();

            Log.Logger.Information("Main window displayed successfully");
        }
        catch (Exception ex)
        {
            var errorMessage = $"Failed to start application: {ex.Message}\n\nDetails: {ex}";
            
            // Try to log the error
            try
            {
                Log.Logger?.Error(ex, "Application startup failed");
            }
            catch { /* Ignore logging errors */ }

            // Show error to user
            WpfMessageBox.Show(errorMessage, "Application Startup Error", 
                MessageBoxButton.OK, MessageBoxImage.Error);
            
            // Exit the application
            Shutdown(1);
        }
    }

    private bool IsDokanDriverInstalled()
    {
        try
        {
            // Check for Dokan installation directory
            var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            var dokanPath = Path.Combine(programFiles, "Dokan");
            
            if (Directory.Exists(dokanPath))
            {
                var dokanDirs = Directory.GetDirectories(dokanPath, "Dokan Library-*");
                if (dokanDirs.Length > 0)
                {
                    Log.Logger?.Information("Dokan installation found at: {DokanPath}", dokanDirs[0]);
                    return true;
                }
            }
            
            // Check for Dokan system driver using sc command
            using var process = new System.Diagnostics.Process();
            process.StartInfo.FileName = "sc";
            process.StartInfo.Arguments = "query dokan1";
            process.StartInfo.UseShellExecute = false;
            process.StartInfo.RedirectStandardOutput = true;
            process.StartInfo.CreateNoWindow = true;
            
            process.Start();
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit();
            
            var isInstalled = process.ExitCode == 0 && output.Contains("SERVICE_NAME: dokan1");
            Log.Logger?.Information("Dokan driver service check - ExitCode: {ExitCode}, Found: {Found}", process.ExitCode, isInstalled);
            return isInstalled;
        }
        catch (Exception ex)
        {
            Log.Logger?.Warning(ex, "Error checking Dokan driver installation");
            return false;
        }
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
        // Use the regular FtpVirtualFileSystem that we've been debugging
        services.AddSingleton<IVirtualDrive, FtpVirtualFileSystem>();
        services.AddScoped<IVersionTracker, VersionTrackingService>();
        services.AddScoped<IActivityLogger, ActivityLoggingService>();
        services.AddScoped<IFileSyncService, FileSyncService>();
        services.AddSingleton<ICredentialManager, WindowsCredentialManager>();
        services.AddSingleton<ITempFileService, TempFileService>();

        // Register ViewModels
        services.AddTransient<MainViewModel>();
        services.AddTransient<FtpFileExplorerViewModel>();

        // Register Views
        services.AddTransient<MainWindow>();
        services.AddTransient<FtpFileExplorerWindow>();
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
            WpfMessageBox.Show($"Failed to initialize database: {ex.Message}", 
                "Database Error", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown();
        }
    }
}

