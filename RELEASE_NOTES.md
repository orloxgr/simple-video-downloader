# Svid v2.4.1

Svid is a Windows app for downloading videos, cutting clips, converting media,
and creating subtitles from a corrected text file.

## What's New

- Added `Open Folder` beside `done` for each completed job. It opens that
  job's destination, even after output settings have changed.
- Added an output folder and folder picker to Cut, Convert, and Subtitles,
  with a `Same as input folder` checkbox.
- Added a per-download destination directory.
- Cut, conversion, and subtitle filenames now include a date-time stamp with
  milliseconds.
- Includes the updated macOS Apple Silicon preview ZIP. The Mac build is
  cross-compiled, not yet verified on a physical Mac, and unsigned.

## Live Recording

- Integrated Diavlos live capture and Hellas News/Castr live recording.
- Added a Live tab with date/time scheduling, offline standby, optional stop
  date/time, MP4/TS output and Stop & Save controls in Jobs.
- Added a shortcut for the Hellas News Δήμος Δάφνης-Υμηττού channel.
- Saved waiting schedules resume when Svid reopens. Keep Svid open and the PC
  awake for recording at the scheduled time.
- Closing Svid gracefully saves active recordings and retains pending schedules.
- Live recordings keep recoverable TS parts and FFmpeg diagnostics in their
  own folders. If MP4 remux fails, the joined TS is retained instead.
- Added a configurable Live folder, defaulting to
  `%USERPROFILE%\Videos\Svid\live`.
- Live capture prepares Python/Playwright automatically on first use and
  discovers the stream from the current page and embedded player.

## Previous improvements

- Improved UI/backend error reporting so failed job requests show the real
  error instead of a generic `Request failed` message.
- Changed SRT subtitle length handling so Svid aligns the original TXT first,
  then splits the final SRT into the selected number of words per subtitle.
  This avoids overloading alignment with hundreds of very short script lines.
- Reduced subtitle alignment memory pressure by limiting Python numeric library
  threads during alignment.
- Added a clear out-of-memory message when subtitle alignment fails because the
  Whisper/NumPy stack cannot allocate enough memory.
- Fixed access to video/audio/text files on network shares such as
  `\\server\share\file.mp4`.
- Added subtitle alignment from video/audio plus a corrected TXT script.
- Added subtitle output folders under `%USERPROFILE%\Videos\Svid\subtitles`.
- Added `SRT` output for normal subtitles.
- Added `ASS word highlight` output for word-by-word highlighted subtitles.
- Added ASS subtitle controls for font size, active word color, and passed
  words color.
- Added subtitle length control from 1 to 20 words per subtitle, plus an option
  to keep the original text lines.
- Subtitle files now include a date-time stamp in the filename, so repeated runs
  do not overwrite older subtitle files.
- Added app version display in the Svid window header.

## Also Included

- Download videos as MP4, MKV, MP3, or original format.
- Cut videos by choosing start and end times.
- Convert local files with quality presets.
- Drag and drop local video files into Cut and Convert.
- Separate output folders for downloads, cuts, converts, and subtitles.
- Check for Svid updates from Settings and run the installer.
- Settings for update check frequency per item.
- Installer with selectable install path, Start Menu/Desktop shortcuts, and
  Windows uninstall.

## Default Folders

- Downloads: `%USERPROFILE%\Downloads`
- Cuts: `%USERPROFILE%\Videos\Svid\cuts`
- Converts: `%USERPROFILE%\Videos\Svid\converts`
- Subtitles: `%USERPROFILE%\Videos\Svid\subtitles`

## Files

- `Svid-Setup.exe`: installer.
- `Svid.exe`: portable app.
- `Svid-macOS-arm64.zip`: macOS 14+ Apple Silicon preview (M1 or newer).
