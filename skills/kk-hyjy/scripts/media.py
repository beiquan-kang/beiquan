"""安全解析本地及在线音视频，只返回通过探测的完整媒体。"""

import json
from http.cookiejar import MozillaCookieJar
import ipaddress
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit, urlunsplit
import uuid
import warnings

import requests

MAX_BYTES = 2 * 1024**3
HTTP_RANGE_BYTES = 4 * 1024**2


class MediaError(ValueError):
    """输入获取或媒体验证失败。"""


def _validate_url(url: str) -> str:
    """只接收无嵌入凭据的公网 HTTP 地址。"""
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower().rstrip(".")
        if parts.scheme not in ("http", "https"):
            raise MediaError("下载地址仅允许 HTTP 或 HTTPS 协议。")
        if parts.username is not None or parts.password is not None:
            raise MediaError("下载地址禁止包含账号密码凭据。")
        if not host or "\\" in url or any(ord(c) < 33 for c in url):
            raise MediaError("下载地址格式无效。")
        if parts.port is not None and not 0 < parts.port < 65536:
            raise ValueError
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            if (
                "." not in host
                or host.endswith((".local", ".localhost", ".internal", ".lan"))
                or re.fullmatch(r"[0-9.]+|0x[0-9a-f.]+", host)
            ):
                raise MediaError("下载地址禁止本地网络地址。") from None
        else:
            if not address.is_global:
                raise MediaError("下载地址禁止本地网络地址。")
    except ValueError as error:
        if isinstance(error, MediaError):
            raise
        raise MediaError("下载地址格式无效。") from None
    return url


def display_source(source: str) -> str:
    """展示来源保留视频标识和端口，隐藏其他查询值及片段。"""
    if "://" not in source:
        return source
    parts = urlsplit(source)
    host = parts.hostname or ""
    netloc = (f"[{host}]" if ":" in host else host) + (f":{parts.port}" if parts.port else "")
    kept = []
    for item in parts.query.split("&"):
        key, _, value = item.partition("=")
        if key == "v" and re.fullmatch(r"[A-Za-z0-9_-]{11}", value):
            kept.append(item)
        elif key in ("p", "i", "trackId") and re.fullmatch(r"[0-9]{1,20}", value):
            kept.append(item)
    return urlunsplit((parts.scheme, netloc, parts.path, "&".join(kept), ""))


def _response(session, url: str, *, headers=None):
    """逐跳验证重定向，限制跳转次数。"""
    for _ in range(6):
        response = session.get(
            _validate_url(url), stream=True, allow_redirects=False, timeout=(15, 45),
            proxies=requests.utils.get_environ_proxies(url),
            **({"headers": headers} if headers else {}),
        )
        if response.status_code not in (301, 302, 303, 307, 308):
            return response
        location = response.headers.get("Location")
        response.close()
        if not location:
            raise MediaError("重定向缺少目标地址。")
        url = urljoin(url, location)
    raise MediaError("下载地址重定向次数过多。")


def _download_ranges(session, url, path, limit, deadline):
    """按连续字节范围下载同一完整音轨，验证每段范围及总大小。"""
    position, total = 0, None
    with path.open("wb") as output:
        while total is None or position < total:
            if time.monotonic() > deadline:
                raise MediaError("下载总耗时超时，已停止。")
            end = position + HTTP_RANGE_BYTES - 1
            if total is not None:
                end = min(end, total - 1)
            headers = {"Range": f"bytes={position}-{end}", "Accept-Encoding": "identity"}
            with _response(session, url, headers=headers) as response:
                if response.status_code != 206:
                    raise MediaError(f"范围下载失败，HTTP 状态为 {response.status_code}。")
                match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
                if not match:
                    raise MediaError("下载字节范围无效。")
                start, last, size = map(int, match.groups())
                if start != position or not start <= last <= end or last >= size:
                    raise MediaError("下载字节范围不连续或超出总大小。")
                if total is not None and size != total:
                    raise MediaError("下载总大小发生变化。")
                if size > limit:
                    raise MediaError("下载大小超过 2GB 上限。")
                total = size
                expected = last - start + 1
                declared = response.headers.get("Content-Length")
                if declared is not None and int(declared) != expected:
                    raise MediaError("范围响应大小不一致。")
                if response.headers.get("Content-Encoding", "identity").lower() != "identity":
                    raise MediaError("范围响应编码无法验证。")
                received = 0
                for chunk in response.iter_content(chunk_size=1024 * 256):
                    if time.monotonic() > deadline:
                        raise MediaError("下载总耗时超时，已停止。")
                    received += len(chunk)
                    if received > expected or position + received > limit:
                        raise MediaError("范围响应超过声明大小。")
                    output.write(chunk)
                if received != expected:
                    raise MediaError("下载文件为空或不完整。")
                position += received


