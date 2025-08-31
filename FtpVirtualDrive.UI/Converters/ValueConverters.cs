using System.Globalization;
using System.Windows;
using System.Windows.Data;
using System.Windows.Media;

namespace FtpVirtualDrive.UI.Converters;

/// <summary>
/// Converts boolean to inverse boolean
/// </summary>
public class InverseBooleanConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        if (value is bool boolValue)
            return !boolValue;
        
        return false;
    }

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        if (value is bool boolValue)
            return !boolValue;
        
        return true;
    }
}

/// <summary>
/// Converts boolean to color (Green for true, Red for false)
/// </summary>
public class BooleanToColorConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        if (value is bool boolValue)
        {
            return boolValue ? Colors.Green : Colors.Red;
        }
        
        return Colors.Gray;
    }

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        throw new NotImplementedException();
    }
}

/// <summary>
/// Converts file size in bytes to human-readable format
/// </summary>
public class FileSizeConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        if (value is not long fileSize)
            return string.Empty;

        if (fileSize == 0)
            return "0 B";

        string[] sizes = { "B", "KB", "MB", "GB", "TB" };
        double len = fileSize;
        int order = 0;
        
        while (len >= 1024 && order < sizes.Length - 1)
        {
            order++;
            len = len / 1024;
        }

        return $"{len:0.##} {sizes[order]}";
    }

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        throw new NotImplementedException();
    }
}

/// <summary>
/// Converts boolean to Visibility
/// </summary>
public class BooleanToVisibilityConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        if (value is bool boolValue)
        {
            bool invert = parameter?.ToString()?.ToLower() == "invert";
            bool result = invert ? !boolValue : boolValue;
            return result ? Visibility.Visible : Visibility.Collapsed;
        }
        
        return Visibility.Collapsed;
    }

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        if (value is Visibility visibility)
        {
            bool invert = parameter?.ToString()?.ToLower() == "invert";
            bool result = visibility == Visibility.Visible;
            return invert ? !result : result;
        }
        
        return false;
    }
}

/// <summary>
/// Converts DateTime to relative time string (e.g., "2 minutes ago")
/// </summary>
public class RelativeTimeConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        if (value is not DateTime dateTime)
            return string.Empty;

        var timeSpan = DateTime.Now - dateTime;

        if (timeSpan.TotalMinutes < 1)
            return "Just now";
        
        if (timeSpan.TotalMinutes < 60)
            return $"{(int)timeSpan.TotalMinutes} minutes ago";
        
        if (timeSpan.TotalHours < 24)
            return $"{(int)timeSpan.TotalHours} hours ago";
        
        if (timeSpan.TotalDays < 7)
            return $"{(int)timeSpan.TotalDays} days ago";

        return dateTime.ToString("yyyy-MM-dd");
    }

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        throw new NotImplementedException();
    }
}

/// <summary>
/// Converts operation type to icon or color
/// </summary>
public class OperationTypeToIconConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        if (value is not Core.Models.OperationType operationType)
            return "📄";

        return operationType switch
        {
            Core.Models.OperationType.Connect => "🔗",
            Core.Models.OperationType.Disconnect => "🔌",
            Core.Models.OperationType.Download => "⬇️",
            Core.Models.OperationType.Upload => "⬆️",
            Core.Models.OperationType.Delete => "🗑️",
            Core.Models.OperationType.Create => "➕",
            Core.Models.OperationType.Open => "📂",
            Core.Models.OperationType.Modify => "✏️",
            Core.Models.OperationType.Rename => "🏷️",
            Core.Models.OperationType.Move => "🔄",
            Core.Models.OperationType.Copy => "📋",
            Core.Models.OperationType.ListDirectory => "📁",
            Core.Models.OperationType.CreateDirectory => "📁➕",
            Core.Models.OperationType.DeleteDirectory => "📁🗑️",
            _ => "📄"
        };
    }

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        throw new NotImplementedException();
    }
}
