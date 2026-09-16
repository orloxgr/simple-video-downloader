# Svid

Simple Video Download Cut and Convert

Svid helps you download videos, cut clips, and convert media files from one
simple Windows app. It supports drag and drop, keeps downloads/cuts/converts/
subtitles in separate folders, and includes a normal installer/uninstaller.

It is powered by `yt-dlp`, `ffmpeg`, Deno, and Microsoft WebView2. You do not
need to install these tools manually; Svid downloads or bundles what it needs.

## Features

- Download videos as MP4, MKV, MP3, or the original format.
- Cut local videos by choosing start and end times.
- Convert local videos/audio with quality presets.
- Create SRT or ASS word-highlight subtitles from a video/audio file and a
  corrected TXT script.
- Drag and drop files into Cut and Convert.
- Separate folders for downloads, cuts, converts, and subtitles.
- Open output folders from inside the app.
- Hide/show logs when needed.
- Check for Svid updates from Settings and run the installer.
- Configure update check frequency separately for Svid, `yt-dlp`, `ffmpeg`,
  and Deno.

## Download

Download the installer:

```text
dist\Svid-Setup.exe
```

The installer adds Start Menu/Desktop shortcuts and a normal Windows uninstall
entry. Uninstall removes the app files, shortcuts, and registry entry, but keeps
your video files.

Portable version:

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

Double-clicking the EXE opens the app. The main EXE contains its helper process
and extracts it beside itself when needed. Files can be dropped inside the app,
or dragged directly onto `Svid.exe`.

Default folders:

```text
Downloads: %USERPROFILE%\Downloads
Cuts:      %USERPROFILE%\Videos\Svid\cuts
Converts:  %USERPROFILE%\Videos\Svid\converts
Subtitles: %USERPROFILE%\Videos\Svid\subtitles
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

Uninstall keeps your downloaded, cut, and converted files.

## License

Svid is released under the MIT License. See [LICENSE](LICENSE).

Svid uses third-party open-source tools such as `yt-dlp`, `ffmpeg`, Deno,
`sub-align`, `uv`, and Microsoft WebView2. Those projects keep their own
licenses and credits.

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
gh release create v2.3.2 dist\Svid-Setup.exe dist\Svid.exe --title "Svid v2.3.2" --notes-file RELEASE_NOTES.md
```
