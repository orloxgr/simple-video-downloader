import { deepEqual, equal, ok } from "node:assert/strict";
import {
  macFfmpegRelease,
  platformDownloads,
  platformPaths,
} from "./platform.ts";

Deno.test("Mac uses writable user storage and Movies; Windows paths stay portable", () => {
  deepEqual(
    platformPaths(
      "darwin",
      "/Users/byron",
      "/Applications/Svid.app/Contents/MacOS",
    ),
    {
      appDir: "/Users/byron/Library/Application Support/Svid",
      downloads: "/Users/byron/Downloads",
      videos: "/Users/byron/Movies/Svid",
    },
  );
  equal(
    platformPaths("windows", "C:\\Users\\Byron", "D:\\Svid").appDir,
    "D:\\Svid",
  );
});

Deno.test("Mac tools and update assets match the selected CPU", () => {
  for (const arch of ["aarch64", "x86_64"]) {
    const urls = platformDownloads("darwin", arch);
    ok(urls.uv.endsWith(`uv-${arch}-apple-darwin.tar.gz`));
    ok(urls.deno.endsWith(`deno-${arch}-apple-darwin.zip`));
    ok(urls.ytDlp.endsWith("yt-dlp_macos"));
    equal(
      urls.releaseAsset,
      `Svid-macOS-${arch === "aarch64" ? "arm64" : "x64"}.zip`,
    );
  }
  ok(
    platformDownloads("windows", "x86_64").uv.endsWith(
      "uv-x86_64-pc-windows-msvc.zip",
    ),
  );
});

Deno.test("Mac FFmpeg picks a release for the right CPU, not a nightly build", () => {
  const html =
    '<a href="/download/macos/arm64/123_N-122320/ffmpeg.zip">nightly</a>' +
    '<a href="/download/macos/amd64/456_9.0.2/ffmpeg.zip">Intel</a>' +
    '<a href="/download/macos/arm64/789_9.0.2/ffmpeg.zip">ARM</a>';
  equal(
    macFfmpegRelease(html, "aarch64").ffprobe,
    "https://ffmpeg.martin-riedl.de/download/macos/arm64/789_9.0.2/ffprobe.zip",
  );
  equal(
    macFfmpegRelease(html, "x86_64").ffmpeg,
    "https://ffmpeg.martin-riedl.de/download/macos/amd64/456_9.0.2/ffmpeg.zip",
  );
});
