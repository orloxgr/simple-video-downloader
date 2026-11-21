"""Svid live capture, adapted from the Diavlos AutoCapture workflow.

Discover HLS in an event page (including nested players), keep recoverable TS
parts, and join/remux them on stop. The desktop backend owns the schedule.
Only public, unprotected HLS streams are handled; player access checks remain.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import time
from http.client import IncompleteRead
from functools import lru_cache
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen
from urllib.error import URLError

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"
NETWORK_ERRORS = (OSError, TimeoutError, IncompleteRead)
HLS_PATTERN = re.compile(r"(?:https?:)?//[^\s\"'<>]+?\.m3u8(?:\?[^\s\"'<>]*)?", re.I)


class StopRequested(Exception):
    pass


def event(message: str, status: str | None = None, output: str | None = None) -> None:
    payload = {"message": message}
    if status:
        payload["status"] = status
    if output:
        payload["output"] = output
    print("SVID_LIVE " + json.dumps(payload, ensure_ascii=True), flush=True)


class Control:
    def __init__(self, config: dict):
        self.stop_file = Path(config["stop_file"])
        self.stop_at = config.get("stop_at")

    def stopped(self) -> bool:
        return self.stop_file.exists() or (self.stop_at is not None and time.time() >= self.stop_at)

    def check(self) -> None:
        if self.stopped():
            raise StopRequested

    def wait(self, seconds: float) -> None:
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            self.check()
            time.sleep(min(0.2, max(0, until - time.monotonic())))
        self.check()


@lru_cache(maxsize=1)
def https_context() -> ssl.SSLContext:
    import truststore

    # Use native certificate chain validation, not OpenSSL's flattened Windows
    # root store, which can select expired alternative certificate chains.
    return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)


def request_text(url: str, headers: dict[str, str]) -> tuple[str, str]:
    try:
        with urlopen(Request(url, headers=headers), timeout=15, context=https_context()) as response:
            data = response.read(4 * 1024 * 1024)
            return data.decode("utf-8-sig", errors="replace"), response.url
    except URLError as error:
        if isinstance(error.reason, ssl.SSLCertVerificationError):
            host = urlparse(url).hostname
            raise URLError(f"Certificate verification failed for {host}: {error.reason}") from error
        raise


def diavlos_conference_id(page_url: str) -> str | None:
    parsed = urlparse(page_url)
    if parsed.scheme not in ("http", "https") or parsed.hostname not in ("diavlos.grnet.gr", "new.diavlos.grnet.gr"):
        return None
    match = re.search(r"/(?:epresence-conference|embed/conference)/(\d+)/?$", parsed.path)
    return match.group(1) if match else None


def diavlos_sources(page_url: str, headers: dict[str, str]) -> list[tuple[str, dict[str, str]]] | None:
    conference_id = diavlos_conference_id(page_url)
    if conference_id is None:
        return None
    # The Angular page starts with a preroll and also has a footer player. Only
    # the conference API identifies the actual broadcast, including while offline.
    api_url = f"https://diavlos.grnet.gr/api/epresence-event/{conference_id}"
    text, final_url = request_text(api_url, headers)
    try:
        entries = json.loads(text)
    except ValueError as error:
        raise ValueError("Diavlos returned invalid conference metadata instead of JSON.") from error
    if not isinstance(entries, list):
        raise ValueError("Diavlos returned an unexpected conference metadata format.")
    for entry in entries:
        if not isinstance(entry, dict) or str(entry.get("nid", "")) != conference_id:
            continue
        source = entry.get("field_api_event_stream_url")
        if not isinstance(source, str) or not source.strip():
            continue
        try:
            media_url = urljoin(final_url, html.unescape(source.strip()))
            parsed = urlparse(media_url)
        except ValueError:
            continue
        if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
            continue
        if any(name in parsed.path.lower() for name in ("prerollvideo", "nobroadcastinprogress")):
            continue
        return [(media_url, {"User-Agent": headers.get("User-Agent", USER_AGENT), "Referer": page_url})]
    return []


def page_sources(page_url: str, headers: dict[str, str], seen: set[str] | None = None) -> list[tuple[str, dict[str, str]]]:
    """Fast path for Hellas News -> Castr and players with inline HLS config."""
    seen = seen if seen is not None else set()
    if page_url in seen or len(seen) >= 8:
        return []
    seen.add(page_url)
    conference_sources = diavlos_sources(page_url, headers)
    if conference_sources is not None:
        return conference_sources
    text, final_url = request_text(page_url, headers)
    if text.lstrip().startswith("#EXTM3U"):
        return [(final_url, headers)]
    decoded = html.unescape(text).replace(r"\/", "/").replace(r"\u0026", "&")
    forwarded = {"User-Agent": USER_AGENT, "Referer": final_url}
    sources = [(urljoin(final_url, match.group()), forwarded) for match in HLS_PATTERN.finditer(decoded)]
    for match in re.finditer(r"<iframe\b[^>]*\bsrc\s*=\s*([\"'])(.*?)\1", decoded, re.I | re.S):
        frame_url = urljoin(final_url, match.group(2))
        if urlparse(frame_url).scheme not in ("http", "https"):
            continue
        try:
            sources.extend(page_sources(frame_url, forwarded, seen))
        except NETWORK_ERRORS:
            continue
    return list({url: (url, item_headers) for url, item_headers in sources}.values())


def playable(url: str, headers: dict[str, str], depth: int = 0) -> bool:
    """Do not start recording until an actual media playlist has segments."""
    if depth > 4:
        return False
    text, final_url = request_text(url, headers)
    if not text.lstrip().startswith("#EXTM3U"):
        return False
    if "#EXTINF:" in text:
        return True
    # Probe the highest bandwidth variant; FFmpeg keeps alternate audio renditions.
    variants = []
    last_error = None
    lines = [line.strip() for line in text.splitlines()]
    for index, line in enumerate(lines[:-1]):
        if line.startswith("#EXT-X-STREAM-INF:"):
            bandwidth = re.search(r"(?:^|[:,])BANDWIDTH=(\d+)", line)
            child = next((entry for entry in lines[index + 1:] if entry and not entry.startswith("#")), None)
            if child:
                variants.append((int(bandwidth.group(1)) if bandwidth else 0, urljoin(final_url, child)))
    for _, child in sorted(variants, reverse=True):
        try:
            if playable(child, headers, depth + 1):
                return True
        except NETWORK_ERRORS as error:
            last_error = error
            continue
    if last_error is not None:
        raise last_error
    return False


def hidden_options() -> dict:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


class BrowserDiscovery:
    def __init__(self, url: str, control: Control):
        self.url = url
        self.control = control
        self.playwright = None
        self.browser = None
        self.context = None
        self.page = None
        self.sources: dict[str, dict[str, str]] = {}

    def start(self) -> None:
        from playwright.sync_api import sync_playwright

        self.control.check()
        self.playwright = sync_playwright().start()
        options = {"headless": True, "args": ["--autoplay-policy=no-user-gesture-required"]}
        # Prefer Windows Edge there; other platforms use headless Chromium.
        for channel in (("msedge", None) if os.name == "nt" else (None,)):
            try:
                self.browser = self.playwright.chromium.launch(**options, **({"channel": channel} if channel else {}))
                break
            except Exception:
                self.control.check()
        if self.browser is None:
            event("Downloading the hidden Chromium browser for live discovery...", "preparing")
            with subprocess.Popen([sys.executable, "-m", "playwright", "install", "chromium", "--only-shell"], **hidden_options()) as installer:
                try:
                    while installer.poll() is None:
                        self.control.wait(0.2)
                except StopRequested:
                    installer.terminate()
                    installer.wait(timeout=15)
                    raise
                if installer.returncode != 0:
                    raise RuntimeError("Could not install Chromium. Check the internet connection and try again.")
            self.browser = self.playwright.chromium.launch(**options)
        self.context = self.browser.new_context(user_agent=USER_AGENT)

        def on_request(request):
            if re.search(r"\.m3u8(?:\?|$)", request.url, re.I):
                try:
                    raw = request.all_headers()
                except Exception:
                    raw = {}
                self.sources[request.url] = {"User-Agent": raw.get("user-agent", USER_AGENT)}
                for source, target in (("referer", "Referer"), ("origin", "Origin"), ("cookie", "Cookie")):
                    if raw.get(source):
                        self.sources[request.url][target] = raw[source]

        self.context.on("request", on_request)
        self.page = self.context.new_page()
        self.navigate()

    def navigate(self) -> None:
        try:
            self.page.goto(self.url, wait_until="domcontentloaded", timeout=15000)
        except Exception:
            self.control.check()

    def probe(self, reload: bool) -> list[tuple[str, dict[str, str]]]:
        if self.page is None:
            self.start()
        elif reload:
            self.sources.clear()
            self.navigate()
        for frame in self.page.frames:
            self.control.check()
            try:
                frame.evaluate("""() => {
                    const button = document.querySelector('.vjs-big-play-button, .bmpui-ui-hugeplaybacktogglebutton, button[aria-label*=Play]');
                    if (button) button.click();
                    for (const video of document.querySelectorAll('video')) {
                        video.muted = true;
                        video.play().catch(() => {});
                    }
                }""")
            except Exception:
                pass
        self.page.wait_for_timeout(1000)
        self.control.check()
        return list(self.sources.items())

    def close(self) -> None:
        for obj in (self.context, self.browser):
            if obj:
                try:
                    obj.close()
                except Exception:
                    pass
        if self.playwright:
            self.playwright.stop()
        self.context = self.browser = self.page = self.playwright = None


def discover(url: str, control: Control, browser: BrowserDiscovery, max_wait: float | None = None) -> tuple[str, dict[str, str]]:
    conference_id = diavlos_conference_id(url)
    message = (f"Stand by: checking the actual live source for Diavlos conference {conference_id}."
               if conference_id else "Stand by: checking for the live stream. Offline streams are retried automatically.")
    event(message, "standby")
    started = time.monotonic()
    attempt = 0
    last_issue = None
    while max_wait is None or time.monotonic() - started < max_wait:
        control.check()
        attempt += 1
        candidates = []
        issue = None
        try:
            candidates = page_sources(url, {"User-Agent": USER_AGENT})
        except (*NETWORK_ERRORS, ValueError) as error:
            issue = f"Could not check the live source ({type(error).__name__}): {error}. Retrying automatically."
        # Never fall back to Diavlos' preroll/offline/footer players while the
        # conference itself is offline. Retry its API and actual HLS instead.
        if not candidates and conference_id is None and not urlparse(url).path.lower().endswith(".m3u8"):
            candidates = browser.probe(reload=attempt > 1)
        for playlist, headers in candidates:
            control.check()
            try:
                if playable(playlist, headers):
                    return playlist, headers
            except NETWORK_ERRORS as error:
                issue = f"Could not read the live playlist ({type(error).__name__}): {error}. Retrying automatically."
                continue
        if issue and (issue != last_issue or attempt % 20 == 0):
            event(issue, "standby")
        elif not issue and (attempt == 1 or last_issue or attempt % 20 == 0):
            event("The stream is offline or has no media yet; still standing by.", "standby")
        last_issue = issue
        control.wait(3 if browser.page else 15)
    raise TimeoutError("The live stream did not return after the connection was lost.")


def stop_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    try:
        process.stdin.write(b"q\n")
        process.stdin.flush()
    except (OSError, ValueError):
        pass
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def record(playlist: str, headers: dict[str, str], segment_dir: Path, ffmpeg: str, control: Control) -> tuple[int, bool]:
    files = sorted(segment_dir.glob("*.ts"))
    first = int(files[-1].stem) + 1 if files else 0
    args = [ffmpeg, "-hide_banner", "-loglevel", "warning", "-y", "-rw_timeout", "15000000",
            "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
            "-user_agent", headers.get("User-Agent", USER_AGENT)]
    forwarded = "".join(f"{key}: {value}\r\n" for key, value in headers.items()
                        if key.lower() in ("referer", "origin", "cookie") and "\r" not in value and "\n" not in value)
    if forwarded:
        args += ["-headers", forwarded]
    args += ["-i", playlist, "-sn", "-dn", "-c", "copy",
             "-f", "segment", "-segment_format", "mpegts", "-segment_time", "10",
             "-reset_timestamps", "1", "-segment_start_number", str(first), str(segment_dir / "%09d.ts")]
    before = len(files)
    reported = False
    stalled = False
    last_size = -1
    last_data = time.monotonic()
    last_progress = 0.0
    # File output avoids pipe deadlock and preserves diagnostic details on failure.
    with (segment_dir.parent / "ffmpeg-capture.log").open("ab") as diagnostic:
        process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=diagnostic, **hidden_options())
        try:
            while process.poll() is None:
                control.check()
                parts = sorted(segment_dir.glob("*.ts"))
                if len(parts) > before:
                    latest_size = parts[-1].stat().st_size
                    marker = (len(parts), latest_size)
                    if marker != last_size:
                        last_size = marker
                        last_data = time.monotonic()
                    if latest_size > 0:
                        if not reported:
                            event("Live stream found. Recording and keeping recoverable TS parts...", "recording")
                            reported = True
                        if time.monotonic() - last_progress > 30:
                            event(f"Recording: {len(parts)} parts saved.", "recording")
                            last_progress = time.monotonic()
                if time.monotonic() - last_data >= 60:
                    stalled = True
                    event("No new media for 60 seconds. Rechecking the live source...", "standby")
                    break
                control.wait(0.3)
        finally:
            stop_process(process)
    return (1 if stalled else process.returncode), reported


def combine(segment_dir: Path, output_dir: Path, output_format: str, ffmpeg: str) -> Path | None:
    files = [path for path in sorted(segment_dir.glob("*.ts")) if path.stat().st_size > 0]
    if not files:
        return None
    event(f"Saving {len(files)} recorded parts...", "stopping")
    # All concat entries are numeric filenames generated by us, relative to the manifest.
    manifest = segment_dir / "concat.txt"
    manifest.write_text("".join(f"file '{path.name}'\n" for path in files), encoding="utf-8")
    output = output_dir / f"recording.{output_format}"
    partial = output_dir / f"recording.partial.{output_format}"
    args = [ffmpeg, "-hide_banner", "-loglevel", "warning", "-nostdin", "-y", "-fflags", "+genpts",
            "-f", "concat", "-safe", "1", "-i", str(manifest), "-map", "0", "-c", "copy"]
    if output_format == "mp4":
        args += ["-movflags", "+faststart"]
    with (output_dir / "ffmpeg-join.log").open("wb") as diagnostic:
        result = subprocess.run(args + [str(partial)], stdout=subprocess.DEVNULL, stderr=diagnostic, **hidden_options())
    if result.returncode == 0 and partial.exists() and partial.stat().st_size > 0:
        partial.replace(output)
        return output
    # Even unsupported MP4 codecs leave a usable joined TS and all original parts.
    fallback = output_dir / "recording.ts"
    with fallback.open("wb") as destination:
        for path in files:
            with path.open("rb") as source:
                shutil.copyfileobj(source, destination, length=1024 * 1024)
    event("Remux failed; saved a joined TS instead. Original parts and FFmpeg diagnostics are kept.")
    return fallback


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--ffmpeg", required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    control = Control(config)
    output_dir = Path(config["output_dir"])
    segment_dir = output_dir / "segments"
    browser = BrowserDiscovery(config["url"], control)
    failed = False
    try:
        control.check()
        start_at = config["start_at"]
        if time.time() < start_at:
            event("Scheduled. Waiting until " + time.strftime("%d/%m/%Y %H:%M:%S %Z", time.localtime(start_at)), "scheduled")
            while time.time() < start_at:
                control.wait(min(1, start_at - time.time()))
        playlist, headers = discover(config["url"], control, browser)
        segment_dir.mkdir(parents=True, exist_ok=True)
        while True:
            control.check()
            code, recorded = record(playlist, headers, segment_dir, args.ffmpeg, control)
            if code == 0 and any(path.stat().st_size for path in segment_dir.glob("*.ts")):
                event("The live stream ended.")
                break
            event("Connection lost or stream not ready. Checking for a fresh live URL...", "standby")
            playlist, headers = discover(config["url"], control, browser, max_wait=60 if recorded else None)
    except StopRequested:
        event("Stop requested. Saving everything recorded so far...", "stopping")
    except Exception as error:
        failed = True
        event(f"Live capture error: {error}")
    finally:
        browser.close()
    output = combine(segment_dir, output_dir, config["format"], args.ffmpeg) if segment_dir.exists() else None
    if output:
        event(f"Video saved: {output}", output=str(output))
        return 0
    return 1 if failed else 130


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        event(f"ERROR: {error}. Saved recording parts have been kept.")
        raise SystemExit(1)
