using System.Diagnostics;
using System.Drawing;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Svid.Setup;

internal static class Program
{
    private const string AppName = "Svid";
    private const string AppVersion = "2.3.1";
    private const string AppTagline = "Simple Video Download Cut and Convert";
    private const string Publisher = "Byron Iniotakis";
    private const string InstalledAppExeName = "Svid.exe";
    private const string InstalledSetupExeName = "SvidSetup.exe";
    private const string UninstallRegistryKey =
        @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Svid";

    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        var quiet = HasArg(args, "/quiet") || HasArg(args, "-quiet") || HasArg(args, "/silent");
        var uninstall = HasArg(args, "/uninstall") || HasArg(args, "-uninstall");

        try
        {
            if (uninstall)
            {
                Uninstall(quiet);
            }
            else
            {
                Install(quiet);
            }

            return 0;
        }
        catch (Exception ex)
        {
            if (!quiet)
            {
                MessageBox.Show(
                    ex.Message,
                    $"{AppName} Setup",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }

            return 1;
        }
    }

    private static void Install(bool quiet)
    {
        var installDir = GetInstalledDir();
        if (!quiet)
        {
            var selectedInstallDir = PromptForInstallDir(installDir);
            if (selectedInstallDir is null)
            {
                return;
            }

            installDir = selectedInstallDir;
        }

        var appExe = Path.Combine(installDir, InstalledAppExeName);
        var setupExe = Path.Combine(installDir, InstalledSetupExeName);

        KillAppProcesses();
        Directory.CreateDirectory(installDir);

        ExtractEmbeddedApp(appExe);
        CopySelf(setupExe);
        CreateShortcuts(appExe);
        WriteUninstallEntry(installDir, appExe, setupExe);

        if (quiet)
        {
            return;
        }

        var launch = MessageBox.Show(
            $"{AppName} was installed successfully.\n\nLaunch it now?",
            $"{AppName} Setup",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Information);

        if (launch == DialogResult.Yes)
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = appExe,
                WorkingDirectory = installDir,
                UseShellExecute = true,
            });
        }
    }

    private static void Uninstall(bool quiet)
    {
        var installDir = GetInstalledDir();

        KillAppProcesses();
        DeleteShortcuts();
        Registry.CurrentUser.DeleteSubKeyTree(UninstallRegistryKey, false);

        if (!quiet)
        {
                MessageBox.Show(
                $"{AppName} was uninstalled.\n\nYour Downloads and Videos\\Svid files were kept.",
                $"{AppName} Setup",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }

        DeleteInstallDirAfterExit(installDir);
    }

    private static string GetDefaultInstallDir()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return Path.Combine(localAppData, "Programs", AppName);
    }

    private static string GetInstalledDir()
    {
        using var key = Registry.CurrentUser.OpenSubKey(UninstallRegistryKey);
        var registryPath = key?.GetValue("InstallLocation") as string;
        if (!string.IsNullOrWhiteSpace(registryPath))
        {
            return registryPath;
        }

        var currentExe = Environment.ProcessPath;
        if (!string.IsNullOrWhiteSpace(currentExe))
        {
            return Path.GetDirectoryName(currentExe) ?? GetDefaultInstallDir();
        }

        return GetDefaultInstallDir();
    }

    private static string? PromptForInstallDir(string defaultInstallDir)
    {
        using var form = new Form
        {
            Text = $"{AppName} Setup",
            StartPosition = FormStartPosition.CenterScreen,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            ClientSize = new Size(560, 210),
            Font = new Font("Segoe UI", 9F),
        };

        var appIcon = Icon.ExtractAssociatedIcon(Environment.ProcessPath ?? Application.ExecutablePath);
        if (appIcon is not null)
        {
            form.Icon = appIcon;
        }

        var title = new Label
        {
            AutoSize = true,
            Text = $"Install {AppName}",
            Font = new Font(form.Font, FontStyle.Bold),
            Location = new Point(20, 20),
        };

        var subtitle = new Label
        {
            AutoSize = true,
            Text = AppTagline,
            Location = new Point(20, 48),
        };

        var pathLabel = new Label
        {
            AutoSize = true,
            Text = "Install folder",
            Location = new Point(20, 84),
        };

        var pathBox = new TextBox
        {
            Text = defaultInstallDir,
            Location = new Point(20, 106),
            Size = new Size(420, 25),
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
        };

        var browseButton = new Button
        {
            Text = "Browse...",
            Location = new Point(450, 105),
            Size = new Size(90, 27),
            Anchor = AnchorStyles.Top | AnchorStyles.Right,
        };

        var installButton = new Button
        {
            Text = "Install",
            DialogResult = DialogResult.OK,
            Location = new Point(354, 162),
            Size = new Size(88, 30),
            Anchor = AnchorStyles.Bottom | AnchorStyles.Right,
        };

        var cancelButton = new Button
        {
            Text = "Cancel",
            DialogResult = DialogResult.Cancel,
            Location = new Point(452, 162),
            Size = new Size(88, 30),
            Anchor = AnchorStyles.Bottom | AnchorStyles.Right,
        };

        browseButton.Click += (_, _) =>
        {
            using var dialog = new FolderBrowserDialog
            {
                Description = $"Choose where to install {AppName}",
                ShowNewFolderButton = true,
                UseDescriptionForTitle = true,
            };

            var currentPath = pathBox.Text.Trim();
            if (Directory.Exists(currentPath))
            {
                dialog.SelectedPath = currentPath;
            }
            else
            {
                var parent = Directory.GetParent(currentPath);
                if (parent is not null && parent.Exists)
                {
                    dialog.SelectedPath = parent.FullName;
                }
            }

            if (dialog.ShowDialog(form) == DialogResult.OK)
            {
                pathBox.Text = dialog.SelectedPath;
            }
        };

        form.Controls.AddRange(new Control[]
        {
            title,
            subtitle,
            pathLabel,
            pathBox,
            browseButton,
            installButton,
            cancelButton,
        });
        form.AcceptButton = installButton;
        form.CancelButton = cancelButton;

        while (true)
        {
            if (form.ShowDialog() != DialogResult.OK)
            {
                return null;
            }

            var selected = pathBox.Text.Trim();
            if (string.IsNullOrWhiteSpace(selected))
            {
                MessageBox.Show(
                    form,
                    "Choose an install folder first.",
                    $"{AppName} Setup",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                continue;
            }

            try
            {
                return Path.GetFullPath(Environment.ExpandEnvironmentVariables(selected));
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    form,
                    ex.Message,
                    $"{AppName} Setup",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }
        }
    }

    private static void ExtractEmbeddedApp(string destination)
    {
        var assembly = Assembly.GetExecutingAssembly();
        using var input = assembly.GetManifestResourceStream(InstalledAppExeName)
            ?? throw new InvalidOperationException("The installer is missing the embedded Svid.exe payload.");
        using var output = File.Create(destination);
        input.CopyTo(output);
    }

    private static void CopySelf(string destination)
    {
        var self = Environment.ProcessPath
            ?? throw new InvalidOperationException("Could not find the setup executable path.");

        if (Path.GetFullPath(self).Equals(Path.GetFullPath(destination), StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        File.Copy(self, destination, overwrite: true);
    }

    private static void CreateShortcuts(string appExe)
    {
        var startMenuDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
            "Programs",
            AppName);
        Directory.CreateDirectory(startMenuDir);

        CreateShortcut(
            Path.Combine(startMenuDir, $"{AppName}.lnk"),
            appExe,
            Path.GetDirectoryName(appExe)!);

        var desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        if (!string.IsNullOrWhiteSpace(desktopDir))
        {
            CreateShortcut(
                Path.Combine(desktopDir, $"{AppName}.lnk"),
                appExe,
                Path.GetDirectoryName(appExe)!);
        }
    }

    private static void DeleteShortcuts()
    {
        var startMenuDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
            "Programs",
            AppName);
        TryDeleteFile(Path.Combine(startMenuDir, $"{AppName}.lnk"));
        TryDeleteDirectory(startMenuDir);

        var desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        if (!string.IsNullOrWhiteSpace(desktopDir))
        {
            TryDeleteFile(Path.Combine(desktopDir, $"{AppName}.lnk"));
        }
    }

    private static void CreateShortcut(string shortcutPath, string targetPath, string workingDirectory)
    {
        var script = string.Join(
            "; ",
            "$w = New-Object -ComObject WScript.Shell",
            $"$s = $w.CreateShortcut({PowerShellString(shortcutPath)})",
            $"$s.TargetPath = {PowerShellString(targetPath)}",
            $"$s.WorkingDirectory = {PowerShellString(workingDirectory)}",
            $"$s.IconLocation = {PowerShellString(targetPath + ",0")}",
            "$s.Save()");

        RunPowerShell(script, waitForExit: true);
    }

    private static void WriteUninstallEntry(string installDir, string appExe, string setupExe)
    {
        using var key = Registry.CurrentUser.CreateSubKey(UninstallRegistryKey)
            ?? throw new InvalidOperationException("Could not create the uninstall registry key.");

        var uninstallCommand = $"\"{setupExe}\" /uninstall";
        var quietUninstallCommand = $"\"{setupExe}\" /uninstall /quiet";

        key.SetValue("DisplayName", AppName, RegistryValueKind.String);
        key.SetValue("DisplayVersion", AppVersion, RegistryValueKind.String);
        key.SetValue("Publisher", Publisher, RegistryValueKind.String);
        key.SetValue("InstallLocation", installDir, RegistryValueKind.String);
        key.SetValue("DisplayIcon", appExe, RegistryValueKind.String);
        key.SetValue("UninstallString", uninstallCommand, RegistryValueKind.String);
        key.SetValue("QuietUninstallString", quietUninstallCommand, RegistryValueKind.String);
        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
    }

    private static void DeleteInstallDirAfterExit(string installDir)
    {
        if (!Directory.Exists(installDir))
        {
            return;
        }

        var script =
            $"Start-Sleep -Milliseconds 800; Remove-Item -LiteralPath {PowerShellString(installDir)} -Recurse -Force -ErrorAction SilentlyContinue";
        RunPowerShell(script, waitForExit: false);
    }

    private static void KillAppProcesses()
    {
        foreach (var name in new[] { "Svid", "svdc-backend", "SvidBackend" })
        {
            foreach (var process in Process.GetProcessesByName(name))
            {
                try
                {
                    if (process.Id == Environment.ProcessId)
                    {
                        continue;
                    }

                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(3000);
                }
                catch
                {
                    // Best effort: installation can still continue if Windows already released the file.
                }
            }
        }
    }

    private static void RunPowerShell(string script, bool waitForExit)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        psi.ArgumentList.Add("-NoProfile");
        psi.ArgumentList.Add("-ExecutionPolicy");
        psi.ArgumentList.Add("Bypass");
        psi.ArgumentList.Add("-Command");
        psi.ArgumentList.Add(script);

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("Could not start PowerShell.");
        if (waitForExit)
        {
            process.WaitForExit();
            if (process.ExitCode != 0)
            {
                throw new InvalidOperationException("Could not create the application shortcut.");
            }
        }
    }

    private static string PowerShellString(string value) => $"'{value.Replace("'", "''")}'";

    private static bool HasArg(string[] args, string value) =>
        args.Any(arg => string.Equals(arg, value, StringComparison.OrdinalIgnoreCase));

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
        }
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path) && !Directory.EnumerateFileSystemEntries(path).Any())
            {
                Directory.Delete(path);
            }
        }
        catch
        {
        }
    }
}
