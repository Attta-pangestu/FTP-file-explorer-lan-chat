using System;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using System.Windows.Input;
using System.Windows.Threading;
using WpfApplication = System.Windows.Application;
using WpfMessageBox = System.Windows.MessageBox;
using FtpVirtualDrive.Core.Interfaces;
using FtpVirtualDrive.Core.Models;
using Microsoft.Extensions.Logging;

namespace FtpVirtualDrive.UI.ViewModels;

/// <summary>
/// ViewModel for FTP File Explorer
/// </summary>
public class FtpFileExplorerViewModel : INotifyPropertyChanged
{
    private readonly IFtpClient _ftpClient;
    private readonly ITempFileService _tempFileService;
    private readonly ILogger<FtpFileExplorerViewModel> _logger;
    
    private string _currentPath = "/";
    private bool _isLoading;
    private string _statusMessage = "Ready";
    private FtpFileInfo? _selectedItem;
    
    public FtpFileExplorerViewModel(
        IFtpClient ftpClient, 
        ITempFileService tempFileService,
        ILogger<FtpFileExplorerViewModel> logger)
    {
        _ftpClient = ftpClient ?? throw new ArgumentNullException(nameof(ftpClient));
        _tempFileService = tempFileService ?? throw new ArgumentNullException(nameof(tempFileService));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        
        Files = new ObservableCollection<FtpFileInfo>();
        
        // Initialize commands
        RefreshCommand = new FtpVirtualDrive.UI.ViewModels.AsyncRelayCommand(RefreshAsync);
        NavigateUpCommand = new FtpVirtualDrive.UI.ViewModels.RelayCommand(NavigateUp, () => CurrentPath != "/");
        OpenFileCommand = new FtpVirtualDrive.UI.ViewModels.AsyncRelayCommand(async (param) => await OpenFileAsync((FtpFileInfo)param!), 
            (param) => param is FtpFileInfo file && !file.IsDirectory);
        NavigateToFolderCommand = new FtpVirtualDrive.UI.ViewModels.AsyncRelayCommand(async (param) => await NavigateToFolderAsync((FtpFileInfo)param!),
            (param) => param is FtpFileInfo folder && folder.IsDirectory);
        CleanupTempFilesCommand = new FtpVirtualDrive.UI.ViewModels.AsyncRelayCommand(CleanupTempFilesAsync);
        
        // Load initial directory
        _ = Task.Run(async () => await RefreshAsync());
    }
    
    public ObservableCollection<FtpFileInfo> Files { get; }
    
    public string CurrentPath
    {
        get => _currentPath;
        set
        {
            if (_currentPath != value)
            {
                _currentPath = value;
                OnPropertyChanged();
                OnPropertyChanged(nameof(CanNavigateUp));
            }
        }
    }
    
    public bool IsLoading
    {
        get => _isLoading;
        set
        {
            if (_isLoading != value)
            {
                _isLoading = value;
                OnPropertyChanged();
            }
        }
    }
    
    public string StatusMessage
    {
        get => _statusMessage;
        set
        {
            if (_statusMessage != value)
            {
                _statusMessage = value;
                OnPropertyChanged();
            }
        }
    }
    
    public FtpFileInfo? SelectedItem
    {
        get => _selectedItem;
        set
        {
            if (_selectedItem != value)
            {
                _selectedItem = value;
                OnPropertyChanged();
            }
        }
    }
    
    public bool CanNavigateUp => CurrentPath != "/";
    
    public string TempFolderPath => _tempFileService.TempFolderPath;
    
    // Commands
    public ICommand RefreshCommand { get; }
    public ICommand NavigateUpCommand { get; }
    public ICommand OpenFileCommand { get; }
    public ICommand NavigateToFolderCommand { get; }
    public ICommand CleanupTempFilesCommand { get; }
    
