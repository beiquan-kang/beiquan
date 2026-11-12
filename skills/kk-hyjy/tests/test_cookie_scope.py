"""仅用临时假 Cookie 验证入口授权范围，不发起真实网络请求。"""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import json

import pytest

from scripts import media


@pytest.mark.parametrize("source, domain", [
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", ".com"),
    ("https://media.example.co.uk/audio.wav", ".co.uk"),
    ("https://media.example.com.cn/audio.wav", ".com.cn"),
    ("https://project.github.io/audio.wav", ".github.io"),
])
def test_public_suffix_cookie_is_rejected(tmp_path, network_boundaries, source, domain):
    cookie = cookie_file(tmp_path, cookie_row(domain))
    with pytest.raises(media.MediaError, match="Cookie.*域名"):
        media.resolve_input(source, tmp_path / "job", cookies_file=str(cookie))
    for boundary in network_boundaries:
        boundary.assert_not_called()


@pytest.mark.parametrize("source, domain, unrelated", [
    ("https://www.youtube.com/", ".youtube.com", "https://unrelated.example.com/"),
    ("https://media.example.co.uk/", ".example.co.uk", "https://unrelated.co.uk/"),
])
def test_authorized_cookie_stays_out_of_unrelated_request(tmp_path, source, domain, unrelated):
    cookie = cookie_file(tmp_path, cookie_row(domain))
    media._validate_cookie_scope(source, str(cookie))
    jar = media.MozillaCookieJar(str(cookie))
    jar.load(ignore_discard=True)
    with media.requests.Session() as session:
        session.trust_env = False
        session.cookies.update(jar)
        origin = session.prepare_request(media.requests.Request("GET", source))
        redirected = session.prepare_request(media.requests.Request("GET", unrelated))
    assert origin.headers["Cookie"] == "session=fixture-secret"
    assert "Cookie" not in redirected.headers


SOURCES = [
    "https://cdn.example.com/audio.wav",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.bilibili.com/video/BV1XNtJ6UEmm/",
    "https://www.xiaoyuzhoufm.com/episode/fixture",
    "https://www.ximalaya.com/sound/123456",
]


def cookie_file(tmp_path, *rows):
    path = tmp_path / "explicit.cookies"
    path.write_text("# Netscape HTTP Cookie File\n" + "".join(rows), encoding="utf-8")
    return path


def cookie_row(domain, *, expires="2147483647", prefix=""):
    flag = "TRUE" if domain.startswith(".") else "FALSE"
    return f"{prefix}{domain}\t{flag}\t/\tTRUE\t{expires}\tsession\tfixture-secret\n"


@pytest.fixture
def network_boundaries(monkeypatch):
    """真实网络/提取器边界一旦被越过就失败，防止红测产生外部访问。"""
    get = Mock(side_effect=AssertionError("Cookie 校验前调用了 requests"))
    run = Mock(side_effect=AssertionError("Cookie 校验前调用了子进程"))
    monkeypatch.setattr(media.requests.Session, "get", get)
    monkeypatch.setattr(media.subprocess, "run", run)
    return get, run


@pytest.mark.parametrize("source", SOURCES)
def test_unrelated_cookie_is_rejected_before_network(tmp_path, capsys, network_boundaries, source):
    cookie = cookie_file(tmp_path, cookie_row(".unrelated.example"))
    original = cookie.read_bytes()
    with pytest.raises(media.MediaError, match="Cookie.*授权.*域名") as error:
        media.resolve_input(source, tmp_path / "job", cookies_file=str(cookie))
    assert "fixture-secret" not in str(error.value)
    captured = capsys.readouterr()
    assert "fixture-secret" not in captured.out + captured.err
    assert cookie.read_bytes() == original
    for boundary in network_boundaries:
        boundary.assert_not_called()


@pytest.mark.parametrize("source, domain", [
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", ".youtube.com"),
    ("https://youtu.be/dQw4w9WgXcQ", ".youtube.com"),
    ("https://youtu.be/dQw4w9WgXcQ", "youtube.com"),
    ("https://youtu.be/dQw4w9WgXcQ", "youtu.be"),
])
def test_youtube_cookies_reach_extractor_copy_and_requests(
    tmp_path, monkeypatch, network_boundaries, source, domain
):
    cookie = cookie_file(tmp_path, cookie_row(domain, prefix="#HttpOnly_"))
    original = cookie.read_bytes()
    copies = []
    info = {"title": "fixture", "url": "https://cdn.example.com/audio.wav", "protocol": "https"}

    def extract(command, **kwargs):
        assert "yt_dlp" in command
        assert "--cookies-from-browser" not in command
        used = Path(command[command.index("--cookies") + 1])
        assert used != cookie
        assert used.read_bytes() == original
        copies.append(used)
        used.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")
        return SimpleNamespace(stdout=json.dumps(info))

    sessions = []

    def get(session, url, **kwargs):
        assert [(c.domain, c.value) for c in session.cookies] == [(domain, "fixture-secret")]
        sessions.append(session)
        response = media.requests.Response()
        response.status_code = 200
        response.headers["Content-Length"] = "5"
        response._content = b"audio"
        response._content_consumed = True
        return response

    monkeypatch.setattr(media.subprocess, "run", extract)
    monkeypatch.setattr(media.requests.Session, "get", get)
    monkeypatch.setattr(media, "_probe", lambda *args: 1)
    result = media.resolve_input(source, tmp_path / "job", cookies_file=str(cookie))
    assert result["path"].read_bytes() == b"audio"
    assert len(copies) == len(sessions) == 1
    assert all(not path.exists() for path in copies)
    assert cookie.read_bytes() == original


