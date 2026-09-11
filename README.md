# Svid

Simple Video Download Cut and Convert

Svid is a simple Windows app for downloading videos, cutting clips, and
converting local media. It has a native desktop window, drag and drop support,
separate output folders, and a normal Windows installer/uninstaller.

It is powered by `yt-dlp`, `ffmpeg`, Deno, and Microsoft WebView2. The user does
not need to install these tools manually; Svid downloads or bundles what it
needs.

## Features

- Download videos as MP4, MKV, MP3, or source/native format.
- Cut local videos by choosing start and end times.
- Convert local videos/audio with quality presets.
- Drag and drop files into Cut and Convert.
- Separate folders for downloads, cuts, and converts.
- Open output folders from inside the app.
- Hide/show logs when needed.
- Configure update check frequency separately for `yt-dlp`, `ffmpeg`, and Deno.
- Includes support/donation links and open-source credits.

## Download

For normal installs, give the user:

```text
dist\Svid-Setup.exe
```

The installer adds Start Menu/Desktop shortcuts and a normal Windows uninstall
entry. Uninstall removes the app files, shortcuts, and registry entry, but keeps
the user's video files.

For portable use, give the user:

```text
dist\Svid.exe
```

On first run it downloads the tools it needs beside itself:

```text
yt-dlp.exe
ffmpeg.exe
ffprobe.exe
deno.exe
```

Double-clicking the EXE opens the native Windows UI. The main EXE contains its
hidden backend and extracts it beside itself when needed. Files can be dropped
inside the UI with real Windows paths, or dragged directly onto
`Svid.exe`.

Default folders:

```text
Downloads: %USERPROFILE%\Downloads
Cuts:      %USERPROFILE%\Documents\Svid\cuts
Converts:  %USERPROFILE%\Documents\Svid\converts
```

## Installer

The setup file asks for an install folder. The default is:

```text
%LocalAppData%\Programs\Svid
```

The installer creates:

- Start Menu shortcut
- Desktop shortcut
- Windows uninstall entry

Uninstall keeps the user's downloaded, cut, and converted files.

## Build

Run:

```powershell
.\build.ps1
```

The portable build is created at:

```text
dist\Svid.exe
```

The installer build is created at:

```text
dist\Svid-Setup.exe
```

Rebuilding only replaces `Svid.exe`; downloaded tools
already in `dist` are kept.

## Release

After building, create a GitHub release with:

```powershell
gh release create v2.0.0 dist\Svid-Setup.exe dist\Svid.exe --title "Svid v2.0.0" --notes-file RELEASE_NOTES.md
```
