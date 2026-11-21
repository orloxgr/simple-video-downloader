"""Isolated discovery checks: no browser, FFmpeg, network or media recording."""

import json
import ssl
import sys
import unittest
from urllib.error import URLError
from unittest.mock import MagicMock, Mock, patch

import live_capture as live


class LiveHttpsTests(unittest.TestCase):
    def tearDown(self):
        live.https_context.cache_clear()

    def test_native_context_requires_server_certificate_validation(self):
        native = Mock(SSLContext=Mock(return_value=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)))
        with patch.dict(sys.modules, {"truststore": native}):
            context = live.https_context()
        native.SSLContext.assert_called_once_with(ssl.PROTOCOL_TLS_CLIENT)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)

    def test_requests_use_verified_context_and_bounded_reads(self):
        response = Mock(url="https://example.com/final", read=Mock(return_value=b"#EXTM3U"))
        opener = MagicMock()
        opener.return_value.__enter__.return_value = response
        context = object()
        with patch.object(live, "https_context", return_value=context), patch.object(live, "urlopen", opener):
            self.assertEqual(live.request_text("https://example.com/start", {}), ("#EXTM3U", response.url))
        self.assertIs(opener.call_args.kwargs["context"], context)
        response.read.assert_called_once_with(4 * 1024 * 1024)

    def test_invalid_certificates_are_rejected_without_insecure_retry(self):
        error = URLError(ssl.SSLCertVerificationError(1, "certificate has expired"))
        with patch.object(live, "https_context", return_value=object()), \
                patch.object(live, "urlopen", side_effect=error) as opener:
            with self.assertRaisesRegex(URLError, "Certificate verification failed for example.com"):
                live.request_text("https://example.com/private?token=secret", {})
        opener.assert_called_once()


class DiavlosDiscoveryTests(unittest.TestCase):
    page = "https://new.diavlos.grnet.gr/el/epresence-conference/9969"
    stream = "https://diavlos1.cnt.grnet.gr/epresence/example/playlist.m3u8"
    headers = {"User-Agent": live.USER_AGENT}

    def metadata(self, source=None, nid=9969):
        return json.dumps([{"nid": nid, "field_api_event_stream_url": self.stream if source is None else source}])

    def test_recognizes_only_diavlos_conference_pages(self):
        for url in [self.page, "https://diavlos.grnet.gr/en/epresence-conference/9969/",
                    "https://diavlos.grnet.gr/el/embed/conference/9969"]:
            self.assertEqual(live.diavlos_conference_id(url), "9969")
        for url in ["https://diavlos.grnet.gr.example.com/el/epresence-conference/9969",
                    "https://www.hellasnews.tv/", self.stream, "file:///epresence-conference/9969"]:
            self.assertIsNone(live.diavlos_conference_id(url))

    def test_reads_actual_conference_stream_from_public_api_without_opening_page(self):
        with patch.object(live, "request_text", return_value=(self.metadata(), "https://diavlos.grnet.gr/api/epresence-event/9969")) as fetch:
            self.assertEqual(live.page_sources(self.page, self.headers), [
                (self.stream, {**self.headers, "Referer": self.page})])
        fetch.assert_called_once_with("https://diavlos.grnet.gr/api/epresence-event/9969", self.headers)

    def test_decodes_stream_query_and_resolves_relative_api_urls(self):
        with patch.object(live, "request_text", return_value=(self.metadata("/live/playlist.m3u8?a=1&amp;b=2"), "https://diavlos.grnet.gr/api/epresence-event/9969")):
            self.assertEqual(live.page_sources(self.page, self.headers)[0][0], "https://diavlos.grnet.gr/live/playlist.m3u8?a=1&b=2")

    def test_missing_wrong_event_and_placeholder_sources_are_not_broadcasts(self):
        payloads = ["[]", self.metadata(""),
                    self.metadata(nid=9970), self.metadata("file:///private/video.m3u8"),
                    self.metadata("https://user:password@example.com/live.m3u8"),
                    self.metadata("https://diavlos2.cnt.grnet.gr/diavlos-vod/mp4:PrerollVideo4x3_v3.mp4/playlist.m3u8"),
                    self.metadata("https://diavlos2.cnt.grnet.gr/diavlos-vod/mp4:DIAVLOS_NoBroadcastInProgress_4x3_GR_v3.mp4/playlist.m3u8")]
        for payload in payloads:
            with self.subTest(payload=payload), patch.object(live, "request_text", return_value=(payload, self.page)):
                self.assertEqual(live.page_sources(self.page, self.headers), [])

    def test_invalid_metadata_is_an_error_not_an_offline_broadcast(self):
        for payload in ["{}", "null", "<html>Unavailable</html>"]:
            with self.subTest(payload=payload), patch.object(live, "request_text", return_value=(payload, self.page)):
                with self.assertRaisesRegex(ValueError, "conference metadata"):
                    live.page_sources(self.page, self.headers)

    def test_discovery_reports_source_errors_before_retrying(self):
        browser = Mock(page=None)
        control = Mock()
        for error in [OSError("connection failed"), ValueError("invalid conference metadata")]:
            with self.subTest(error=error), \
                    patch.object(live, "page_sources", side_effect=[error, [(self.stream, self.headers)]]), \
                    patch.object(live, "playable", return_value=True), patch.object(live, "event") as report:
                self.assertEqual(live.discover(self.page, control, browser), (self.stream, self.headers))
                messages = [call.args[0] for call in report.call_args_list]
                self.assertTrue(any(str(error) in message and "Retrying automatically" in message for message in messages))
                self.assertFalse(any("offline or has no media" in message for message in messages))
        browser.probe.assert_not_called()

    def test_discovery_reports_playlist_errors_before_retrying(self):
        browser = Mock(page=None)
        control = Mock()
        with patch.object(live, "page_sources", return_value=[(self.stream, self.headers)]), \
                patch.object(live, "playable", side_effect=[OSError("playlist unreachable"), True]), \
                patch.object(live, "event") as report:
            self.assertEqual(live.discover(self.page, control, browser), (self.stream, self.headers))
        self.assertTrue(any("Could not read the live playlist" in call.args[0] for call in report.call_args_list))
        control.wait.assert_called_once_with(15)

    def test_offline_conference_retries_api_without_starting_preroll_browser(self):
        browser = Mock(page=None)
        control = Mock()
        with patch.object(live, "page_sources", side_effect=[[], [(self.stream, self.headers)]]), \
                patch.object(live, "playable", return_value=True), patch.object(live, "event"):
            self.assertEqual(live.discover(self.page, control, browser), (self.stream, self.headers))
        browser.probe.assert_not_called()
        control.wait.assert_called_once_with(15)

    def test_playable_conference_still_requires_a_media_playlist_with_segments(self):
        master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1234\nchunklist.m3u8\n"
        for media, ready in [("#EXTM3U\n#EXT-X-TARGETDURATION:10\n", False),
                             ("#EXTM3U\n#EXTINF:10,\nmedia_1.ts\n", True)]:
            with patch.object(live, "request_text", side_effect=[(master, self.stream), (media, self.stream)]):
                self.assertEqual(live.playable(self.stream, self.headers), ready)

    def test_child_playlist_network_errors_are_not_silently_treated_as_offline(self):
        master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1234\nchunklist.m3u8\n"
        with patch.object(live, "request_text", side_effect=[(master, self.stream), OSError("child unreachable")]):
            with self.assertRaisesRegex(OSError, "child unreachable"):
                live.playable(self.stream, self.headers)


if __name__ == "__main__":
    unittest.main()
