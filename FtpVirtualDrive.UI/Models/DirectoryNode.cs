using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace FtpVirtualDrive.UI.Models;

/// <summary>
/// Represents a directory node in the FTP explorer tree view
/// </summary>
public class DirectoryNode : INotifyPropertyChanged
{
    private bool _isExpanded;
    private bool _isSelected;
    private bool _isLoading;

    /// <summary>
    /// Display name of the directory
    /// </summary>
    public string Name { get; set; } = string.Empty;
    
    /// <summary>
    /// Full path of the directory
    /// </summary>
    public string FullPath { get; set; } = string.Empty;
    
    /// <summary>
    /// Whether this node is expanded in the tree
    /// </summary>
    public bool IsExpanded
    {
        get => _isExpanded;
        set => SetProperty(ref _isExpanded, value);
    }
    
    /// <summary>
    /// Whether this node is selected in the tree
    /// </summary>
    public bool IsSelected
    {
        get => _isSelected;
        set => SetProperty(ref _isSelected, value);
    }
    
    /// <summary>
    /// Whether this node is currently loading children
    /// </summary>
    public bool IsLoading
    {
        get => _isLoading;
        set => SetProperty(ref _isLoading, value);
    }
    
    /// <summary>
    /// Parent node (null for root)
    /// </summary>
    public DirectoryNode? Parent { get; set; }
    
    /// <summary>
    /// Child directory nodes
    /// </summary>
    public ObservableCollection<DirectoryNode> Children { get; } = new();
    
    /// <summary>
    /// Whether this node has been loaded (to distinguish from empty directories)
    /// </summary>
    public bool HasBeenLoaded { get; set; }
    
    /// <summary>
    /// Whether this directory has subdirectories
    /// </summary>
    public bool HasDirectories { get; set; }

    public event PropertyChangedEventHandler? PropertyChanged;

    protected virtual void OnPropertyChanged([CallerMemberName] string? propertyName = null)
    {
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }

    protected bool SetProperty<T>(ref T field, T value, [CallerMemberName] string? propertyName = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value))
            return false;

        field = value;
        OnPropertyChanged(propertyName);
        return true;
    }
    
    /// <summary>
    /// Adds a placeholder child node to show expansion arrow
    /// </summary>
    public void AddPlaceholder()
    {
        if (Children.Count == 0 && HasDirectories && !HasBeenLoaded)
        {
            Children.Add(new DirectoryNode 
            { 
                Name = "Loading...", 
                FullPath = "", 
                Parent = this 
            });
        }
    }
    
    /// <summary>
    /// Removes placeholder and loads actual children
    /// </summary>
    public void ClearPlaceholder()
    {
        var placeholder = Children.FirstOrDefault(c => c.Name == "Loading...");
        if (placeholder != null)
        {
            Children.Remove(placeholder);
        }
    }
}
