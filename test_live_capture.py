"""Deterministic HLS integration checks; no real broadcast is needed."""

import contextlib
import functools
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

import live_capture as live

ROOT = Path(__file__).resolve().parent
FFMPEG = str(ROOT / "ffmpeg.exe")
FFPROBE = str(ROOT / "ffprobe.exe")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class LiveCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="svid-live-test-")
        self.directory = Path(self.temp.name)
        handler = functools.partial(QuietHandler, directory=str(self.directory))
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def make_hls(self, duration=4):
        subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10",
                        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", str(duration),
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-g", "10", "-c:a", "aac",
                        "-f", "hls", "-hls_time", "1", "-hls_list_size", "0", str(self.directory / "live.m3u8")],
                       check=True, **live.hidden_options())

    def capture(self, start_in=0, stop_in=None):
        config = {"url": self.url + "/live.m3u8", "start_at": time.time() + start_in,
                  "stop_at": time.time() + stop_in if stop_in is not None else None,
                  "output_dir": str(self.directory / "output"), "format": "mp4", "stop_file": str(self.directory / "stop")}
        path = self.directory / "config.json"
        path.write_text(json.dumps(config), encoding="utf-8")
        process = subprocess.Popen([sys.executable, "-u", str(ROOT / "live_capture.py"), "--config", str(path), "--ffmpeg", FFMPEG],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, **live.hidden_options())
        self.addCleanup(lambda: self.stop_child(process))
        return process

    @staticmethod
    def stop_child(process):
        if process.poll() is None:
            process.kill()
            process.wait()
        for stream in (process.stdout, process.stderr):
            if stream:
                stream.close()

    def test_nested_hellas_castr_style_player_and_master_playlist(self):
        (self.directory / "index.html").write_text('<iframe src="/player.html"></iframe>')
        (self.directory / "player.html").write_text(f'<script>window.__streamUrl = "{self.url}/master.m3u8?token=a&amp;b=c";</script>')
        (self.directory / "master.m3u8").write_text("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000\nlive.m3u8\n")
        (self.directory / "live.m3u8").write_text("#EXTM3U\n#EXTINF:2,\npiece.ts\n")
        sources = live.page_sources(self.url + "/index.html", {"User-Agent": live.USER_AGENT})
        self.assertEqual(sources[0][0], self.url + "/master.m3u8?token=a&b=c")
        self.assertEqual(sources[0][1]["Referer"], self.url + "/player.html")
        self.assertTrue(live.playable(*sources[0]))
        (self.directory / "live.m3u8").write_text("#EXTM3U\n#EXT-X-TARGETDURATION:2\n")
        self.assertFalse(live.playable(*sources[0]))

    @unittest.skipUnless(Path(FFMPEG).exists(), "FFmpeg is required")
    def test_scheduled_capture_waits_then_saves_valid_mp4_with_audio(self):
        self.make_hls()
        process = self.capture(start_in=2)
        time.sleep(0.5)
        self.assertIsNone(process.poll())
        self.assertFalse((self.directory / "output" / "segments").exists())
        stdout, stderr = process.communicate(timeout=30)
        self.assertEqual(process.returncode, 0, (stdout + stderr).decode())
        self.assertIn(b'"status": "scheduled"', stdout)
        output = self.directory / "output" / "recording.mp4"
        self.assertTrue(output.is_file())
        probe = subprocess.check_output([FFPROBE, "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", str(output)], **live.hidden_options())
        streams = {entry["codec_type"] for entry in json.loads(probe)["streams"]}
        self.assertEqual(streams, {"audio", "video"})
        self.assertTrue(list((self.directory / "output" / "segments").glob("*.ts")))

    def test_stop_before_start_creates_no_empty_video(self):
        process = self.capture(start_in=3600)
        (self.directory / "stop").write_text("stop")
        stdout, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 130, (stdout + stderr).decode())
        self.assertFalse((self.directory / "output").exists())

    def test_offline_stream_stays_in_standby_until_stop_time(self):
        process = self.capture(stop_in=1)
        stdout, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 130, (stdout + stderr).decode())
        self.assertIn(b'"status": "standby"', stdout)
        self.assertFalse((self.directory / "output").exists())


if __name__ == "__main__":
    unittest.main()
