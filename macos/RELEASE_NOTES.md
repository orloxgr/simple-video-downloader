# Svid 2.4.5 - macOS Preview 1

- Version 2.4.5 is displayed in Svid and included in the Mac bundle metadata.
- Added Clear Job for finished jobs without deleting their media files.
- Live recording dates and times have separate fields and an hours/minutes
  picker, including on macOS.
- Live source checks use native HTTPS certificate validation and report actual
  connection errors instead of treating them as an offline stream.
- Diavlos conferences use the actual broadcast URL from the public conference
  API instead of the introductory video or offline placeholder.
- Offline Diavlos conferences stay on standby and retry the live source.
- Shortened Unicode download filenames while retaining the video ID, fixing
  Facebook downloads that failed with `File name too long`.
- Added detection of public media URLs in Alpha's Kwik player for news pages
  that yt-dlp could not extract directly.
- Svid opens in its own window instead of a browser tab.
- The window uses the Mac's built-in WebKit. Native window support is bundled
  with the app; no extra installation is needed.
- Added a Mac menu with editing commands and Quit Svid.
- File drops pass the original paths to Cut, Convert, and Subtitles.
- Closing the window saves live recordings before exiting. Other running jobs
  must finish before quitting.
- Signed the complete app bundle and its native library with ad-hoc signatures.

## Install

Requires macOS 14 or newer on Apple Silicon (M1 or newer).

1. Quit the previous Svid version from Settings before replacing it.
2. Extract `Svid-macOS-arm64.zip` and move `Svid.app` to Applications.
3. Double-click `Svid.app`.

Settings and downloaded tools are kept separately from the app and are retained.
Media tools are prepared automatically when needed.

This preview is cross-compiled on Windows. Build, package signature checks,
and isolated window lifecycle tests passed; the native window still needs
verification on an actual Mac. No user media jobs were run for these checks.

The app has no Apple Developer ID signature or notarization. If macOS blocks
opening it, see `START-HERE.txt` in the ZIP and System Settings > Privacy & Security.