def _download(
    url: str,
    job_dir: Path,
    *,
    limit: int | None = None,
    headers: dict | None = None,
    cookies_file: str | None = None,
) -> Path:
    """将响应写入任务目录，不信任服务器提供的文件名。"""
    suffix = Path(urlsplit(url).path).suffix
    path = job_dir / (uuid.uuid4().hex + (suffix if suffix else ".media"))
    limit = MAX_BYTES if limit is None else limit
    deadline = time.monotonic() + 1800
    try:
        with requests.Session() as session:
            session.trust_env = False
            if cookies_file:
                jar = MozillaCookieJar(cookies_file)
                jar.load(ignore_discard=True)
                session.cookies.update(jar)
            session.headers.update(
                {
                    k: v
                    for k, v in (headers or {}).items()
                    if k.lower() in ("referer", "user-agent", "accept", "origin")
                }
            )
            if (urlsplit(url).hostname or "").lower().endswith(".googlevideo.com"):
                _download_ranges(session, url, path, limit, deadline)
                return path
            with _response(session, url) as response:
                if response.status_code != 200:
                    raise MediaError(f"下载失败，HTTP 状态为 {response.status_code}。")
                declared = int(response.headers.get("Content-Length", 0))
                if declared > limit:
                    raise MediaError("下载大小超过 2GB 上限。")
                size = 0
                with path.open("wb") as output:
                    for chunk in response.iter_content(chunk_size=1024 * 256):
                        if time.monotonic() > deadline:
                            raise MediaError("下载总耗时超时，已停止。")
                        size += len(chunk)
                        if size > limit:
                            raise MediaError("下载大小超过 2GB 上限。")
                        output.write(chunk)
                if not size or (
                    declared and declared != size and not response.headers.get("Content-Encoding")
                ):
                    raise MediaError("下载文件为空或不完整。")
    except (requests.RequestException, OSError, ValueError) as error:
        path.unlink(missing_ok=True)
        if isinstance(error, MediaError):
            raise
        raise MediaError("下载失败，网络超时、连接错误或响应无效。") from None
    return path


def _page(url: str, job_dir: Path) -> str:
    """限制页面大小，只解析数据，不运行页面脚本。"""
    path = _download(url, job_dir, limit=8 * 1024**2)
    try:
        return path.read_text(encoding="utf-8")
    finally:
        path.unlink(missing_ok=True)


def _xiaoyuzhou(url: str, job_dir: Path) -> dict:
    """读取公开页面中的单集数据。"""
    page = _page(url, job_dir)
    match = re.search(
        r"<script\b[^>]*\bid=[\"\x27]__NEXT_DATA__[\"\x27][^>]*>(.*?)</script>",
        page,
        re.DOTALL | re.IGNORECASE,
    )
    try:
        episode = json.loads(match.group(1))["props"]["pageProps"]["episode"]
        return {
            "url": episode["media"]["source"]["url"],
            "title": episode["title"],
            "duration": episode.get("duration"),
        }
    except (AttributeError, KeyError, TypeError, ValueError):
        raise MediaError("小宇宙缺少可用单集音轨，页面结构可能已变化。") from None


