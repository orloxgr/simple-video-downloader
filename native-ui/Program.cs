using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using OleDataObject = System.Runtime.InteropServices.ComTypes.IDataObject;

namespace Svid;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        using var backend = BackendProcess.Start();
        Application.Run(new MainForm(backend));
    }
}

internal sealed class BackendProcess : IDisposable
{
    private readonly Process process;

    private BackendProcess(Process process, Uri baseUri)
    {
        this.process = process;
        BaseUri = baseUri;
    }

    public Uri BaseUri { get; }

    public static BackendProcess Start()
    {
        var backendPath = ExtractBackend();
        var port = FindFreePort();
        var baseUri = new Uri($"http://127.0.0.1:{port}");
        var process = Process.Start(new ProcessStartInfo
        {
            FileName = backendPath,
            Arguments = $"--no-open --port={port}",
            WorkingDirectory = AppContext.BaseDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        }) ?? throw new InvalidOperationException("Could not start backend.");

        using var client = new HttpClient { BaseAddress = baseUri, Timeout = TimeSpan.FromSeconds(1) };
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                using var response = client.GetAsync("/api/settings").GetAwaiter().GetResult();
                if (response.IsSuccessStatusCode) return new BackendProcess(process, baseUri);
            }
            catch
            {
                Thread.Sleep(250);
            }
        }

        try
        {
            process.Kill(true);
        }
        catch
        {
        }

        throw new InvalidOperationException("Backend did not start in time.");
    }

    private static string ExtractBackend()
    {
        var target = Path.Combine(AppContext.BaseDirectory, "svdc-backend.exe");
        using var stream = Assembly.GetExecutingAssembly()
            .GetManifestResourceStream("svdc-backend.exe");

        if (stream is null)
        {
            if (File.Exists(target)) return target;
            throw new InvalidOperationException("Embedded backend is missing.");
        }

        var shouldWrite = !File.Exists(target) ||
            new FileInfo(target).Length != stream.Length;
        if (!shouldWrite) return target;

        var temp = target + ".tmp";
        using (var output = File.Create(temp))
        {
            stream.CopyTo(output);
        }

        if (File.Exists(target)) File.Delete(target);
        File.Move(temp, target);
        return target;
    }

    private static int FindFreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint) listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    public void Dispose()
    {
        try
        {
            if (!process.HasExited) process.Kill(true);
        }
        catch
        {
        }

        process.Dispose();
    }
}

internal sealed class MainForm : Form
{
    private readonly BackendProcess backend;
    private readonly WebView2 webView = new();
    private readonly List<NativeFileDropTarget> dropTargets = [];
    private bool webViewReady;

    public MainForm(BackendProcess backend)
    {
        this.backend = backend;

        Text = "Svid";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(760, 520);
        Size = new Size(960, 680);
        BackColor = Color.FromArgb(18, 18, 18);
        AllowDrop = true;
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);

        webView.Dock = DockStyle.Fill;
        webView.AllowExternalDrop = false;
        webView.DefaultBackgroundColor = Color.FromArgb(18, 18, 18);
        webView.DragEnter += FileDragEnter;
        webView.DragDrop += WebViewDragDrop;
        Controls.Add(webView);

        DragEnter += FileDragEnter;
        DragDrop += WebViewDragDrop;
        Shown += async (_, _) => await StartWebViewAsync();
    }

    private async Task StartWebViewAsync()
    {
        var userData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Svid",
            "WebView2"
        );
        var environment = await CoreWebView2Environment.CreateAsync(null, userData);
        await webView.EnsureCoreWebView2Async(environment);

        webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
        webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
        webView.CoreWebView2.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenExternalUrl(e.Uri);
        };
        webView.CoreWebView2.NavigationCompleted += (_, _) =>
        {
            webViewReady = true;
            RegisterNativeDropTargets();
        };
        webView.CoreWebView2.Navigate(backend.BaseUri.ToString());
    }

    private static void OpenExternalUrl(string? uri)
    {
        if (string.IsNullOrWhiteSpace(uri)) return;
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed)) return;
        if (parsed.Scheme is not ("http" or "https")) return;

        Process.Start(new ProcessStartInfo
        {
            FileName = parsed.ToString(),
            UseShellExecute = true,
        });
    }

    private void RegisterNativeDropTargets()
    {
        foreach (var target in dropTargets) target.Dispose();
        dropTargets.Clear();

        RegisterHandleForDrop(Handle);
        RegisterHandleForDrop(webView.Handle);
        NativeMethods.EnumChildWindows(webView.Handle, (hwnd, _) =>
        {
            RegisterHandleForDrop(hwnd);
            return true;
        }, IntPtr.Zero);
    }

    private void RegisterHandleForDrop(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return;
        var target = new NativeFileDropTarget(hwnd, PostDropPaths);
        var hr = NativeMethods.RegisterDragDrop(hwnd, target);
        if (hr == NativeMethods.DragDropAlreadyRegistered)
        {
            NativeMethods.RevokeDragDrop(hwnd);
            hr = NativeMethods.RegisterDragDrop(hwnd, target);
        }

        if (hr == 0) dropTargets.Add(target);
    }

    private static void FileDragEnter(object? sender, DragEventArgs e)
    {
        e.Effect = e.Data?.GetDataPresent(DataFormats.FileDrop) == true
            ? DragDropEffects.Copy
            : DragDropEffects.None;
    }

    private void WebViewDragDrop(object? sender, DragEventArgs e)
    {
        if (!TryGetDropPaths(e, out var paths)) return;
        PostDropPaths(paths);
    }

    private void PostDropPaths(string[] paths)
    {
        if (!webViewReady || webView.CoreWebView2 is null) return;
        var payload = JsonSerializer.Serialize(new
        {
            kind = "native-file-drop",
            paths,
        });
        webView.CoreWebView2.PostWebMessageAsJson(payload);
    }

    private static bool TryGetDropPaths(DragEventArgs e, out string[] paths)
    {
        paths = [];
        if (e.Data?.GetDataPresent(DataFormats.FileDrop) != true) return false;
        paths = ((string[]?) e.Data.GetData(DataFormats.FileDrop) ?? [])
            .Where(File.Exists)
            .ToArray();
        return paths.Length > 0;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            foreach (var target in dropTargets) target.Dispose();
            dropTargets.Clear();
            webView.Dispose();
        }

        base.Dispose(disposing);
    }
}

