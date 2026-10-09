using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Diagnostics;
using System.Windows.Forms;
using Microsoft.Win32;

// Per-user, side-by-side internal candidate installer. No service, elevation or auto-update.
class Installer {
    const string Product = "AIAppNest Internal Candidate";
    static string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "AIAppNest");
    static string Programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
    static string RegistryPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\AIAppNestInternal";
    static void Unlinked(string path) {
        for (var dir = new DirectoryInfo(path); dir != null; dir = dir.Parent)
            if (dir.Exists && (dir.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked install path is not supported.");
    }
    static void Shortcut(string name, string exe, string arguments) {
        var type = Type.GetTypeFromProgID("WScript.Shell");
        dynamic shell = Activator.CreateInstance(type);
        dynamic shortcut = shell.CreateShortcut(Path.Combine(Programs, name + ".lnk"));
        shortcut.TargetPath = exe; shortcut.Arguments = arguments; shortcut.WorkingDirectory = Path.GetDirectoryName(exe); shortcut.Save();
    }
    static void EnsureClosed() {
        foreach (var process in Process.GetProcessesByName("AIAppNest")) {
            using (process) {
                try { if (process.MainModule.FileName.StartsWith(Root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Close AIAppNest and wait for active tasks to stop before continuing."); }
                catch (System.ComponentModel.Win32Exception) { throw new InvalidOperationException("Cannot verify that AIAppNest is closed."); }
            }
        }
    }
#if !UNINSTALL
    static Stream Payload() {
        var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip");
        using (var hash = SHA256.Create()) {
            if (BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant() != BuildInfo.Sha256) { stream.Dispose(); throw new IOException("Payload checksum mismatch."); }
        }
        stream.Position = 0; return stream;
    }
#endif
    [STAThread] static int Main(string[] args) {
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
        AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        Application.EnableVisualStyles();
        try {
#if !UNINSTALL
            // Read-only build verification of the actual embedded archive, no UI,
            // install, shortcuts, registry writes or user data access.
            if (args.Length == 1 && args[0] == "--verify-payload") {
                using (var stream = Payload()) using (var zip = new ZipArchive(stream, ZipArchiveMode.Read)) {
                    foreach (var entry in zip.Entries) using (var input = entry.Open()) { input.CopyTo(Stream.Null); }
                }
                return 0;
            }
#endif
            if (!Environment.Is64BitOperatingSystem || Environment.OSVersion.Platform != PlatformID.Win32NT || Environment.OSVersion.Version.Build < 22000) throw new Exception("Windows 11 x64 is required.");
            Unlinked(Root); EnsureClosed();
#if UNINSTALL
            if (MessageBox.Show("Uninstall all AIAppNest candidate binaries? User data, profiles and upgrade snapshots are retained. Default data: %LOCALAPPDATA%\\LocalAIHub. Close the application first.", Product, MessageBoxButtons.OKCancel) != DialogResult.OK) return 0;
            var versions = Path.Combine(Root, "versions");
            Unlinked(versions);
            if (Directory.Exists(versions)) {
                foreach (var path in Directory.GetDirectories(versions, "*", SearchOption.AllDirectories)) Unlinked(path);
                Directory.Delete(versions, true);
            }
            foreach (var name in new[] { Product, Product + " - Rollback" }) File.Delete(Path.Combine(Programs, name + ".lnk"));
            Registry.CurrentUser.DeleteSubKeyTree(RegistryPath, false);
            MessageBox.Show("Uninstalled. User data and snapshots retained. This small uninstaller remains in " + Root, Product); return 0;
#else
            if (MessageBox.Show("Install UNSIGNED internal candidate " + BuildInfo.Id + " for this Windows account?\n\nNot a public release. Close AIAppNest first. Older binaries and user data are retained. Python/Bash and model services are separate dependencies.", Product, MessageBoxButtons.OKCancel) != DialogResult.OK) return 0;
            Directory.CreateDirectory(Root); Unlinked(Root);
            var versions = Path.Combine(Root, "versions"); Unlinked(versions); Directory.CreateDirectory(versions);
            var target = Path.Combine(versions, BuildInfo.Id);
            if (Directory.Exists(target)) throw new IOException("This candidate already exists. Use its Start menu shortcut or uninstall before reinstalling. Existing files were not overwritten.");
            var stage = Path.Combine(versions, ".incomplete-" + Guid.NewGuid().ToString("N"));
            var drive = new DriveInfo(Path.GetPathRoot(Root));
            if (drive.AvailableFreeSpace < BuildInfo.RequiredBytes) throw new IOException("Insufficient disk space for installation plus staging.");
            Directory.CreateDirectory(stage);
            using (var stream = Payload()) {
                using (var zip = new ZipArchive(stream, ZipArchiveMode.Read)) foreach (var entry in zip.Entries) {
                    var file = Path.GetFullPath(Path.Combine(stage, entry.FullName));
                    if (!file.StartsWith(stage + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("Invalid archive path.");
                    if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(file); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(file)); entry.ExtractToFile(file, false);
                }
            }
            // Only a completely extracted directory becomes selectable; interruption leaves .incomplete-*.
            Directory.Move(stage, target);
            File.Copy(Path.Combine(target, "Uninstall.exe"), Path.Combine(Root, "Uninstall.exe"), true);
            var exe = Path.Combine(target, "AIAppNest.exe");
            Shortcut(Product, exe, ""); Shortcut(Product + " - Rollback", exe, "--rollback-release");
            using (var key = Registry.CurrentUser.CreateSubKey(RegistryPath)) {
                key.SetValue("DisplayName", Product); key.SetValue("DisplayVersion", BuildInfo.Id);
                key.SetValue("InstallLocation", Root); key.SetValue("UninstallString", "\"" + Path.Combine(Root, "Uninstall.exe") + "\"");
                key.SetValue("NoModify", 1); key.SetValue("NoRepair", 1);
            }
            MessageBox.Show("Installed. Launch from the Start menu.\nData: %LOCALAPPDATA%\\LocalAIHub (or the root selected in the application).\nNo tasks are automatically replayed. This candidate is not formally released.", Product);
            return 0;
#endif
        } catch (Exception error) {
            if (args.Length == 1 && args[0] == "--verify-payload") return 1;
            MessageBox.Show(error.Message + "\nExisting data and older versions are retained.", Product, MessageBoxButtons.OK, MessageBoxIcon.Error); return 1;
        }
    }
}