def _ximalaya(url: str, job_dir: Path) -> dict:
    """通过公开接口读取单条声音，缺少完整性证据时拒绝。"""
    match = re.search(r"/(?:sound/|\d+/)(\d+)(?:/|$)", urlsplit(url).path)
    if not match:
        raise MediaError("喜马拉雅地址必须指定单条声音。")
    base = "https://www.ximalaya.com/revision/track/"
    try:
        audio_response = json.loads(_page(base + "v2/audio?ptype=1&trackId=" + match[1], job_dir))
        meta_response = json.loads(_page(base + "simple?trackId=" + match[1], job_dir))
        if any(response.get("ret") not in (0, 200) for response in (audio_response, meta_response)):
            raise MediaError("喜马拉雅接口拒绝了请求。")
        audio, meta = audio_response["data"], meta_response["data"]
        track = meta["trackInfo"]
        if audio.get("canPlay") is not True or any(
            block.get(flag) not in (None, False, 0, "0", "false")
            for block in (audio, track, meta.get("albumInfo", {}))
            for flag in ("albumIsSample", "isSample", "isPaid", "isVip", "isPreview", "isTrial")
        ):
            raise MediaError("喜马拉雅付费、试听或不可播放节目不能作为完整音轨。")
        if not math.isfinite(float(track["duration"])) or float(track["duration"]) <= 0:
            raise MediaError("喜马拉雅缺少完整节目时长。")
        return {"url": audio["src"], "title": track["title"], "duration": track["duration"]}
    except (KeyError, TypeError, ValueError):
        raise MediaError("喜马拉雅接口没有可验证的完整节目。") from None


def _bilibili(url: str, cookies_file: str | None = None) -> dict:
    """通过公开接口解析单个 BV 视频，保持匿名访客会话。"""
    parts = urlsplit(url)
    match = re.fullmatch(r"/video/(BV[1-9A-HJ-NP-Za-km-z]{10})/?", parts.path)
    if not match:
        raise MediaError("B站视频标识格式无效。")
    bvid = match[1]
    pages = parse_qs(parts.query, keep_blank_values=True).get("p", ["1"])
    if len(pages) != 1 or not re.fullmatch(r"[1-9][0-9]{0,8}", pages[0]):
        raise MediaError("B站分P编号格式无效。")
    page_number = int(pages[0])
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Referer": "https://www.bilibili.com/",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    try:
        with requests.Session() as session:
            session.trust_env = False
            session.headers.update(headers)
            if cookies_file:
                jar = MozillaCookieJar(cookies_file)
                jar.load(ignore_discard=True)
                session.cookies.update(jar)

            def document(address):
                with _response(session, address) as response:
                    if response.status_code != 200:
                        raise MediaError(f"B站接口访问失败，HTTP 状态为 {response.status_code}。")
                    body = bytearray()
                    for chunk in response.iter_content(chunk_size=65536):
                        body.extend(chunk)
                        if len(body) > 8 * 1024**2:
                            raise MediaError("B站响应超过大小限制。")
                    return bytes(body)

            def api(endpoint, params):
                payload = json.loads(document("https://api.bilibili.com" + endpoint + "?" + urlencode(params)))
                if not isinstance(payload, dict) or payload.get("code") != 0:
                    raise MediaError("B站接口拒绝请求，需检查访问权限或风控状态。")
                data = payload.get("data")
                if not isinstance(data, dict):
                    raise MediaError("B站接口缺少有效数据。")
                return data

            document("https://www.bilibili.com/")
            meta = api("/x/web-interface/view", {"bvid": bvid})
            if meta.get("bvid") != bvid:
                raise MediaError("B站返回的视频标识与来源不一致。")
            rights = meta.get("rights") or {}
            if meta.get("is_upower_exclusive") or any(
                rights.get(flag) for flag in ("pay", "ugc_pay", "arc_pay", "ugc_pay_preview")
            ):
                raise MediaError("B站付费或试听内容无法通过当前公开接口验收。")
            if rights.get("is_stein_gate") or meta.get("redirect_url"):
                raise MediaError("B站交互视频或跳转节目需要单独验收。")
            page = next(p for p in meta["pages"] if p.get("page") == page_number)
            expected = float(page["duration"])
            if not math.isfinite(expected) or expected <= 0:
                raise MediaError("B站缺少有效节目时长。")
            play = api("/x/player/playurl", {"bvid": bvid, "cid": page["cid"], "fnval": 16, "qn": 16, "fourk": 0})
            if any(play.get(flag) for flag in ("is_preview", "is_trial", "has_drm", "is_drm", "drm_tech_type")):
                raise MediaError("B站试听或 DRM 内容无法作为完整音轨。")
            duration = float(play["timelength"]) / 1000
            if not math.isfinite(duration) or abs(duration - expected) > max(2, expected * .02):
                raise MediaError("B站播放时长与节目不一致，无法确认完整性。")
            audio = max(play["dash"]["audio"], key=lambda a: float(a.get("bandwidth") or 0))
            media_url = _validate_url(audio.get("baseUrl") or audio.get("base_url") or "")
            title = meta["title"]
            if len(meta["pages"]) > 1:
                title += f" p{page_number:02d} {page.get('part', '')}"
            return {"url": media_url, "title": title, "duration": duration, "http_headers": headers}
    except (requests.RequestException, OSError, KeyError, TypeError, ValueError, StopIteration) as error:
        if isinstance(error, MediaError):
            raise
        raise MediaError("B站接口解析失败，未取得可验证的完整音轨。") from None


