"""Package a cross-compiled Deno executable as a Mac app ZIP from any OS."""

import argparse
import plistlib
import stat
import struct
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def mac_icon() -> bytes:
    # Reuse the largest PNG already embedded in the existing Windows icon.
    icon = (ROOT / "assets" / "app-icon.ico").read_bytes()
    count = struct.unpack_from("<H", icon, 4)[0]
    for index in range(count):
        width, height, _, _, _, _, length, offset = struct.unpack_from("<BBBBHHII", icon, 6 + index * 16)
        png = icon[offset:offset + length]
        if width == 0 and height == 0 and png.startswith(b"\x89PNG"):
            chunk = b"ic08" + struct.pack(">I", len(png) + 8) + png
            return b"icns" + struct.pack(">I", len(chunk) + 8) + chunk
    raise ValueError("The app icon must contain a 256px PNG")


def entry(archive: zipfile.ZipFile, name: str, content: bytes, executable: bool = False):
    item = zipfile.ZipInfo(name)
    item.create_system = 3
    item.compress_type = zipfile.ZIP_DEFLATED
    item.external_attr = (stat.S_IFREG | (0o755 if executable else 0o644)) << 16
    archive.writestr(item, content)


def package(binary: Path, output: Path, version: str, arch: str):
    plist = {
        "CFBundleName": "Svid",
        "CFBundleDisplayName": "Svid",
        "CFBundleIdentifier": "gr.orlox.svid",
        "CFBundleExecutable": "Svid",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": version,
        "CFBundleVersion": version,
        "CFBundleIconFile": "Svid.icns",
        "LSMinimumSystemVersion": "14.0",
        "LSUIElement": True,
        "NSHighResolutionCapable": True,
        "NSDownloadsFolderUsageDescription": "Svid saves your downloaded videos in Downloads.",
        "NSMoviesFolderUsageDescription": "Svid saves recordings and converted media in Movies/Svid.",
        "NSDocumentsFolderUsageDescription": "Svid opens the media and text files you select.",
    }
    readme = f"""Svid {version} - macOS {'Apple Silicon (M1 or newer)' if arch == 'arm64' else 'Intel'} preview

Requires macOS 14 or newer and internet access for the first run.

1. Extract this ZIP and drag Svid.app into Applications.
2. Double-click Svid.app. Svid opens in your default browser, without Terminal.
3. Use Download, Live, Cut, Convert, Subtitles and Settings as on Windows.

This preview has no Apple Developer ID signature or notarization. If macOS
blocks it, open System Settings > Privacy & Security and use Open Anyway for
Svid, then confirm Open. The build was cross-compiled on Windows and still
needs an actual Mac test.

The first job downloads the required tools automatically; no Homebrew, Python
or Deno installation is needed. Keep the browser tab open and the Mac awake
for scheduled recordings. Closing a tab does not stop an active recording.
To quit and save live recordings, use Settings > Save recordings & Quit Svid.
Double-click Svid.app again to reopen the existing session.

Downloads: ~/Downloads
Recordings and other output: ~/Movies/Svid
Settings, schedules and downloaded tools: ~/Library/Application Support/Svid

To update, quit Svid and replace Svid.app in Applications. Your settings and
media are kept separately. To uninstall, remove Svid.app; remove its Application
Support folder only if you also want to remove settings and downloaded tools.
"""
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        entry(archive, "Svid.app/Contents/Info.plist", plistlib.dumps(plist))
        entry(archive, "Svid.app/Contents/PkgInfo", b"APPL????")
        entry(archive, "Svid.app/Contents/Resources/Svid.icns", mac_icon())
        entry(archive, "Svid.app/Contents/MacOS/Svid", binary.read_bytes(), executable=True)
        entry(archive, "START-HERE.txt", readme.encode("utf-8"))
        entry(archive, "LICENSE.txt", (ROOT / "LICENSE").read_bytes())
    print(f"Built: {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--arch", choices=("arm64", "x64"), required=True)
    args = parser.parse_args()
    package(args.binary, args.output, args.version, args.arch)
