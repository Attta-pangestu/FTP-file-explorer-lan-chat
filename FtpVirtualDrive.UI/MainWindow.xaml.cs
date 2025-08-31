using System.Windows;
using FtpVirtualDrive.UI.ViewModels;

namespace FtpVirtualDrive.UI;

/// <summary>
/// Interaction logic for MainWindow.xaml
/// </summary>
public partial class MainWindow : Window
{
    public MainWindow(MainViewModel viewModel)
    {
        InitializeComponent();
        DataContext = viewModel;
        
        // Handle password box binding manually (WPF limitation)
        PasswordBox.PasswordChanged += (s, e) =>
        {
            if (DataContext is MainViewModel vm)
            {
                vm.Password = PasswordBox.Password;
            }
        };
        
        // Update password box when view model changes
        if (DataContext is MainViewModel mainViewModel)
        {
            mainViewModel.PropertyChanged += (s, e) =>
            {
                if (e.PropertyName == nameof(MainViewModel.Password))
                {
                    if (PasswordBox.Password != mainViewModel.Password)
                    {
                        PasswordBox.Password = mainViewModel.Password;
                    }
                }
            };
        }
    }
}