@pytest.mark.parametrize("content", [
    "fixture-secret\n",
    "# Netscape HTTP Cookie File\nfixture-secret\n",
    "# Netscape HTTP Cookie File\n" + cookie_row(".example.com", expires="fixture-secret"),
    "# Netscape HTTP Cookie File\n" + cookie_row(".example.com").replace("\tTRUE\t/", "\tFALSE\t/"),
    None,
])
def test_invalid_cookie_file_fails_without_leaking_values(
    tmp_path, capsys, recwarn, network_boundaries, content
):
    cookie = tmp_path / "invalid.cookies"
    if content is not None:
        cookie.write_text(content, encoding="utf-8")
    with pytest.raises(media.MediaError, match="Cookie.*(读取|格式)") as error:
        media.resolve_input("https://www.example.com/audio.wav", tmp_path / "job", cookies_file=str(cookie))
    captured = capsys.readouterr()
    messages = str(error.value) + captured.out + captured.err + "".join(str(w.message) for w in recwarn)
    assert "fixture-secret" not in messages
    for boundary in network_boundaries:
        boundary.assert_not_called()
    if content is not None:
        assert cookie.read_text("utf-8") == content
    else:
        assert not cookie.exists()


@pytest.mark.parametrize("domain, expires, prefix", [
    (".unrelated.example", "2147483647", ""),
    (".unrelated.example", "1", ""),
    (".unrelated.example", "", "#HttpOnly_"),
    (".badexample.com", "2147483647", ""),
    (".example.com.evil.test", "2147483647", ""),
    (".other.example.com", "2147483647", ""),
    (".child.cdn.example.com", "2147483647", ""),
])
def test_mixed_file_checks_every_domain(tmp_path, network_boundaries, domain, expires, prefix):
    cookie = cookie_file(tmp_path, cookie_row(".example.com"),
                         cookie_row(domain, expires=expires, prefix=prefix))
    original = cookie.read_bytes()
    with pytest.raises(media.MediaError, match="Cookie.*授权.*域名"):
        media.resolve_input("https://cdn.example.com/audio.wav", tmp_path / "job", cookies_file=str(cookie))
    for boundary in network_boundaries:
        boundary.assert_not_called()
    assert cookie.read_bytes() == original


@pytest.mark.parametrize("source, domains, parser, platform", [
    ("https://cdn.example.com/audio.wav", ["cdn.example.com", ".example.com"], None, "direct"),
    ("https://CDN.EXAMPLE.COM/audio.wav", [".EXAMPLE.COM"], None, "direct"),
    ("https://www.bilibili.com/video/BV1XNtJ6UEmm/", [".bilibili.com"], "_bilibili", "bilibili"),
    ("https://www.xiaoyuzhoufm.com/episode/fixture", [".xiaoyuzhoufm.com"], "_xiaoyuzhou", "xiaoyuzhou"),
    ("https://www.ximalaya.com/sound/123456", [".ximalaya.com"], "_ximalaya", "ximalaya"),
    ("https://cdn.example.com/audio.wav", [], None, "direct"),
])
def test_allowed_domains_keep_existing_routes(
    tmp_path, monkeypatch, network_boundaries, source, domains, parser, platform
):
    cookie = cookie_file(tmp_path, *(cookie_row(domain) for domain in domains))
    original = cookie.read_bytes()
    if parser:
        extract = Mock(return_value={"url": "https://cdn.example.com/audio.wav", "title": "fixture"})
        monkeypatch.setattr(media, parser, extract)
    path = tmp_path / "audio.wav"
    path.write_bytes(b"audio")
    download = Mock(return_value=path)
    monkeypatch.setattr(media, "_download", download)
    monkeypatch.setattr(media, "_probe", lambda *args: 1)
    result = media.resolve_input(source, tmp_path / "job", cookies_file=str(cookie))
    assert result["platform"] == platform
    assert download.call_args.kwargs["cookies_file"] == str(cookie)
    if parser:
        extract.assert_called_once()
        assert extract.call_args.args[0] == source
        if parser == "_bilibili":
            assert extract.call_args.args[1] == str(cookie)
    assert cookie.read_bytes() == original
