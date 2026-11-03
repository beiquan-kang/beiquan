"""输入模块的逐项测试，外部网络调用均隔离。"""

import importlib
import json
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch
from unittest.mock import MagicMock
import uuid
import wave


ROOT = Path(__file__).resolve().parents[1]


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.job = ROOT / ".cache" / "media-tests" / uuid.uuid4().hex
        self.job.mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.job)

    def module(self):
        try:
            return importlib.import_module("scripts.media")
        except ModuleNotFoundError:
            self.fail("尚未实现 scripts.media 输入模块。")

    def wav(self, name="声音.wav"):
        path = self.job / name
        with wave.open(str(path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(16000)
            output.writeframes(b"\x00\x00" * 16000)
        return path

    def test_rejects_unsafe_remote_addresses_before_any_io(self):
        media = self.module()
        urls = (
            "ftp://example.com/a.mp3",
            "https://user:secret@example.com/a.mp3",
            "http://localhost/a",
            "http://127.0.0.1/a",
            "http://[::1]/a",
            "http://192.168.1.1/a",
            "http://169.254.169.254/a",
            "http://2130706433/a",
            "http://0x7f000001/a",
            "http://printer.local/a",
        )
        for url in urls:
            with self.subTest(url=url), patch("scripts.media.subprocess.run") as run:
                with self.assertRaisesRegex(media.MediaError, "地址|协议|凭据"):
                    media.resolve_input(url, self.job)
                run.assert_not_called()

    def response(self, body, status=200, headers=None):
        response = MagicMock()
        response.status_code = status
        response.headers = headers or {}
        response.iter_content.return_value = iter([body])
        response.__enter__.return_value = response
        return response

    def test_direct_http_download_is_probed_without_leaking_query(self):
        media = self.module()
        source = "https://example.com/sample.wav?token=secret#secret"
        response = self.response(self.wav().read_bytes())
        with patch("requests.Session.get", return_value=response) as get:
            result = media.resolve_input(source, self.job)
        self.assertEqual(result["source"], source)
        self.assertEqual(result["platform"], "direct")
        self.assertAlmostEqual(result["duration"], 1.0)
        self.assertTrue(result["path"].is_relative_to(self.job))
        self.assertEqual(result["title"], "sample")
        self.assertNotIn("secret", media.display_source(source))
        self.assertTrue(get.call_args.kwargs["stream"])
        self.assertFalse(get.call_args.kwargs["allow_redirects"])
        self.assertIn("timeout", get.call_args.kwargs)

    def test_download_uses_system_proxy_without_loading_netrc(self):
        media = self.module()
        proxies = {"https": "http://127.0.0.1:7890"}
        seen = []
        body = self.wav().read_bytes()

        def get(session, url, **kwargs):
            seen.append((session.trust_env, kwargs.get("proxies")))
            return self.response(body)

        with (
            patch("requests.utils.get_environ_proxies", return_value=proxies),
            patch("requests.Session.get", autospec=True, side_effect=get),
        ):
            media.resolve_input("https://example.com/sample.wav", self.job)
        self.assertEqual(seen, [(False, proxies)])

    def test_googlevideo_download_joins_verified_byte_ranges(self):
        media = self.module()
        replies = [
            self.response(b"abc", status=206, headers={"Content-Range": "bytes 0-2/6", "Content-Length": "3"}),
            self.response(b"def", status=206, headers={"Content-Range": "bytes 3-5/6", "Content-Length": "3"}),
        ]
        with (
            patch.object(media, "HTTP_RANGE_BYTES", 3, create=True),
            patch("requests.Session.get", side_effect=replies) as get,
        ):
            output = media._download("https://rr1.googlevideo.com/videoplayback", self.job)
        self.assertEqual(output.read_bytes(), b"abcdef")
        self.assertEqual([c.kwargs["headers"]["Range"] for c in get.call_args_list], ["bytes=0-2", "bytes=3-5"])

    def test_googlevideo_invalid_ranges_remove_partial_download(self):
        media = self.module()
        cases = [
            [self.response(b"abc", status=200)],
            [self.response(b"abc", status=206, headers={"Content-Range": "bad"})],
            [self.response(b"abc", status=206, headers={"Content-Range": "bytes 1-3/6"})],
            [self.response(b"ab", status=206, headers={"Content-Range": "bytes 0-2/3"})],
            [self.response(b"abcd", status=206, headers={"Content-Range": "bytes 0-2/3"})],
            [self.response(b"abc", status=206, headers={"Content-Range": "bytes 0-2/3", "Content-Length": "4"})],
            [self.response(b"abc", status=206, headers={"Content-Range": "bytes 0-2/3", "Content-Encoding": "gzip"})],
            [
                self.response(b"abc", status=206, headers={"Content-Range": "bytes 0-2/6"}),
                self.response(b"def", status=206, headers={"Content-Range": "bytes 3-5/7"}),
            ],
        ]
        for replies in cases:
            before = set(self.job.iterdir())
            with (
                self.subTest(responses=len(replies), headers=replies[-1].headers),
                patch.object(media, "HTTP_RANGE_BYTES", 3),
                patch("requests.Session.get", side_effect=replies),
            ):
                with self.assertRaises(media.MediaError):
                    media._download("https://rr1.googlevideo.com/videoplayback", self.job)
            self.assertEqual(set(self.job.iterdir()), before)

    def test_display_source_preserves_identity_parameters(self):
        media = self.module()
        url = "https://www.youtube.com:443/watch?v=jNQXAC9IVRw&p=2&token=secret#private"
        shown = media.display_source(url)
        self.assertIn("v=jNQXAC9IVRw", shown)
        self.assertIn("p=2", shown)
        self.assertIn(":443", shown)
        self.assertNotIn("secret", shown)
        self.assertNotIn("private", shown)

    def test_http_error_is_rejected_before_writing_even_if_body_is_audio(self):
        media = self.module()
        response = self.response(self.wav().read_bytes(), status=403)
        with patch("requests.Session.get", return_value=response):
            with self.assertRaisesRegex(media.MediaError, "HTTP.*403"):
                media.resolve_input("https://example.com/sample.wav?token=secret", self.job)

    def test_download_size_limit_checks_headers_and_stream_and_cleans_partial(self):
        media = self.module()
        data = self.wav().read_bytes()
        for headers in ({"Content-Length": "100"}, {}):
            response = self.response(data, headers=headers)
            before = set(self.job.iterdir())
            with (
                self.subTest(headers=headers),
                patch("requests.Session.get", return_value=response),
                patch.object(media, "MAX_BYTES", 10, create=True),
            ):
                with self.assertRaisesRegex(media.MediaError, "大小|上限"):
                    media.resolve_input("https://example.com/a.wav", self.job)
            self.assertEqual(set(self.job.iterdir()), before)

    def test_redirects_are_validated_on_every_hop(self):
        media = self.module()
        audio = self.wav().read_bytes()
        safe = self.response(b"", status=302, headers={"Location": "https://cdn.example.com/a.wav"})
        with patch("requests.Session.get", side_effect=[safe, self.response(audio)]) as get:
            self.assertEqual(media.resolve_input("https://example.com/a.wav", self.job)["duration"], 1.0)
            self.assertEqual(get.call_count, 2)
        unsafe = self.response(b"", status=302, headers={"Location": "http://127.0.0.1/private"})
        with patch("requests.Session.get", return_value=unsafe) as get:
            with self.assertRaisesRegex(media.MediaError, "地址"):
                media.resolve_input("https://example.com/a.wav", self.job)
            self.assertEqual(get.call_count, 1)

    def test_broken_downloads_fail_cleanly_without_secrets_or_partial_files(self):
        media = self.module()
        import requests

        for response in (
            self.response(b""),
            self.response(b"abc", headers={"Content-Length": "99"}),
            requests.Timeout("https://example.com/a?secret=token"),
        ):
            before = set(self.job.iterdir())
            kwargs = (
                {"side_effect": response} if isinstance(response, Exception) else {"return_value": response}
            )
            with self.subTest(response=type(response).__name__), patch("requests.Session.get", **kwargs):
                with self.assertRaises(media.MediaError) as error:
                    media.resolve_input("https://example.com/a.wav", self.job)
                self.assertNotIn("secret", str(error.exception))
            self.assertEqual(before, set(self.job.iterdir()))

    def test_xiaoyuzhou_next_data_downloads_full_episode(self):
        media = self.module()
        episode = {
            "title": "测试播客",
            "duration": 1,
            "media": {"source": {"url": "https://cdn.example.com/audio.wav"}},
        }
        page = (
            '<script>throw Error("不可执行");</script><script type="application/json" id="__NEXT_DATA__">'
            + json.dumps({"props": {"pageProps": {"episode": episode}}})
            + "</script>"
        )
        responses = [self.response(page.encode()), self.response(self.wav().read_bytes())]
        with patch("requests.Session.get", side_effect=responses):
            result = media.resolve_input("https://www.xiaoyuzhoufm.com/episode/abc123", self.job)
        self.assertEqual(result["title"], "测试播客")
        self.assertEqual(result["platform"], "xiaoyuzhou")
        self.assertEqual(result["duration"], 1.0)

    def test_ximalaya_free_complete_track_downloads(self):
        media = self.module()
        responses = [
            self.response(
                json.dumps(
                    {
                        "ret": 200,
                        "data": {
                            "src": "https://cdn.example.com/a.wav",
                            "canPlay": True,
                            "albumIsSample": False,
                        },
                    }
                ).encode()
            ),
            self.response(
                json.dumps(
                    {"ret": 200, "data": {"trackInfo": {"title": "免费节目", "duration": 1, "isPaid": False}}}
                ).encode()
            ),
            self.response(self.wav().read_bytes()),
        ]
        with patch("requests.Session.get", side_effect=responses):
            result = media.resolve_input("https://www.ximalaya.com/sound/123456", self.job)
        self.assertEqual(result["platform"], "ximalaya")
        self.assertEqual(result["title"], "免费节目")
        self.assertEqual(result["duration"], 1.0)

    def test_ximalaya_rejects_paid_trial_and_shortened_audio(self):
        media = self.module()
        cases = [("canPlay", False), ("albumIsSample", True), ("isPaid", True), ("duration", 100)]
        for key, value in cases:
            audio = {"src": "https://cdn.example.com/a.wav", "canPlay": True, "albumIsSample": False}
            track = {"title": "节目", "duration": 1, "isPaid": False}
            (audio if key in audio else track)[key] = value
            responses = [
                self.response(json.dumps({"ret": 200, "data": audio}).encode()),
                self.response(json.dumps({"ret": 200, "data": {"trackInfo": track}}).encode()),
                self.response(self.wav().read_bytes()),
            ]
            with self.subTest(key=key), patch("requests.Session.get", side_effect=responses):
                with self.assertRaisesRegex(media.MediaError, "完整|付费|试听"):
                    media.resolve_input("https://www.ximalaya.com/sound/123456", self.job)

    def test_bilibili_public_api_downloads_when_video_webpage_is_blocked(self):
        media = self.module()
        source = "https://www.bilibili.com/video/BV1XNtJ6UEmm/"
        meta = {"code": 0, "data": {
            "bvid": "BV1XNtJ6UEmm", "title": "公开视频", "duration": 1,
            "pages": [{"page": 1, "cid": 123, "duration": 1}], "rights": {"pay": 0},
        }}
        play = {"code": 0, "data": {"timelength": 1000, "dash": {"audio": [
            {"baseUrl": "https://cdn.example.com/a.wav", "bandwidth": 128000},
        ]}}}
        responses = [self.response(b"<html>homepage</html>"),
                     self.response(json.dumps(meta).encode()),
                     self.response(json.dumps(play).encode()),
                     self.response(self.wav().read_bytes())]
        with (
            patch.object(media, "_ytdlp", side_effect=media.MediaError("网页 HTTP 412")) as ytdlp,
            patch("requests.Session.get", side_effect=responses) as get,
        ):
            result = media.resolve_input(source, self.job)
        self.assertEqual(result["platform"], "bilibili")
        self.assertEqual(result["title"], "公开视频")
        self.assertEqual(result["duration"], 1.0)
        self.assertEqual(result["source"], source)
        ytdlp.assert_not_called()
        requested = [c.args[0] for c in get.call_args_list]
        self.assertFalse(any("/video/" in url for url in requested))
        self.assertTrue(any("/x/web-interface/view?" in url for url in requested))
        self.assertTrue(any("/x/player/playurl?" in url for url in requested))

    def test_bilibili_rejects_restricted_or_preview_media(self):
        media = self.module()
        changes = [
            ("meta", {"rights": {"pay": 1}}),
            ("meta", {"rights": {"ugc_pay": 1}}),
            ("meta", {"rights": {"arc_pay": 1}}),
            ("meta", {"is_upower_exclusive": True}),
            ("meta", {"rights": {"is_stein_gate": 1}}),
            ("meta", {"redirect_url": "https://www.bilibili.com/bangumi/play/ep1"}),
            ("play", {"is_preview": True}),
            ("play", {"is_trial": True}),
            ("play", {"has_drm": True}),
        ]
        for target, change in changes:
            meta = {"bvid": "BV1XNtJ6UEmm", "title": "节目", "duration": 1,
                    "pages": [{"page": 1, "cid": 123, "duration": 1}], "rights": {"pay": 0}}
            play = {"timelength": 1000, "dash": {"audio": [
                {"baseUrl": "https://cdn.example.com/a.wav", "bandwidth": 128000}]}}
            (meta if target == "meta" else play).update(change)
            responses = [self.response(b"home"),
                         self.response(json.dumps({"code": 0, "data": meta}).encode()),
                         self.response(json.dumps({"code": 0, "data": play}).encode()),
                         self.response(self.wav().read_bytes())]
            with self.subTest(target=target, change=change), patch("requests.Session.get", side_effect=responses):
                with self.assertRaisesRegex(media.MediaError, "付费|试听|DRM|交互|跳转"):
                    media.resolve_input("https://www.bilibili.com/video/BV1XNtJ6UEmm/", self.job)

    def test_bilibili_validates_identifiers_before_network_access(self):
        media = self.module()
        urls = [
            "https://www.bilibili.com/video/BVshort/",
            "https://www.bilibili.com/video/BV1XNtJ6UEmm/?p=0",
            "https://www.bilibili.com/video/BV1XNtJ6UEmm/?p=abc",
            "https://www.bilibili.com/video/BV1XNtJ6UEmm/?p=1&p=2",
        ]
        for url in urls:
            with self.subTest(url=url), patch("requests.Session.get") as get:
                with self.assertRaisesRegex(media.MediaError, "格式"):
                    media.resolve_input(url, self.job)
                get.assert_not_called()

    def test_bilibili_rejects_invalid_api_and_incomplete_media(self):
        media = self.module()
        cases = ("http412", "api_refusal", "different_bvid", "short_playback", "empty_audio", "private_url")
        for case in cases:
            meta = {"bvid": "BV1XNtJ6UEmm", "title": "节目", "pages": [
                {"page": 1, "cid": 123, "duration": 100}], "rights": {}}
            play = {"timelength": 100000, "dash": {"audio": [
                {"baseUrl": "https://cdn.example.com/a.wav", "bandwidth": 128000}]}}
            if case == "different_bvid":
                meta["bvid"] = "BV13x41117TL"
            if case == "short_playback":
                play["timelength"] = 1000
            if case == "empty_audio":
                play["dash"]["audio"] = []
            if case == "private_url":
                play["dash"]["audio"][0]["baseUrl"] = "http://127.0.0.1/private"
            responses = [self.response(b"home"), self.response(json.dumps({
                "code": -412 if case == "api_refusal" else 0, "data": meta,
            }).encode(), status=412 if case == "http412" else 200),
                self.response(json.dumps({"code": 0, "data": play}).encode())]
            with self.subTest(case=case), patch("requests.Session.get", side_effect=responses):
                with self.assertRaises(media.MediaError):
                    media.resolve_input("https://www.bilibili.com/video/BV1XNtJ6UEmm/", self.job)

    def test_bilibili_preserves_selected_page_and_explicit_cookie(self):
        media = self.module()
        cookie = self.job / "bilibili.cookies"
        cookie.write_text("# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t2147483647\ttest_session\ttest_fixture\n", encoding="utf-8")
        meta = {"bvid": "BV1XNtJ6UEmm", "title": "节目", "rights": {}, "pages": [
            {"page": 1, "cid": 123, "duration": 100},
            {"page": 2, "cid": 456, "duration": 1, "part": "第二部分"}]}
        play = {"timelength": 1000, "dash": {"audio": [
            {"baseUrl": "https://cdn.example.com/a.wav", "bandwidth": 128000}]}}
        responses = iter([self.response(b"home"),
                          self.response(json.dumps({"code": 0, "data": meta}).encode()),
                          self.response(json.dumps({"code": 0, "data": play}).encode()),
                          self.response(self.wav().read_bytes())])
        seen = []

        def get(session, url, **kwargs):
            seen.append((url, dict(session.cookies)))
            return next(responses)

        with patch("requests.Session.get", autospec=True, side_effect=get):
            result = media.resolve_input("https://www.bilibili.com/video/BV1XNtJ6UEmm/?p=2", self.job,
                                         cookies_file=str(cookie))
        self.assertEqual(result["title"], "节目 p02 第二部分")
        self.assertIn("cid=456", seen[2][0])
        self.assertTrue(all(cookies.get("test_session") == "test_fixture" for _, cookies in seen))

    def test_ytdlp_single_item_prefers_audio_and_disables_unsafe_features(self):
        media = self.module()
        info = {
            "_type": "video",
            "title": "公开视频",
            "extractor_key": "Youtube",
            "url": "https://cdn.example.com/a.wav",
            "duration": 1,
            "protocol": "https",
        }
        actual_run = subprocess.run
        commands = []

        def run(command, **kwargs):
            if "yt_dlp" in command:
                commands.append((command, kwargs))
                return subprocess.CompletedProcess(command, 0, json.dumps(info), "")
            return actual_run(command, **kwargs)

        with (
            patch("scripts.media.subprocess.run", side_effect=run),
            patch("requests.Session.get", return_value=self.response(self.wav().read_bytes())),
        ):
            result = media.resolve_input("https://www.youtube.com/watch?v=example", self.job)
        self.assertEqual(result["title"], "公开视频")
        self.assertEqual(result["platform"], "youtube")
        self.assertEqual(len(commands), 1)
        command, kwargs = commands[0]
        for flag in (
            "--ignore-config",
            "--no-plugin-dirs",
            "--no-exec",
            "--no-js-runtimes",
            "--no-remote-components",
            "--no-playlist",
            "--no-cache-dir",
            "--skip-download",
        ):
            self.assertIn(flag, command)
        self.assertNotIn("--cookies-from-browser", command)
        self.assertNotIn("--cookies", command)
        self.assertIn("bestaudio", command[command.index("--format") + 1])
        self.assertFalse(kwargs.get("shell", False))
        self.assertLessEqual(kwargs["timeout"], 180)
        self.assertTrue(Path(kwargs["env"]["TEMP"]).is_relative_to(self.job))

    def test_youtube_enables_installed_node_with_local_solver(self):
        media = self.module()
        info = {"title": "节目", "url": "https://cdn.example.com/a.wav", "protocol": "https"}
        node = "C:/tools/node.exe"
        with (
            patch("scripts.media.shutil.which", return_value=node),
            patch("scripts.media.subprocess.run") as run,
        ):
            run.return_value.stdout = json.dumps(info)
            media._ytdlp("https://www.youtube.com/watch?v=KwpuAfVKNQI", self.job, "ffmpeg", None)
        command = run.call_args.args[0]
        self.assertIn("--js-runtimes", command)
        self.assertEqual(command[command.index("--js-runtimes") + 1], f"node:{node}")
        self.assertLess(command.index("--no-js-runtimes"), command.index("--js-runtimes"))
        self.assertIn("--no-remote-components", command)
        self.assertNotIn("--remote-components", command)

    def test_ytdlp_rejects_playlist_drm_live_and_unsafe_streams(self):
        media = self.module()
        for changes in (
            {"_type": "playlist", "entries": [{"id": "one"}]},
            {"has_drm": True},
            {"is_live": True},
            {"url": "http://127.0.0.1/a.wav"},
            {"protocol": "m3u8_native"},
        ):
            info = {
                "_type": "video",
                "title": "节目",
                "url": "https://cdn.example.com/a.wav",
                "protocol": "https",
            }
            info.update(changes)
            output = subprocess.CompletedProcess([], 0, json.dumps(info), "")
            with (
                self.subTest(changes=changes),
                patch("scripts.media.subprocess.run", return_value=output),
                patch("requests.Session.get") as get,
            ):
                with self.assertRaisesRegex(media.MediaError, "单项|DRM|直播|地址|分段"):
                    media.resolve_input("https://example.com/watch/123", self.job)
                get.assert_not_called()

    def test_explicit_cookies_and_platform_headers_are_used_without_browser_access(self):
        media = self.module()
        cookie = self.job / "cookies.txt"
        cookie.write_text(
            "# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t2147483647\tsession\texplicit\n",
            encoding="utf-8",
        )
        info = {
            "title": "节目",
            "url": "https://cdn.example.com/a.wav",
            "protocol": "https",
            "http_headers": {"Referer": "https://example.com/", "User-Agent": "测试客户端"},
        }
        real_run = subprocess.run
        commands = []

        def run(command, **kwargs):
            if "yt_dlp" in command:
                commands.append(command)
                return subprocess.CompletedProcess(command, 0, json.dumps(info), "")
            return real_run(command, **kwargs)

        seen = []
        body = self.wav().read_bytes()

        def get(session, url, **kwargs):
            seen.append((dict(session.cookies), dict(session.headers)))
            return self.response(body)

        with (
            patch("scripts.media.subprocess.run", side_effect=run),
            patch("requests.Session.get", autospec=True, side_effect=get),
        ):
            media.resolve_input("https://example.com/watch/123", self.job, cookies_file=str(cookie))
        self.assertIn("--cookies", commands[0])
        self.assertEqual(seen[0][0]["session"], "explicit")
        self.assertEqual(seen[0][1]["Referer"], "https://example.com/")
        self.assertNotIn("--cookies-from-browser", commands[0])

    def test_cookies_file_is_not_modified_by_extractor(self):
        media = self.module()
        cookie = self.job / "用户cookies.txt"
        original = "# Netscape HTTP Cookie File\n"
        cookie.write_text(original, encoding="utf-8")
        info = {"title": "节目", "url": "https://example.com/a.wav", "protocol": "https"}

        def run(command, **kwargs):
            used = Path(command[command.index("--cookies") + 1])
            used.write_text("# Netscape HTTP Cookie File\n# 提取器保存了状态\n", encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, json.dumps(info), "")

        with patch("scripts.media.subprocess.run", side_effect=run):
            media._ytdlp("https://example.com/watch/1", self.job, "ffmpeg", str(cookie))
        self.assertEqual(cookie.read_text(encoding="utf-8"), original)

    def test_ximalaya_api_error_cannot_be_used_as_full_track(self):
        media = self.module()
        audio = {"ret": 500, "data": {"src": "https://example.com/a.wav", "canPlay": True}}
        meta = {"ret": 200, "data": {"trackInfo": {"title": "节目", "duration": 1}}}
        responses = [
            self.response(json.dumps(audio).encode()),
            self.response(json.dumps(meta).encode()),
            self.response(self.wav().read_bytes()),
        ]
        with patch("requests.Session.get", side_effect=responses):
            with self.assertRaisesRegex(media.MediaError, "接口|完整"):
                media.resolve_input("https://www.ximalaya.com/sound/123456", self.job)

    def test_invalid_downloaded_media_is_removed(self):
        media = self.module()
        before = set(self.job.iterdir())
        with patch("requests.Session.get", return_value=self.response(b"not media")):
            with self.assertRaises(media.MediaError):
                media.resolve_input("https://example.com/fake.wav", self.job)
        self.assertEqual(before, set(self.job.iterdir()))

    def test_slow_download_has_total_time_limit(self):
        media = self.module()
        response = self.response(self.wav().read_bytes())
        with (
            patch("requests.Session.get", return_value=response),
            patch("time.monotonic", side_effect=[0, 1900]),
        ):
            with self.assertRaisesRegex(media.MediaError, "超时"):
                media.resolve_input("https://example.com/a.wav", self.job)

    def test_probe_rejects_nonfinite_or_missing_duration(self):
        media = self.module()
        source = self.wav()
        for value in (None, "nan", "inf", "0", "-2"):
            payload = {"streams": [{"codec_type": "audio"}], "format": {"duration": value}}
            with self.subTest(value=value), patch("scripts.media.subprocess.run") as run:
                run.return_value.stdout = json.dumps(payload)
                with self.assertRaisesRegex(media.MediaError, "时长"):
                    media.resolve_input(str(source), self.job)

    def test_invalid_local_input_has_clear_errors(self):
        media = self.module()
        empty = self.job / "空.mp3"
        empty.touch()
        corrupt = self.job / "假.mp3"
        corrupt.write_text("不是音频", encoding="utf-8")
        for path in (self.job / "不存在.wav", empty, corrupt, self.job):
            with self.subTest(path=path), self.assertRaises(media.MediaError):
                media.resolve_input(str(path), self.job)

    def test_rejects_local_files_without_a_real_audio_track(self):
        media = self.module()
        path = self.job / "仅视频.mp4"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=s=16x16:d=0.1", "-an", str(path)],
            check=True,
            capture_output=True,
            timeout=30,
        )
        with self.assertRaisesRegex(media.MediaError, "音轨"):
            media.resolve_input(str(path), self.job)

    def test_local_audio_returns_probed_duration(self):
        media = self.module()
        source = self.wav()
        result = media.resolve_input(str(source), self.job)
        self.assertEqual(result["path"], source.resolve())
        self.assertEqual(result["title"], "声音")
        self.assertEqual(result["source"], str(source))
        self.assertEqual(result["platform"], "local")
        self.assertIsInstance(result["duration"], float)
        self.assertAlmostEqual(result["duration"], 1.0, places=3)
