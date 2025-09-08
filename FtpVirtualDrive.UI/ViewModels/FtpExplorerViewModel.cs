using System.Collections.ObjectModel;
using System.IO;
using System.Windows;
using WpfApplication = System.Windows.Application;
using WpfMessageBox = System.Windows.MessageBox;
using System.Windows.Input;
using FtpVirtualDrive.Core.Interfaces;
using FtpVirtualDrive.Core.Models;
using FtpVirtualDrive.UI.Models;
using Microsoft.Extensions.Logging;

namespace FtpVirtualDrive.UI.ViewModels;

/// <summary>
/// View model for the FTP File Explorer
/// </summary>
public class FtpExplorerViewModel : BaseViewModel
{
    private readonly IFtpExplorerService _explorerService;
    private readonly ILogger<FtpExplorerViewModel> _logger;
    
    private DirectoryNode? _selectedTreeNode;
    private FtpDirectoryEntry? _selectedDirectoryItem;
    private string _currentPath = "/";
    private bool _isInitialized;
    private bool _isBusy;
    private double _progressValue;
    private string _statusMessage = "Not connected";

    public ObservableCollection<DirectoryNode> TreeItems { get; } = new();
    public ObservableCollection<FtpDirectoryEntry> DirectoryItems { get; } = new();
    public ObservableCollection<PathBreadcrumb> Breadcrumbs { get; } = new();

    public DirectoryNode? SelectedTreeNode
    {
        get => _selectedTreeNode;
        set
        {
            if (SetProperty(ref _selectedTreeNode, value) && value != null)
            {
                _ = Task.Run(async () => await NavigateToDirectoryAsync(value.FullPath));
            }
        }
    }

    public FtpDirectoryEntry? SelectedDirectoryItem
    {
        get => _selectedDirectoryItem;
        set => SetProperty(ref _selectedDirectoryItem, value);
    }

    public string CurrentPath
    {
        get => _currentPath;
        set => SetProperty(ref _currentPath, value);
    }

    public bool IsInitialized
    {
        get => _isInitialized;
        set => SetProperty(ref _isInitialized, value);
    }

    public bool IsBusy
    {
        get => _isBusy;
        set => SetProperty(ref _isBusy, value);
    }

    public double ProgressValue
    {
        get => _progressValue;
        set => SetProperty(ref _progressValue, value);
    }

    public string StatusMessage
    {
        get => _statusMessage;
        set => SetProperty(ref _statusMessage, value);
    }

    // Commands
    public ICommand RefreshCommand { get; }
    public ICommand NavigateUpCommand { get; }
    public ICommand OpenFileCommand { get; }
    public ICommand EditFileCommand { get; }
    public ICommand DownloadFileCommand { get; }
    public ICommand UploadFileCommand { get; }
    public ICommand DeleteCommand { get; }
    public ICommand RenameCommand { get; }
    public ICommand NewFolderCommand { get; }
    public ICommand NavigateToPathCommand { get; }
    public ICommand TreeNodeExpandedCommand { get; }

