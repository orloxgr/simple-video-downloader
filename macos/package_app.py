"""Package a cross-compiled Deno executable as a Mac app ZIP from any OS."""

import argparse
import base64
import hashlib
import io
import json
import plistlib
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def webview_resources(arch: str) -> dict[str, bytes]:
    manifest = json.loads((ROOT / "macos" / "webview-deps.json").read_text())
    version = manifest["version"]
    cache = ROOT / "build" / "tools" / f"webview-{version}"
    cache.mkdir(parents=True, exist_ok=True)
    resources = {}
    for name, files in [
        ("webview", ["index.js", "js-bindings.js", "package.json", "LICENSE"]),
        (f"webview-darwin-{arch}", [f"webview.darwin-{arch}.node"]),
    ]:
        archive = cache / f"{name}.tgz"
        if not archive.exists():
            url = f"https://registry.npmjs.org/@webviewjs/{name}/-/{name}-{version}.tgz"
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read()
        else:
            data = archive.read_bytes()
        digest = base64.b64encode(hashlib.sha512(data).digest()).decode("ascii")
        if digest != manifest["packages"][name]:
            raise ValueError(f"Native window dependency checksum mismatch: {name}")
        if not archive.exists():
            archive.write_bytes(data)
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as source:
            for filename in files:
                member = source.getmember(f"package/{filename}")
                if not member.isfile():
                    raise ValueError(f"Invalid native window dependency: {filename}")
                resources[filename] = source.extractfile(member).read()
    return resources


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


def verify_bundle(bundle: Path):
    """Check code pages and the bundle seals; this is not a Gatekeeper assessment."""
    contents = bundle / "Contents"
    binary = (contents / "MacOS" / "Svid").read_bytes()
    info = (contents / "Info.plist").read_bytes()
    resources = (contents / "_CodeSignature" / "CodeResources").read_bytes()
    if struct.unpack_from("<I", binary)[0] != 0xfeedfacf:
        raise ValueError("Expected a 64-bit Mach-O executable")
    offset = 32
    signature_offset = None
    for _ in range(struct.unpack_from("<I", binary, 16)[0]):
        command, size = struct.unpack_from("<II", binary, offset)
        if command == 0x1d:
            signature_offset = struct.unpack_from("<I", binary, offset + 8)[0]
            break
        offset += size
    if signature_offset is None:
        raise ValueError("Missing executable signature")
    magic, _, count = struct.unpack_from(">III", binary, signature_offset)
    if magic != 0xfade0cc0:
        raise ValueError("Invalid signature container")
    directories = 0
    for index in range(count):
        _, relative = struct.unpack_from(">II", binary, signature_offset + 12 + index * 8)
        base = signature_offset + relative
        if struct.unpack_from(">I", binary, base)[0] != 0xfade0c02:
            continue
        fields = struct.unpack_from(">9I4B", binary, base)
        hash_offset, special_slots, code_slots, limit = fields[4], fields[6], fields[7], fields[8]
        hash_size, hash_type, page_shift = fields[9], fields[10], fields[12]
        algorithms = {1: "sha1", 2: "sha256", 3: "sha256"}
        if hash_type not in algorithms or not 0 < limit <= signature_offset:
            raise ValueError("Unsupported code directory")
        digest = lambda data: hashlib.new(algorithms[hash_type], data).digest()[:hash_size]
        if code_slots != (limit + (1 << page_shift) - 1) >> page_shift:
            raise ValueError("Invalid signed page count")
        for page in range(code_slots):
            start = base + hash_offset + page * hash_size
            content = binary[page << page_shift:min((page + 1) << page_shift, limit)]
            if digest(content) != binary[start:start + hash_size]:
                raise ValueError(f"Invalid executable signature on page {page}")
        for slot, content in [(1, info), (3, resources)]:
            start = base + hash_offset - slot * hash_size
            if special_slots < slot or digest(content) != binary[start:start + hash_size]:
                raise ValueError(f"Invalid bundle signature slot {slot}")
        directories += 1
    if not directories:
        raise ValueError("Missing code directory")
    sealed = plistlib.loads(resources).get("files2", {})
    if "Resources/Svid.icns" not in sealed:
        raise ValueError("Missing icon resource seal")
    for name, record in sealed.items():
        if "hash2" not in record:
            continue
        actual = hashlib.sha256((contents / name).read_bytes()).digest()
        if record["hash2"] != actual:
            raise ValueError(f"Invalid sealed resource: {name}")