def _ytdlp(url: str, job_dir: Path, ffmpeg: str, cookies_file: str | None) -> dict:
    """仅用隔离配置的提取器读取元数据，实际下载由受限 HTTP 客户端完成。"""
    temporary = job_dir / "tmp"
    temporary.mkdir(exist_ok=True)
    env = dict(os.environ, TMPDIR=str(temporary), TEMP=str(temporary), TMP=str(temporary))
    command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--ignore-config",
        "--no-plugin-dirs",
        "--no-exec",
        "--no-js-runtimes",
        "--no-remote-components",
        "--no-playlist",
        "--flat-playlist",
        "--playlist-end",
        "1",
        "--no-cache-dir",
        "--skip-download",
        "--dump-single-json",
        "--socket-timeout",
        "30",
        "--retries",
        "1",
        "--ffmpeg-location",
        ffmpeg,
        "--format",
        "bestaudio[protocol=https]/bestaudio[protocol=http]/best[protocol=https]/best[protocol=http]",
        "--",
        url,
    ]
    host = (urlsplit(url).hostname or "").lower()
    if host == "youtu.be" or host == "youtube.com" or host.endswith(".youtube.com"):
        node = shutil.which("node")
        if node:
            command[-2:-2] = ["--js-runtimes", f"node:{node}"]
    cookie_copy = temporary / (uuid.uuid4().hex + ".cookies")
    try:
        if cookies_file:
            shutil.copyfile(Path(cookies_file).resolve(), cookie_copy)
            command[-2:-2] = ["--cookies", str(cookie_copy)]
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=180,
            check=True,
            env=env,
            cwd=str(job_dir),
        )
        info = json.loads(result.stdout)
    except (OSError, ValueError, subprocess.SubprocessError):
        raise MediaError("平台提取失败，可能受登录、地区、反爬或格式限制；可提供合法本地文件。") from None
    finally:
        cookie_copy.unlink(missing_ok=True)
    if not isinstance(info, dict) or info.get("_type", "video") != "video" or "entries" in info:
        raise MediaError("只允许单项媒体，禁止播放列表或合集。")
    if info.get("has_drm") or any(f.get("has_drm") for f in info.get("requested_formats", [])):
        raise MediaError("禁止下载 DRM 受保护媒体。")
    if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming", "post_live"):
        raise MediaError("直播或尚未完整归档的节目不能作为完整媒体。")
    if info.get("protocol") not in ("http", "https") or info.get("fragments"):
        raise MediaError("此节目仅提供分段流，当前安全下载模式不支持；请提供完整本地文件。")
    _validate_url(info.get("url", ""))
    return info


def _probe(path: Path, ffprobe: str) -> float:
    """使用真实音轨与容器时长验证媒体。"""
    if not path.is_file() or not path.stat().st_size:
        raise MediaError("本地文件不存在、不可读或为空。")
    try:
        with path.open("rb"):
            pass
        probe = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        raise MediaError("ffprobe 媒体验证失败，请检查文件及工具安装。") from None
    data = json.loads(probe.stdout)
    if not any(stream.get("codec_type") == "audio" for stream in data.get("streams", [])):
        raise MediaError("媒体没有可用音轨。")
    try:
        duration = float(data["format"]["duration"])
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError
    except (KeyError, TypeError, ValueError):
        raise MediaError("无法确认媒体的有效时长。") from None
    return duration


