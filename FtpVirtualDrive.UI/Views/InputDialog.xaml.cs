using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows;

namespace FtpVirtualDrive.UI.Views;

public partial class InputDialog : Window, INotifyPropertyChanged
{
    private string _title = "Input";
    private string _message = "Enter value:";
    private string _inputText = "";

    public string Title
    {
        get => _title;
        set => SetProperty(ref _title, value);
    }

    public string Message
    {
        get => _message;
        set => SetProperty(ref _message, value);
    }

    public string InputText
    {
        get => _inputText;
        set => SetProperty(ref _inputText, value);
    }

    public InputDialog()
    {
        InitializeComponent();
        DataContext = this;
    }

    public InputDialog(string title, string message, string defaultValue = "") : this()
    {
        Title = title;
        Message = message;
        InputText = defaultValue;
    }

    private void OkButton_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = true;
        Close();
    }

    private void CancelButton_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        InputTextBox.Focus();
        InputTextBox.SelectAll();
    }

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
}
