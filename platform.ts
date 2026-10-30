import { posix, win32 } from "node:path";

export type DesktopOS = "windows" | "darwin";

export function platformPaths(
  os: DesktopOS,
  home: string,
  executableDir: string,
) {
  const path = os === "windows" ? win32 : posix;
  return {
    appDir: os === "darwin"
      ? path.join(home, "Library", "Application Support", "Svid")
      : executableDir,
    downloads: path.join(home, "Downloads"),
    videos: path.join(home, os === "darwin" ? "Movies" : "Videos", "Svid"),
  };
}

export function platformDownloads(os: DesktopOS, arch: string) {
  const target = os === "darwin"
    ? `${arch}-apple-darwin`
    : "x86_64-pc-windows-msvc";
  return {
    ytDlp: `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${
      os === "darwin" ? "yt-dlp_macos" : "yt-dlp.exe"
    }`,
    deno:
      `https://github.com/denoland/deno/releases/latest/download/deno-${target}.zip`,
    uv:
      `https://github.com/astral-sh/uv/releases/latest/download/uv-${target}.${
        os === "darwin" ? "tar.gz" : "zip"
      }`,
    releaseAsset: os === "darwin"
      ? `Svid-macOS-${arch === "aarch64" ? "arm64" : "x64"}.zip`
      : "Svid-Setup.exe",
  };
}

export function macFfmpegRelease(page: string, arch: string) {
  const directory = arch === "aarch64" ? "arm64" : "amd64";
  const match = page.match(
    new RegExp(
      `(?:https://ffmpeg\\.martin-riedl\\.de)?(/download/macos/${directory}/\\d+_(\\d+\\.\\d+(?:\\.\\d+)?)/)ffmpeg\\.zip`,
    ),
  );
  if (!match) {
    throw new Error(`Could not find the macOS ${directory} FFmpeg release.`);
  }
  const base = `https://ffmpeg.martin-riedl.de${match[1]}`;
  return {
    version: match[2],
    ffmpeg: `${base}ffmpeg.zip`,
    ffprobe: `${base}ffprobe.zip`,
  };
}
