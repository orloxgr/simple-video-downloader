# Svid 2.4.1 - macOS Preview 2

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
