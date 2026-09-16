# Svid v2.3.4

Svid is a Windows app for downloading videos, cutting clips, converting media,
and creating subtitles from a corrected text file.

## What's New

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