    private async Task RefreshAsync()
    {
        if (IsLoading) return;
        
        IsLoading = true;
        StatusMessage = "Loading directory...";
        
        try
        {
            _logger.LogInformation("Refreshing directory: {CurrentPath}", CurrentPath);
            
            var files = await _ftpClient.ListDirectoryAsync(CurrentPath);
            
            // Update UI on main thread
            await WpfApplication.Current.Dispatcher.InvokeAsync(() =>
            {
                Files.Clear();
                
                // Sort: directories first, then files, both alphabetically
                var sortedFiles = files
                    .OrderBy(f => !f.IsDirectory)
                    .ThenBy(f => f.Name, StringComparer.OrdinalIgnoreCase)
                    .ToList();
                
                foreach (var file in sortedFiles)
                {
                    Files.Add(file);
                }
            });
            
            var fileCount = files.Count();
            StatusMessage = $"Loaded {fileCount} items";
            _logger.LogInformation("Successfully loaded {FileCount} items from {CurrentPath}", fileCount, CurrentPath);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to refresh directory: {CurrentPath}", CurrentPath);
            StatusMessage = $"Error: {ex.Message}";
            
            await WpfApplication.Current.Dispatcher.InvokeAsync(() => Files.Clear());
        }
        finally
        {
            IsLoading = false;
        }
    }
    
    private void NavigateUp()
    {
        if (CurrentPath == "/") return;
        
        var parentPath = Path.GetDirectoryName(CurrentPath.Replace('\\', '/'))?.Replace('\\', '/') ?? "/";
        if (string.IsNullOrEmpty(parentPath) || parentPath == ".")
            parentPath = "/";
        
        CurrentPath = parentPath;
        _ = Task.Run(async () => await RefreshAsync());
    }
    
    private async Task NavigateToFolderAsync(FtpFileInfo? folder)
    {
        if (folder == null || !folder.IsDirectory) return;
        
        var newPath = Path.Combine(CurrentPath, folder.Name).Replace('\\', '/');
        if (!newPath.StartsWith("/"))
            newPath = "/" + newPath;
        
        CurrentPath = newPath;
        await RefreshAsync();
    }
    
    private async Task OpenFileAsync(FtpFileInfo? file)
    {
        if (file == null || file.IsDirectory) return;
        
        StatusMessage = "Downloading file...";
        
        try
        {
            // Build proper FTP path
            var filePath = CurrentPath.TrimEnd('/') + "/" + file.Name;
            if (!filePath.StartsWith("/"))
                filePath = "/" + filePath;
            
            _logger.LogInformation("Opening file: {FilePath}", filePath);
            
            // Check if file is already cached
            var cachedPath = _tempFileService.GetCachedTempFile(filePath);
            if (cachedPath != null)
            {
                _logger.LogInformation("Using cached file: {CachedPath}", cachedPath);
                var opened = await _tempFileService.OpenFileAsync(cachedPath);
                StatusMessage = opened ? "File opened successfully" : "Failed to open file";
                return;
            }
            
            // Download and open file
            var localPath = await _tempFileService.DownloadToTempAsync(filePath);
            var success = await _tempFileService.OpenFileAsync(localPath);
            
            StatusMessage = success ? "File opened successfully" : "Failed to open file";
            
            if (success)
            {
                _logger.LogInformation("Successfully opened file: {FilePath} -> {LocalPath}", filePath, localPath);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to open file: {FileName}", file.Name);
            StatusMessage = $"Error opening file: {ex.Message}";
            
            // Show error dialog to user
            WpfMessageBox.Show($"Failed to open file '{file.Name}':\n\n{ex.Message}", 
                "File Open Error", System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Error);
        }
    }
    
    private async Task CleanupTempFilesAsync()
    {
        StatusMessage = "Cleaning up temporary files...";
        
        try
        {
            var cleanedCount = await _tempFileService.CleanupTempFilesAsync(TimeSpan.FromHours(24));
            StatusMessage = $"Cleaned up {cleanedCount} temporary files";
            _logger.LogInformation("Cleaned up {CleanedCount} temporary files", cleanedCount);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to cleanup temporary files");
            StatusMessage = $"Error cleaning up: {ex.Message}";
        }
    }
    
    public event PropertyChangedEventHandler? PropertyChanged;
    
    protected virtual void OnPropertyChanged([CallerMemberName] string? propertyName = null)
    {
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
}