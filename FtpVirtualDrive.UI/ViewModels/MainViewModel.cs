using System.Collections.ObjectModel;
using System.IO;
using System.Runtime.CompilerServices;
using System.Windows;
using System.Windows.Input;
using WpfApplication = System.Windows.Application;
using WpfMessageBox = System.Windows.MessageBox;
using FtpVirtualDrive.Core.Interfaces;
using FtpVirtualDrive.Core.Models;
using FtpVirtualDrive.UI.Views;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Toolkit.Mvvm.Input;

namespace FtpVirtualDrive.UI.ViewModels;

/// <summary>
/// Main view model for the application
/// </summary>
public class MainViewModel : BaseViewModel
{
    private readonly IFtpClient _ftpClient;
    private readonly IVirtualDrive _virtualDrive;
    private readonly IActivityLogger _activityLogger;
    private readonly ICredentialManager _credentialManager;
    private readonly ITempFileService _tempFileService;
    private readonly ILogger<MainViewModel> _logger;

    private string _host = "223.25.98.220"; // Default test FTP server
    private int _port = 21;
    private string _username = "User_GM"; // Default test username
    private string _password = "PTRJ_GM"; // Default test password
    private bool _useSSL = false; // Disable SSL for testing
    private bool _isConnected;
    private bool _isMounted;
    private string _statusMessage = "Ready";
    private string _selectedDriveLetter = "Z";
    private bool _isConnecting;
    private string _connectionName = string.Empty;
    private string _tempFolderPath = Path.Combine(Path.GetTempPath(), "FtpVirtualDrive");