    public FtpExplorerViewModel(IFtpExplorerService explorerService, ILogger<FtpExplorerViewModel> logger)
    {
        _explorerService = explorerService ?? throw new ArgumentNullException(nameof(explorerService));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));

        // Initialize commands
        RefreshCommand = new AsyncRelayCommand(RefreshAsync, () => IsInitialized && !IsBusy);
        NavigateUpCommand = new AsyncRelayCommand(NavigateUpAsync, () => IsInitialized && !IsBusy && CurrentPath != "/");
        OpenFileCommand = new AsyncRelayCommand(param => OpenFileAsync((FtpDirectoryEntry)param!), param => CanExecuteFileCommand((FtpDirectoryEntry)param!));
        EditFileCommand = new AsyncRelayCommand(param => EditFileAsync((FtpDirectoryEntry)param!), param => CanEditFile((FtpDirectoryEntry)param!));
        DownloadFileCommand = new AsyncRelayCommand(param => DownloadFileAsync((FtpDirectoryEntry)param!), param => CanExecuteFileCommand((FtpDirectoryEntry)param!));
        UploadFileCommand = new AsyncRelayCommand(UploadFileAsync, () => IsInitialized && !IsBusy);
        DeleteCommand = new AsyncRelayCommand(param => DeleteItemAsync((FtpDirectoryEntry)param!), param => CanExecuteFileCommand((FtpDirectoryEntry)param!));
        RenameCommand = new AsyncRelayCommand(param => RenameItemAsync((FtpDirectoryEntry)param!), param => CanExecuteFileCommand((FtpDirectoryEntry)param!));
        NewFolderCommand = new AsyncRelayCommand(CreateNewFolderAsync, () => IsInitialized && !IsBusy);
        NavigateToPathCommand = new AsyncRelayCommand(param => NavigateToPathAsync((string)param!), param => IsInitialized && !IsBusy);
        TreeNodeExpandedCommand = new AsyncRelayCommand(param => OnTreeNodeExpandedAsync((DirectoryNode)param!), param => param != null);

        // Subscribe to explorer service events
        _explorerService.DirectoryChanged += OnDirectoryChanged;
        _explorerService.OperationCompleted += OnOperationCompleted;
    }

    public async Task<bool> InitializeAsync(IFtpClient ftpClient)
    {
        try
        {
            IsBusy = true;
            StatusMessage = "Initializing FTP Explorer...";
            
            var success = await _explorerService.InitializeAsync(ftpClient);
            
            if (success)
            {
                IsInitialized = true;
                StatusMessage = "FTP Explorer initialized";
                await LoadInitialTreeStructureAsync();
            }
            else
            {
                StatusMessage = "Failed to initialize FTP Explorer";
            }
            
            return success;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to initialize FTP Explorer");
            StatusMessage = $"Initialization error: {ex.Message}";
            return false;
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task LoadInitialTreeStructureAsync()
    {
        try
        {
            WpfApplication.Current.Dispatcher.Invoke(() =>
            {
                TreeItems.Clear();
                
                // Add root node
                var rootNode = new DirectoryNode
                {
                    Name = "Root",
                    FullPath = "/",
                    HasDirectories = true,
                    HasBeenLoaded = false
                };
                
                rootNode.AddPlaceholder();
                TreeItems.Add(rootNode);
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load initial tree structure");
        }
    }

    private async Task RefreshAsync()
    {
        try
        {
            IsBusy = true;
            StatusMessage = "Refreshing...";
            
            await _explorerService.NavigateToPathAsync(CurrentPath);
            await RefreshCurrentTreeNodeAsync();
            
            StatusMessage = "Refreshed";
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to refresh directory");
            StatusMessage = $"Refresh failed: {ex.Message}";
            WpfMessageBox.Show($"Failed to refresh: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task NavigateUpAsync()
    {
        try
        {
            IsBusy = true;
            await _explorerService.NavigateUpAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to navigate up");
            WpfMessageBox.Show($"Failed to navigate up: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task NavigateToDirectoryAsync(string path)
    {
        if (string.IsNullOrEmpty(path) || path == CurrentPath) return;

        try
        {
            IsBusy = true;
            StatusMessage = $"Navigating to {path}...";
            
            await _explorerService.NavigateToPathAsync(path);
            
            StatusMessage = $"Navigated to {path}";
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to navigate to directory {Path}", path);
            StatusMessage = $"Navigation failed: {ex.Message}";
            WpfMessageBox.Show($"Failed to navigate to {path}: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task NavigateToPathAsync(string? path)
    {
        if (!string.IsNullOrEmpty(path))
        {
            await NavigateToDirectoryAsync(path);
        }
    }

    private async Task OpenFileAsync(FtpDirectoryEntry? item)
    {
        if (item == null) return;

        if (item.IsDirectory)
        {
            await NavigateToDirectoryAsync(item.FullPath);
        }
        else if (item.IsTextFile)
        {
            await EditFileAsync(item);
        }
        else if (item.IsImageFile)
        {
            await PreviewImageAsync(item);
        }
        else
        {
            // For other file types, show download dialog
            await DownloadFileAsync(item);
        }
    }

    private async Task EditFileAsync(FtpDirectoryEntry? item)
    {
        if (item == null || item.IsDirectory || !item.IsTextFile) return;

        try
        {
            IsBusy = true;
            StatusMessage = $"Opening {item.Name} for editing...";

            var content = await _explorerService.DownloadFileAsTextAsync(item.FullPath);
            
            // For now, show content in a simple message box - will be replaced with text editor window
            WpfMessageBox.Show($"File Content:\n\n{content.Substring(0, Math.Min(1000, content.Length))}...", 
                $"Editing {item.Name}", MessageBoxButton.OK, MessageBoxImage.Information);

            StatusMessage = "File editor closed";
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to open file for editing {FilePath}", item.FullPath);
            StatusMessage = $"Failed to open file: {ex.Message}";
            WpfMessageBox.Show($"Failed to open file for editing: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task PreviewImageAsync(FtpDirectoryEntry item)
    {
        try
        {
            IsBusy = true;
            StatusMessage = $"Loading image preview for {item.Name}...";

            using var stream = await _explorerService.DownloadFileAsStreamAsync(item.FullPath);
            
            // For now, show simple message - will be replaced with image preview window
            WpfMessageBox.Show($"Image preview for {item.Name} ({item.FormattedSize})", 
                "Image Preview", MessageBoxButton.OK, MessageBoxImage.Information);

            StatusMessage = "Image preview closed";
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to preview image {FilePath}", item.FullPath);
            StatusMessage = $"Failed to preview image: {ex.Message}";
            WpfMessageBox.Show($"Failed to preview image: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task DownloadFileAsync(FtpDirectoryEntry? item)
    {
        if (item == null || item.IsDirectory) return;

        try
        {
            var saveFileDialog = new Microsoft.Win32.SaveFileDialog
            {
                FileName = item.Name,
                Filter = "All Files (*.*)|*.*"
            };

            if (saveFileDialog.ShowDialog() != true) return;

            IsBusy = true;
            StatusMessage = $"Downloading {item.Name}...";
            ProgressValue = 0;

            var progress = new Progress<double>(value =>
            {
                WpfApplication.Current.Dispatcher.Invoke(() =>
                {
                    ProgressValue = value;
                });
            });

            using var stream = await _explorerService.DownloadFileAsStreamAsync(item.FullPath, progress);
            using var fileStream = File.Create(saveFileDialog.FileName);
            await stream.CopyToAsync(fileStream);

            StatusMessage = $"Downloaded {item.Name}";
            WpfMessageBox.Show($"File downloaded successfully to {saveFileDialog.FileName}", "Download Complete", 
                MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to download file {FilePath}", item.FullPath);
            StatusMessage = $"Download failed: {ex.Message}";
            WpfMessageBox.Show($"Failed to download file: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            IsBusy = false;
            ProgressValue = 0;
        }
    }

    private async Task UploadFileAsync()
    {
        try
        {
            var openFileDialog = new Microsoft.Win32.OpenFileDialog
            {
                Filter = "All Files (*.*)|*.*",
                Multiselect = false
            };

            if (openFileDialog.ShowDialog() != true) return;

            var fileName = System.IO.Path.GetFileName(openFileDialog.FileName);
            var remotePath = CombinePaths(CurrentPath, fileName);

            IsBusy = true;
            StatusMessage = $"Uploading {fileName}...";
            ProgressValue = 0;

            var progress = new Progress<double>(value =>
            {
                WpfApplication.Current.Dispatcher.Invoke(() =>
                {
                    ProgressValue = value;
                });
            });

            var success = await _explorerService.UploadFileAsync(remotePath, openFileDialog.FileName, progress);

            if (success)
            {
                StatusMessage = $"Uploaded {fileName}";
                WpfMessageBox.Show($"File uploaded successfully", "Upload Complete", 
                    MessageBoxButton.OK, MessageBoxImage.Information);
            }
            else
            {
                StatusMessage = "Upload failed";
                WpfMessageBox.Show("Failed to upload file", "Upload Failed", 
                    MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to upload file");
            StatusMessage = $"Upload failed: {ex.Message}";
            WpfMessageBox.Show($"Failed to upload file: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            IsBusy = false;
            ProgressValue = 0;
        }
    }

    private async Task DeleteItemAsync(FtpDirectoryEntry? item)
    {
        if (item == null) return;

        var itemType = item.IsDirectory ? "folder" : "file";
        var result = WpfMessageBox.Show($"Are you sure you want to delete the {itemType} '{item.Name}'?", 
            "Confirm Delete", MessageBoxButton.YesNo, MessageBoxImage.Question);

        if (result != MessageBoxResult.Yes) return;

        try
        {
            IsBusy = true;
            StatusMessage = $"Deleting {item.Name}...";

            var success = await _explorerService.DeleteAsync(item.FullPath, item.IsDirectory);

            if (success)
            {
                StatusMessage = $"Deleted {item.Name}";
            }
            else
            {
                StatusMessage = $"Failed to delete {item.Name}";
                WpfMessageBox.Show($"Failed to delete {itemType}", "Delete Failed", 
                    MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to delete {ItemType} {FilePath}", itemType, item.FullPath);
            StatusMessage = $"Delete failed: {ex.Message}";
            WpfMessageBox.Show($"Failed to delete {itemType}: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task RenameItemAsync(FtpDirectoryEntry? item)
    {
        if (item == null) return;

        var inputDialog = new FtpVirtualDrive.UI.Views.InputDialog("Rename", "Enter new name:", item.Name);
        if (inputDialog.ShowDialog() != true || string.IsNullOrWhiteSpace(inputDialog.InputText)) return;

        var newName = inputDialog.InputText.Trim();
        if (newName == item.Name) return;

        try
        {
            IsBusy = true;
            StatusMessage = $"Renaming {item.Name}...";

            var success = await _explorerService.RenameAsync(item.FullPath, newName);

            if (success)
            {
                StatusMessage = $"Renamed to {newName}";
            }
            else
            {
                StatusMessage = $"Failed to rename {item.Name}";
                WpfMessageBox.Show("Failed to rename item", "Rename Failed", 
                    MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to rename {FilePath} to {NewName}", item.FullPath, newName);
            StatusMessage = $"Rename failed: {ex.Message}";
            WpfMessageBox.Show($"Failed to rename item: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task CreateNewFolderAsync()
    {
        var inputDialog = new FtpVirtualDrive.UI.Views.InputDialog("New Folder", "Enter folder name:", "New Folder");
        if (inputDialog.ShowDialog() != true || string.IsNullOrWhiteSpace(inputDialog.InputText)) return;

        var folderName = inputDialog.InputText.Trim();

        try
        {
            IsBusy = true;
            StatusMessage = $"Creating folder {folderName}...";

            var success = await _explorerService.CreateDirectoryAsync(CurrentPath, folderName);

            if (success)
            {
                StatusMessage = $"Created folder {folderName}";
            }
            else
            {
                StatusMessage = $"Failed to create folder {folderName}";
                WpfMessageBox.Show("Failed to create folder", "Create Failed", 
                    MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to create folder {FolderName} in {Path}", folderName, CurrentPath);
            StatusMessage = $"Create failed: {ex.Message}";
            WpfMessageBox.Show($"Failed to create folder: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task OnTreeNodeExpandedAsync(DirectoryNode? node)
    {
        if (node == null || node.HasBeenLoaded) return;

        try
        {
            node.IsLoading = true;
            node.ClearPlaceholder();

            var entries = await _explorerService.ListDirectoryAsync(node.FullPath, false);
            var directories = entries.Where(e => e.IsDirectory).ToList();

            WpfApplication.Current.Dispatcher.Invoke(() =>
            {
                foreach (var dir in directories)
                {
                    var childNode = new DirectoryNode
                    {
                        Name = dir.Name,
                        FullPath = dir.FullPath,
                        Parent = node,
                        HasDirectories = true, // We'll check this when expanded
                        HasBeenLoaded = false
                    };
                    
                    childNode.AddPlaceholder();
                    node.Children.Add(childNode);
                }
                
                node.HasBeenLoaded = true;
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to expand tree node {Path}", node.FullPath);
            WpfMessageBox.Show($"Failed to load directory contents: {ex.Message}", "Error", 
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            node.IsLoading = false;
        }
    }

    private async Task RefreshCurrentTreeNodeAsync()
    {
        // Find current tree node and refresh it
        var currentNode = FindTreeNode(TreeItems, CurrentPath);
        if (currentNode != null)
        {
            currentNode.HasBeenLoaded = false;
            currentNode.Children.Clear();
            currentNode.AddPlaceholder();
            
            if (currentNode.IsExpanded)
            {
                await OnTreeNodeExpandedAsync(currentNode);
            }
        }
    }

    private DirectoryNode? FindTreeNode(IEnumerable<DirectoryNode> nodes, string path)
    {
        foreach (var node in nodes)
        {
            if (node.FullPath == path)
                return node;
                
            var found = FindTreeNode(node.Children, path);
            if (found != null)
                return found;
        }
        return null;
    }

    private void OnDirectoryChanged(object? sender, DirectoryChangedEventArgs e)
    {
        WpfApplication.Current.Dispatcher.Invoke(() =>
        {
            CurrentPath = e.NewDirectory;
            
            DirectoryItems.Clear();
            foreach (var entry in e.Entries)
            {
                DirectoryItems.Add(entry);
            }
            
            Breadcrumbs.Clear();
            var breadcrumbs = _explorerService.GetBreadcrumbs(e.NewDirectory);
            foreach (var breadcrumb in breadcrumbs)
            {
                Breadcrumbs.Add(breadcrumb);
            }
            
            CommandManager.InvalidateRequerySuggested();
        });
    }

    private void OnOperationCompleted(object? sender, FtpExplorerOperationEventArgs e)
    {
        WpfApplication.Current.Dispatcher.Invoke(() =>
        {
            if (!e.Success)
            {
                StatusMessage = $"Operation failed: {e.ErrorMessage}";
            }
        });
    }

    private bool CanExecuteFileCommand(FtpDirectoryEntry? item)
    {
        return IsInitialized && !IsBusy && item != null;
    }

    private bool CanEditFile(FtpDirectoryEntry? item)
    {
        return CanExecuteFileCommand(item) && !item!.IsDirectory && item.IsTextFile;
    }

    private static string CombinePaths(string basePath, string relativePath)
    {
        if (string.IsNullOrEmpty(basePath))
            basePath = "/";
        if (string.IsNullOrEmpty(relativePath))
            return basePath;
            
        basePath = basePath.TrimEnd('/');
        relativePath = relativePath.TrimStart('/');
        
        return basePath + "/" + relativePath;
    }
}
