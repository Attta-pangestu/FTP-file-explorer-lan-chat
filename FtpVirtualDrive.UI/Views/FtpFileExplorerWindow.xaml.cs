using System;
using System.Windows;
using FtpVirtualDrive.UI.ViewModels;

namespace FtpVirtualDrive.UI.Views;

/// <summary>
/// Interaction logic for FtpFileExplorerWindow.xaml
/// </summary>
public partial class FtpFileExplorerWindow : Window
{
    public FtpFileExplorerWindow(FtpFileExplorerViewModel viewModel)
    {
        InitializeComponent();
        DataContext = viewModel ?? throw new ArgumentNullException(nameof(viewModel));
    }
    
}