    public MainViewModel(
        IFtpClient ftpClient,
        IVirtualDrive virtualDrive,
        IActivityLogger activityLogger,
        ICredentialManager credentialManager,
        ITempFileService tempFileService,
        ILogger<MainViewModel> logger)
    {
        _ftpClient = ftpClient ?? throw new ArgumentNullException(nameof(ftpClient));
        _virtualDrive = virtualDrive ?? throw new ArgumentNullException(nameof(virtualDrive));
        _activityLogger = activityLogger ?? throw new ArgumentNullException(nameof(activityLogger));
        _credentialManager = credentialManager ?? throw new ArgumentNullException(nameof(credentialManager));
        _tempFileService = tempFileService ?? throw new ArgumentNullException(nameof(tempFileService));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));

        ActivityLogs = new ObservableCollection<ActivityLog>();
        AvailableDriveLetters = new ObservableCollection<string>();
        SavedConnections = new ObservableCollection<string>();

        // Initialize temp file service with the default path
        _tempFileService.TempFolderPath = _tempFolderPath;

        // Initialize commands
        ConnectCommand = new AsyncRelayCommand(ConnectAsync, () => !IsConnecting && !IsConnected);
        DisconnectCommand = new AsyncRelayCommand(DisconnectAsync, () => IsConnected || IsMounted);
        MountCommand = new AsyncRelayCommand(MountAsync, () => IsConnected && !IsMounted);
        UnmountCommand = new AsyncRelayCommand(UnmountAsync, () => IsMounted);
        SaveCredentialsCommand = new AsyncRelayCommand(SaveCredentialsAsync);
        LoadCredentialsCommand = new AsyncRelayCommand(param => LoadCredentialsAsync((string)param!));
        ExportLogsCommand = new AsyncRelayCommand(ExportLogsAsync);
        RefreshLogsCommand = new AsyncRelayCommand(RefreshLogsAsync);
        OpenFtpExplorerCommand = new RelayCommand(OpenFtpExplorer, () => IsConnected);
        ChooseTempFolderCommand = new RelayCommand(ChooseTempFolder);

        // Subscribe to events
        _ftpClient.OperationCompleted += OnFtpOperationCompleted;
        _virtualDrive.MountStatusChanged += OnMountStatusChanged;
        _virtualDrive.FileOperation += OnFileOperation;

        // Initialize data
        _ = Task.Run(async () =>
        {
            await LoadAvailableDriveLettersAsync();
            await LoadSavedConnectionsAsync();
            await RefreshLogsAsync();
        });
    }

    #region Properties

    public string Host
    {
        get => _host;
        set => SetProperty(ref _host, value);
    }

    public int Port
    {
        get => _port;
        set => SetProperty(ref _port, value);
    }

    public string Username
    {
        get => _username;
        set => SetProperty(ref _username, value);
    }

    public string Password
    {
        get => _password;
        set => SetProperty(ref _password, value);
    }

    public bool UseSSL
    {
        get => _useSSL;
        set
        {
            if (SetProperty(ref _useSSL, value))
            {
                Port = value ? 990 : 21; // Auto-adjust port
            }
        }
    }

    public bool IsConnected
    {
        get => _isConnected;
        set => SetProperty(ref _isConnected, value);
    }

    public bool IsMounted
    {
        get => _isMounted;
        set => SetProperty(ref _isMounted, value);
    }

    public string StatusMessage
    {
        get => _statusMessage;
        set => SetProperty(ref _statusMessage, value);
    }

    public string SelectedDriveLetter
    {
        get => _selectedDriveLetter;
        set => SetProperty(ref _selectedDriveLetter, value);
    }

    public bool IsConnecting
    {
        get => _isConnecting;
        set => SetProperty(ref _isConnecting, value);
    }

    public string ConnectionName
    {
        get => _connectionName;
        set => SetProperty(ref _connectionName, value);
    }

    public string TempFolderPath
    {
        get => _tempFolderPath;
        set
        {
            if (SetProperty(ref _tempFolderPath, value))
            {
                // Update the temp file service with the new path
                try
                {
                    _tempFileService.TempFolderPath = value;
                    StatusMessage = "Temp folder path updated";
                    _logger.LogInformation("Temp folder path updated to: {Path}", value);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to update temp folder path");
                    StatusMessage = "Failed to update temp folder path";
                }
            }
        }
    }

    public ObservableCollection<ActivityLog> ActivityLogs { get; }
    public ObservableCollection<string> AvailableDriveLetters { get; }
    public ObservableCollection<string> SavedConnections { get; }

    #endregion

    #region Commands

    public ICommand ConnectCommand { get; }
    public ICommand DisconnectCommand { get; }
    public ICommand MountCommand { get; }
    public ICommand UnmountCommand { get; }
    public ICommand SaveCredentialsCommand { get; }
    public ICommand LoadCredentialsCommand { get; }
    public ICommand ExportLogsCommand { get; }
    public ICommand RefreshLogsCommand { get; }
    public ICommand OpenFtpExplorerCommand { get; }
    public ICommand ChooseTempFolderCommand { get; }

    #endregion

    #region Command Implementations

    private async Task ConnectAsync()
    {
        try
        {
            IsConnecting = true;
            StatusMessage = "Connecting to FTP server...";

            var connectionInfo = new FtpConnectionInfo
            {
                Host = Host,
                Port = Port,
                Username = Username,
                Password = Password,
                UseSSL = UseSSL,
                ConnectionName = ConnectionName
            };

            var success = await _ftpClient.ConnectAsync(connectionInfo);
            
            if (success)
            {
                IsConnected = true;
                StatusMessage = $"Connected to {Host}:{Port}";
                _logger.LogInformation("Successfully connected to FTP server");
            }
            else
            {
                StatusMessage = "Failed to connect to FTP server";
                _logger.LogWarning("Failed to connect to FTP server");
                WpfMessageBox.Show("Failed to connect to FTP server. Please check your credentials and try again.", 
                    "Connection Failed", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }
        catch (Exception ex)
        {
            StatusMessage = "Connection error";
            _logger.LogError(ex, "Error during FTP connection");
            WpfMessageBox.Show($"Connection error: {ex.Message}", 
                "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            IsConnecting = false;
        }
    }

    private async Task DisconnectAsync()
    {
        try
        {
            StatusMessage = "Disconnecting...";

            if (IsMounted)
            {
                await _virtualDrive.UnmountAsync();
            }

            await _ftpClient.DisconnectAsync();
            
            IsConnected = false;
            IsMounted = false;
            StatusMessage = "Disconnected";
            _logger.LogInformation("Disconnected from FTP server");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during disconnect");
            WpfMessageBox.Show($"Disconnect error: {ex.Message}", 
                "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private async Task MountAsync()
    {
        try
        {
            StatusMessage = "Mounting virtual drive...";

            var success = await _virtualDrive.MountAsync(SelectedDriveLetter, _ftpClient);
            
            if (success)
            {
                IsMounted = true;
                StatusMessage = $"Mounted as {SelectedDriveLetter}: drive";
                _logger.LogInformation("Successfully mounted virtual drive");
                
                WpfMessageBox.Show($"FTP server mounted as {SelectedDriveLetter}: drive\nYou can now access files through Windows Explorer.", 
                    "Mount Successful", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            else
            {
                StatusMessage = "Failed to mount drive";
                _logger.LogWarning("Failed to mount virtual drive");
                
                // Get the detailed error message from the virtual drive service
                var errorDetails = "Failed to mount virtual drive.";
                
                // Check if it's a Dokan driver issue
                if (!IsDokanDriverInstalled())
                {
                    errorDetails = "Dokan driver is not installed.\n\n" +
                                 "To enable virtual drive mounting, please:\n" +
                                 "1. Download Dokan Library from: https://github.com/dokan-dev/dokany/releases\n" +
                                 "2. Install the latest stable release\n" +
                                 "3. Restart this application\n\n" +
                                 "Note: You may need administrator privileges to install the driver.";
                }
                else
                {
                    errorDetails = "Virtual drive mounting feature is currently under development.\n\n" +
                                 "The Dokan driver is installed, but the integration is not yet complete.\n" +
                                 "This feature will be available in a future update.";
                }
                
                WpfMessageBox.Show(errorDetails, "Mount Failed", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }
        catch (Exception ex)
        {
            StatusMessage = "Mount error";
            _logger.LogError(ex, "Error during mount operation");
            WpfMessageBox.Show($"Mount error: {ex.Message}", 
                "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private bool IsDokanDriverInstalled()
    {
        try
        {
            // Check for Dokan installation directory
            var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            var dokanPath = System.IO.Path.Combine(programFiles, "Dokan");
            
            if (Directory.Exists(dokanPath))
            {
                var dokanDirs = Directory.GetDirectories(dokanPath, "Dokan Library-*");
                if (dokanDirs.Length > 0)
                {
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
            
            return process.ExitCode == 0 && output.Contains("SERVICE_NAME: dokan1");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Error checking Dokan driver installation");
            return false;
        }
    }

    private async Task UnmountAsync()
    {
        try
        {
            StatusMessage = "Unmounting virtual drive...";

            var success = await _virtualDrive.UnmountAsync();
            
            if (success)
            {
                IsMounted = false;
                StatusMessage = "Drive unmounted";
                _logger.LogInformation("Successfully unmounted virtual drive");
            }
            else
            {
                StatusMessage = "Failed to unmount drive";
                _logger.LogWarning("Failed to unmount virtual drive");
            }
        }
        catch (Exception ex)
        {
            StatusMessage = "Unmount error";
            _logger.LogError(ex, "Error during unmount operation");
            WpfMessageBox.Show($"Unmount error: {ex.Message}", 
                "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private async Task SaveCredentialsAsync()
    {
        try
        {
            if (string.IsNullOrWhiteSpace(ConnectionName))
            {
                WpfMessageBox.Show("Please enter a connection name to save credentials.", 
                    "Missing Information", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }

            var connectionInfo = new FtpConnectionInfo
            {
                Host = Host,
                Port = Port,
                Username = Username,
                Password = Password,
                UseSSL = UseSSL,
                ConnectionName = ConnectionName
            };

            var success = await _credentialManager.StoreCredentialsAsync(connectionInfo, ConnectionName);
            
            if (success)
            {
                StatusMessage = "Credentials saved";
                await LoadSavedConnectionsAsync();
                WpfMessageBox.Show("Credentials saved successfully.", 
                    "Success", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            else
            {
                WpfMessageBox.Show("Failed to save credentials.", 
                    "Error", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error saving credentials");
            WpfMessageBox.Show($"Error saving credentials: {ex.Message}", 
                "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private async Task LoadCredentialsAsync(string? connectionName)
    {
        try
        {
            if (string.IsNullOrEmpty(connectionName))
                return;

            var connectionInfo = await _credentialManager.RetrieveCredentialsAsync(connectionName);
            
            if (connectionInfo != null)
            {
                Host = connectionInfo.Host;
                Port = connectionInfo.Port;
                Username = connectionInfo.Username;
                Password = connectionInfo.Password;
                UseSSL = connectionInfo.UseSSL;
                ConnectionName = connectionInfo.ConnectionName;

                StatusMessage = "Credentials loaded";
            }
            else
            {
                WpfMessageBox.Show("Failed to load saved credentials.", 
                    "Error", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error loading credentials");
            WpfMessageBox.Show($"Error loading credentials: {ex.Message}", 
                "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private async Task ExportLogsAsync()
    {
        try
        {
            var saveFileDialog = new Microsoft.Win32.SaveFileDialog
            {
                Filter = "CSV Files (*.csv)|*.csv|JSON Files (*.json)|*.json|XML Files (*.xml)|*.xml|Text Files (*.txt)|*.txt",
                DefaultExt = "csv",
                FileName = $"FtpVirtualDrive_Logs_{DateTime.Now:yyyyMMdd_HHmmss}"
            };

            if (saveFileDialog.ShowDialog() == true)
            {
                var format = saveFileDialog.FilterIndex switch
                {
                    1 => LogExportFormat.Csv,
                    2 => LogExportFormat.Json,
                    3 => LogExportFormat.Xml,
                    4 => LogExportFormat.Text,
                    _ => LogExportFormat.Csv
                };

                var success = await _activityLogger.ExportLogsAsync(saveFileDialog.FileName, format);
                
                if (success)
                {
                    StatusMessage = "Logs exported successfully";
                    WpfMessageBox.Show("Activity logs exported successfully.", 
                        "Export Complete", MessageBoxButton.OK, MessageBoxImage.Information);
                }
                else
                {
                    WpfMessageBox.Show("Failed to export activity logs.", 
                        "Export Failed", MessageBoxButton.OK, MessageBoxImage.Error);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error exporting logs");
            WpfMessageBox.Show($"Error exporting logs: {ex.Message}", 
                "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private async Task RefreshLogsAsync()
    {
        try
        {
            var recentLogs = await _activityLogger.GetRecentActivityLogsAsync(100);
            
            WpfApplication.Current.Dispatcher.Invoke(() =>
            {
                ActivityLogs.Clear();
                foreach (var log in recentLogs)
                {
                    ActivityLogs.Add(log);
                }
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error refreshing activity logs");
        }
    }

    #endregion

    #region Event Handlers

    private void OnFtpOperationCompleted(object? sender, FtpOperationEventArgs e)
    {
        WpfApplication.Current.Dispatcher.Invoke(async () =>
        {
            await RefreshLogsAsync();
            
            if (!e.Success && !string.IsNullOrEmpty(e.ErrorMessage))
            {
                StatusMessage = $"Operation failed: {e.ErrorMessage}";
            }
        });
    }

    private void OnMountStatusChanged(object? sender, MountStatusEventArgs e)
    {
        WpfApplication.Current.Dispatcher.Invoke(() =>
        {
            IsMounted = e.IsMounted;
            
            if (e.IsMounted)
            {
                StatusMessage = $"Mounted as {e.DriveLetter} drive";
            }
            else if (!string.IsNullOrEmpty(e.ErrorMessage))
            {
                StatusMessage = $"Mount error: {e.ErrorMessage}";
            }
            else
            {
                StatusMessage = "Drive unmounted";
            }
        });
    }

    private void OnFileOperation(object? sender, VirtualFileSystemEventArgs e)
    {
        WpfApplication.Current.Dispatcher.Invoke(async () =>
        {
            await RefreshLogsAsync();
            StatusMessage = $"{e.Operation}: {Path.GetFileName(e.FilePath)}";
        });
    }

    #endregion

    #region Helper Methods

    private async Task LoadAvailableDriveLettersAsync()
    {
        try
        {
            var driveLetters = await _virtualDrive.GetAvailableDriveLettersAsync();
            
            WpfApplication.Current.Dispatcher.Invoke(() =>
            {
                AvailableDriveLetters.Clear();
                foreach (var letter in driveLetters)
                {
                    AvailableDriveLetters.Add(letter);
                }

                if (AvailableDriveLetters.Count > 0 && !AvailableDriveLetters.Contains(SelectedDriveLetter))
                {
                    SelectedDriveLetter = AvailableDriveLetters.First();
                }
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error loading available drive letters");
        }
    }

    private async Task LoadSavedConnectionsAsync()
    {
        try
        {
            var connections = await _credentialManager.ListCredentialsAsync();
            
            WpfApplication.Current.Dispatcher.Invoke(() =>
            {
                SavedConnections.Clear();
                foreach (var connection in connections)
                {
                    SavedConnections.Add(connection);
                }
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error loading saved connections");
        }
    }

    private void OpenFtpExplorer()
    {
        try
        {
            _logger.LogInformation("Opening FTP File Explorer...");
            
            var serviceProvider = ((App)WpfApplication.Current).ServiceProvider;
            if (serviceProvider == null)
            {
                _logger.LogError("Service provider is not available");
                StatusMessage = "Failed to open FTP File Explorer - Service provider unavailable";
                WpfMessageBox.Show("Service provider is not available. Application may not be properly initialized.", 
                    "Error", MessageBoxButton.OK, MessageBoxImage.Error);
                return;
            }
            
            _logger.LogInformation("Service provider is available, resolving FtpFileExplorerWindow...");
            
            // Check if FTP client is connected
            if (!IsConnected)
            {
                _logger.LogWarning("FTP client is not connected");
                WpfMessageBox.Show("Please connect to an FTP server first before opening the File Explorer.", 
                    "Not Connected", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }

            var ftpExplorerWindow = serviceProvider.GetRequiredService<FtpFileExplorerWindow>();
            
            _logger.LogInformation("FtpFileExplorerWindow resolved successfully, showing window...");
            
            ftpExplorerWindow.Show();
            ftpExplorerWindow.Activate();
            
            StatusMessage = "FTP File Explorer opened";
            _logger.LogInformation("FTP File Explorer opened successfully");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error opening FTP File Explorer: {Message}", ex.Message);
            StatusMessage = "Error opening FTP File Explorer";
            
            var detailedMessage = $"Failed to open FTP File Explorer:\n\n" +
                                $"Error: {ex.Message}\n\n" +
                                $"Type: {ex.GetType().Name}";
            
            if (ex.InnerException != null)
            {
                detailedMessage += $"\n\nInner Exception: {ex.InnerException.Message}";
            }
            
            WpfMessageBox.Show(detailedMessage, "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void ChooseTempFolder()
    {
        try
        {
            using var folderDialog = new global::System.Windows.Forms.FolderBrowserDialog
            {
                Description = "Select a folder to store temporary FTP files",
                SelectedPath = TempFolderPath,
                ShowNewFolderButton = true
            };
            
            var result = folderDialog.ShowDialog();
            if (result == System.Windows.Forms.DialogResult.OK && !string.IsNullOrEmpty(folderDialog.SelectedPath))
            {
                var selectedPath = folderDialog.SelectedPath;
                
                // Test if we can create a directory and write to it
                try
                {
                    Directory.CreateDirectory(selectedPath);
                    var testFile = Path.Combine(selectedPath, "test_write_access.tmp");
                    File.WriteAllText(testFile, "test");
                    File.Delete(testFile);
                    
                    // If we get here, the path is valid and writable
                    TempFolderPath = selectedPath;
                    StatusMessage = $"Temp folder updated: {selectedPath}";
                    _logger.LogInformation("User selected temp folder: {Path}", selectedPath);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Selected temp folder is not writable: {Path}", selectedPath);
                    WpfMessageBox.Show($"The selected folder is not writable:\n{selectedPath}\n\nError: {ex.Message}\n\nPlease choose a different folder.",
                        "Folder Not Writable", MessageBoxButton.OK, MessageBoxImage.Warning);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error choosing temp folder");
            WpfMessageBox.Show($"Error selecting folder: {ex.Message}", 
                "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    #endregion

    protected override void OnPropertyChanged([CallerMemberName] string? propertyName = null)
    {
        base.OnPropertyChanged(propertyName);
        
        // Update command states when relevant properties change
        if (propertyName is nameof(IsConnected) or nameof(IsMounted) or nameof(IsConnecting))
        {
            CommandManager.InvalidateRequerySuggested();
        }
    }
}