def _validate_cookie_scope(source: str, cookies_file: str) -> None:
    """在任何平台请求前核对显式 Cookie 的来源域，不修改原文件。"""
    from publicsuffixlist import PublicSuffixList

    host = (urlsplit(source).hostname or "").lower().rstrip(".")
    suffixes = PublicSuffixList()
    jar = MozillaCookieJar(cookies_file)
    try:
        with warnings.catch_warnings():
            # cookiejar 的格式警告可能包含原始 Cookie 行，不能输出。
            warnings.simplefilter("ignore", UserWarning)
            jar.load(ignore_discard=True, ignore_expires=True)
    except (OSError, ValueError):
        raise MediaError("Cookie 文件无法读取或不是有效的 Netscape 格式。") from None
    for cookie in jar:
        domain = cookie.domain.removeprefix(".").lower()
        if not domain or suffixes.is_public(domain) or not (
            host == domain or host.endswith("." + domain)
            or (host == "youtu.be" and domain == "youtube.com")
        ):
            raise MediaError("Cookie 文件包含非授权来源域名；请仅导出目标站点的 Cookie。")


def resolve_input(
    source: str,
    job_dir: Path,
    *,
    ffmpeg: str = "ffmpeg",
    ffprobe: str = "ffprobe",
    cookies_file: str | None = None,
) -> dict:
    """获取单项媒体，返回绝对路径、标题、来源、平台和实测时长。"""
    platform = "local"
    item = {}
    if "://" in source:
        _validate_url(source)
        if cookies_file:
            _validate_cookie_scope(source, cookies_file)
        job_dir = Path(job_dir).resolve()
        job_dir.mkdir(parents=True, exist_ok=True)
        title = Path(urlsplit(source).path).stem or "媒体"
        platform = "direct"
        url = source
        if urlsplit(source).hostname in ("xiaoyuzhoufm.com", "www.xiaoyuzhoufm.com"):
            item = _xiaoyuzhou(source, job_dir)
            url, title, platform = item["url"], item["title"], "xiaoyuzhou"
        elif urlsplit(source).hostname in ("ximalaya.com", "www.ximalaya.com", "m.ximalaya.com"):
            item = _ximalaya(source, job_dir)
            url, title, platform = item["url"], item["title"], "ximalaya"
        elif (
            urlsplit(source).hostname in ("bilibili.com", "www.bilibili.com", "m.bilibili.com")
            and urlsplit(source).path.startswith("/video/BV")
        ):
            item = _bilibili(source, cookies_file)
            url, title, platform = item["url"], item["title"], "bilibili"
        elif Path(urlsplit(source).path).suffix.lower() not in (
            ".mp3",
            ".mp4",
            ".wav",
            ".m4a",
            ".aac",
            ".ogg",
            ".opus",
            ".flac",
            ".webm",
            ".mov",
            ".mkv",
        ):
            item = _ytdlp(source, job_dir, ffmpeg, cookies_file)
            url, title = item["url"], item["title"]
            platform = item.get("extractor_key", "yt-dlp").lower()
        path = _download(url, job_dir, headers=item.get("http_headers"), cookies_file=cookies_file)
    else:
        path = Path(source).expanduser().resolve()
        title = path.stem
    try:
        duration = _probe(path, ffprobe)
        expected = float(item.get("duration") or 0)
        if expected and duration + max(2.0, expected * 0.02) < expected:
            raise MediaError("下载音轨短于节目时长，无法确认完整性。")
    except (ValueError, TypeError) as error:
        if platform != "local":
            path.unlink(missing_ok=True)
        if isinstance(error, MediaError):
            raise
        raise MediaError("媒体验证失败，音轨或完整时长无效。") from None
    return {"path": path, "title": title, "source": source, "platform": platform, "duration": duration}