[ComVisible(true)]
internal sealed class NativeFileDropTarget : IDropTarget, IDisposable
{
    private readonly IntPtr hwnd;
    private readonly Action<string[]> onDrop;
    private bool registered = true;

    public NativeFileDropTarget(IntPtr hwnd, Action<string[]> onDrop)
    {
        this.hwnd = hwnd;
        this.onDrop = onDrop;
    }

    public void DragEnter(
        OleDataObject pDataObj,
        int grfKeyState,
        NativeMethods.PointL pt,
        ref int pdwEffect
    )
    {
        pdwEffect = TryGetPaths(pDataObj, out _) ? NativeMethods.DropEffectCopy : NativeMethods.DropEffectNone;
    }

    public void DragOver(int grfKeyState, NativeMethods.PointL pt, ref int pdwEffect)
    {
        pdwEffect = NativeMethods.DropEffectCopy;
    }

    public void DragLeave()
    {
    }

    public void Drop(
        OleDataObject pDataObj,
        int grfKeyState,
        NativeMethods.PointL pt,
        ref int pdwEffect
    )
    {
        if (TryGetPaths(pDataObj, out var paths))
        {
            pdwEffect = NativeMethods.DropEffectCopy;
            onDrop(paths);
            return;
        }

        pdwEffect = NativeMethods.DropEffectNone;
    }

    private static bool TryGetPaths(OleDataObject dataObject, out string[] paths)
    {
        paths = [];
        var format = new FORMATETC
        {
            cfFormat = NativeMethods.CfHdrop,
            dwAspect = DVASPECT.DVASPECT_CONTENT,
            lindex = -1,
            tymed = TYMED.TYMED_HGLOBAL,
        };

        try
        {
            dataObject.GetData(ref format, out var medium);
            try
            {
                var count = NativeMethods.DragQueryFile(medium.unionmember, 0xFFFFFFFF, null, 0);
                var result = new List<string>();
                for (uint i = 0; i < count; i++)
                {
                    var length = NativeMethods.DragQueryFile(medium.unionmember, i, null, 0);
                    if (length == 0) continue;
                    var buffer = new char[length + 1];
                    NativeMethods.DragQueryFile(medium.unionmember, i, buffer, buffer.Length);
                    var path = new string(buffer).TrimEnd('\0');
                    if (File.Exists(path)) result.Add(path);
                }

                paths = result.ToArray();
                return paths.Length > 0;
            }
            finally
            {
                NativeMethods.ReleaseStgMedium(ref medium);
            }
        }
        catch
        {
            return false;
        }
    }

    public void Dispose()
    {
        if (!registered) return;
        registered = false;
        NativeMethods.RevokeDragDrop(hwnd);
    }
}

[ComImport]
[Guid("00000122-0000-0000-C000-000000000046")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IDropTarget
{
    void DragEnter(
        [In] OleDataObject pDataObj,
        [In] int grfKeyState,
        [In] NativeMethods.PointL pt,
        [In, Out] ref int pdwEffect
    );

    void DragOver(
        [In] int grfKeyState,
        [In] NativeMethods.PointL pt,
        [In, Out] ref int pdwEffect
    );

    void DragLeave();

    void Drop(
        [In] OleDataObject pDataObj,
        [In] int grfKeyState,
        [In] NativeMethods.PointL pt,
        [In, Out] ref int pdwEffect
    );
}

internal static partial class NativeMethods
{
    public const short CfHdrop = 15;
    public const int DropEffectNone = 0;
    public const int DropEffectCopy = 1;
    public const int DragDropAlreadyRegistered = unchecked((int) 0x80040101);

    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public readonly struct PointL
    {
        public readonly int X;
        public readonly int Y;
    }

    [DllImport("ole32.dll")]
    public static extern int RegisterDragDrop(IntPtr hwnd, IDropTarget dropTarget);

    [DllImport("ole32.dll")]
    public static extern int RevokeDragDrop(IntPtr hwnd);

    [DllImport("ole32.dll")]
    public static extern void ReleaseStgMedium(ref STGMEDIUM medium);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumChildWindows(
        IntPtr hwndParent,
        EnumWindowsProc lpEnumFunc,
        IntPtr lParam
    );

    [DllImport("shell32.dll", EntryPoint = "DragQueryFileW", CharSet = CharSet.Unicode)]
    public static extern uint DragQueryFile(
        IntPtr hDrop,
        uint iFile,
        [Out] char[]? lpszFile,
        int cch
    );
}
