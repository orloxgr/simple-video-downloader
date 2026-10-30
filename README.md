# Svid

Simple Video Download Cut and Convert

Svid helps you download videos, cut clips, and convert media files from one
simple Windows app. It supports drag and drop, keeps downloads/cuts/converts/
subtitles in separate folders, and includes a normal installer/uninstaller.

It is powered by `yt-dlp`, `ffmpeg`, Deno, and Microsoft WebView2. You do not
need to install these tools manually; Svid downloads or bundles what it needs.

## Features

- Download videos as MP4, MKV, MP3, or the original format.
- Record live broadcasts from Diavlos ePresence, Hellas News, or a direct HLS URL.
- Schedule live recordings by date/time, with automatic standby for late broadcasts,
  optional stop time, and Stop & Save.
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
Live:      %USERPROFILE%\Videos\Svid\live
```

## Live recording

1. Open **Live** and paste a Diavlos ePresence event URL, a Hellas News live
   page URL, or a direct `.m3u8` URL. The **Hellas News** button fills in the
   Δήμος Δάφνης-Υμηττού channel (`position=8`).
2. Choose a recording name, start date/time and MP4 or TS. Times use the
   computer's local timezone, shown in the Live tab.
3. Optionally set a stop date/time. Without it, recording continues until the
   stream ends or you press **Stop & Save** in Jobs.
4. Click **Schedule / Stand by**, or **Start Now / Stand by** for an immediate
   check. If the stream is offline, Svid keeps checking until it appears or
   the job is stopped. A delayed broadcast does not expire after 15 minutes.

Keep Svid open and the computer awake and connected. Scheduling does not wake
or turn on the computer. Waiting schedules are saved beside the app in
`live-jobs.json` and resume when it reopens; an expired stop time cancels them.
Closing the Windows app saves active recordings before exiting. Recordings
interrupted by a crash are marked failed, with their saved parts left intact.

Each recording has its own folder under the Live folder, with recoverable
10-second TS parts in `segments` and the final `recording.mp4` or `recording.ts`.
The exact part duration follows stream keyframes. If the source codecs cannot
be remuxed to MP4, Svid saves a joined TS instead. FFmpeg diagnostics and all
parts remain in the session folder. Settings lets you change the Live folder.

The Diavlos AutoCapture workflow is integrated through `live_capture.py`:
hidden-browser autoplay and HLS detection, retry while offline, recoverable
parts and joining on stop. FFmpeg handles HLS variants and audio tracks.
Hellas News players are resolved from the page and its nested Castr iframe,
so channel URLs are refreshed instead of hardcoding a CDN stream address.
Python/Playwright are installed automatically through `uv` on first use; the
helper uses installed Edge or downloads headless Chromium when needed.

Developer checks (the Python HLS tests use the local FFmpeg/FFprobe tools):

```powershell
.\deno.exe check downloader.ts live.ts
.\deno.exe test --allow-read --allow-write live_test.ts
python -m unittest -v test_live_capture.py
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
gh release create v2.4.0 dist\Svid-Setup.exe dist\Svid.exe --title "Svid v2.4.0" --notes-file RELEASE_NOTES.md
```