def package(binary: Path, output: Path, version: str, arch: str, rcodesign: Path | None = None):
    native_codesign = shutil.which("codesign") if sys.platform == "darwin" else None
    if rcodesign is None and native_codesign is None:
        raise ValueError("Bundle signing is required. Run build-macos.ps1 or pass --rcodesign.")
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
        "LSUIElement": False,
        "NSHighResolutionCapable": True,
        "NSDownloadsFolderUsageDescription": "Svid saves your downloaded videos in Downloads.",
        "NSMoviesFolderUsageDescription": "Svid saves recordings and converted media in Movies/Svid.",
        "NSDocumentsFolderUsageDescription": "Svid opens the media and text files you select.",
    }
    readme = f"""Svid {version} - macOS {'Apple Silicon (M1 or newer)' if arch == 'arm64' else 'Intel'} preview

Requires macOS 14 or newer and internet access for the first run.

1. Extract this ZIP and drag Svid.app into Applications.
2. Double-click Svid.app. Svid opens in its own window, without Terminal.
3. Use Download, Live, Cut, Convert, Subtitles and Settings as on Windows.

This preview has an ad-hoc bundle signature, but no Apple Developer ID
signature or notarization. If macOS
blocks it, open System Settings > Privacy & Security and use Open Anyway for
Svid, then confirm Open. The build was cross-compiled on Windows and still
needs an actual Mac test.

The first job downloads the required tools automatically; no Homebrew, Python
or Deno installation is needed. The window uses the Mac's built-in WebKit;
its native window support is bundled, not downloaded at first launch.
Keep Svid open and the Mac awake for scheduled recordings. Closing Svid or
choosing Quit saves active live recordings before exiting. Finish other
running jobs before quitting. Settings also has Save recordings & Quit Svid.
Double-clicking Svid.app again brings its existing window to the front.

Downloads: ~/Downloads
Recordings and other output: ~/Movies/Svid
Settings, schedules and downloaded tools: ~/Library/Application Support/Svid

To update, quit Svid and replace Svid.app in Applications. Your settings and
media are kept separately. To uninstall, remove Svid.app; remove its Application
Support folder only if you also want to remove settings and downloaded tools.
"""
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="svid-macos-", dir=output.parent) as staging:
        bundle = Path(staging) / "Svid.app"
        contents = bundle / "Contents"
        (contents / "Resources").mkdir(parents=True)
        (contents / "MacOS").mkdir()
        (contents / "Info.plist").write_bytes(plistlib.dumps(plist))
        (contents / "PkgInfo").write_bytes(b"APPL????")
        (contents / "Resources" / "Svid.icns").write_bytes(mac_icon())
        webview_dir = contents / "Resources" / "webview"
        webview_dir.mkdir()
        for name, content in webview_resources(arch).items():
            (webview_dir / name).write_bytes(content)
        executable = contents / "MacOS" / "Svid"
        shutil.copyfile(binary, executable)
        executable.chmod(0o755)

        # Sign the completed bundle, so its metadata and resources are sealed too.
        if rcodesign is not None:
            signer = str(rcodesign.resolve())
            subprocess.run([signer, "sign", "--timestamp-url", "none", str(webview_dir / f"webview.darwin-{arch}.node")], check=True)
            subprocess.run([signer, "sign", "--timestamp-url", "none", str(bundle)], check=True)
        else:
            subprocess.run([native_codesign, "--force", "--sign", "-", str(webview_dir / f"webview.darwin-{arch}.node")], check=True)
            subprocess.run([native_codesign, "--force", "--sign", "-", str(bundle)], check=True)
            subprocess.run([native_codesign, "--verify", "--deep", "--strict", str(bundle)], check=True)
        if not (contents / "_CodeSignature" / "CodeResources").is_file():
            raise ValueError("Signing did not produce the bundle resource seal.")
        verify_bundle(bundle)

        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for path in sorted(bundle.rglob("*")):
                if path.is_file():
                    entry(archive, path.relative_to(staging).as_posix(), path.read_bytes(), executable=path == executable)
            entry(archive, "START-HERE.txt", readme.encode("utf-8"))
            entry(archive, "LICENSE.txt", (ROOT / "LICENSE").read_bytes())
    print(f"Built: {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--arch", choices=("arm64", "x64"), required=True)
    parser.add_argument("--rcodesign", type=Path, help="Cross-platform bundle signer (not needed on macOS)")
    args = parser.parse_args()
    package(args.binary, args.output, args.version, args.arch, args.rcodesign)
