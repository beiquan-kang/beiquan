"""转写流程的行为测试；所有云端调用均为 mock，无真实 Groq 密钥或请求。"""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


@pytest.fixture
def mock_cloud_config():
    """有效准入配置仅用于 mock 云端，不使用真实 Groq 密钥。"""
    key = "mock-cloud-test-placeholder"
    return key, {"cloud_enabled": True, "free_plan_confirmed_at": 1000,
                 "confirmed_key_sha256": hashlib.sha256(key.encode()).hexdigest()}


@pytest.mark.parametrize("usage", [
    {}, None, "", 0, [None], [[]], [{}], [{"time": 1000}],
    *[[{"time": value, "seconds": 10}] for value in
      (True, "1000", float("nan"), float("inf"), float("-inf"), -1, 1002)],
    *[[{"time": 1000, "seconds": value}] for value in
      (False, "10", float("nan"), float("inf"), float("-inf"), -1)],
    [{"time": 0, "seconds": -1}, {"time": 1000, "seconds": 10}],
])
def test_invalid_usage_never_calls_mock_cloud(tmp_path, mock_cloud_config, usage):
    import transcript as t
    key, config = mock_cloud_config
    audio = tmp_path / "audio.flac"
    audio.write_bytes(b"mock-audio")
    usage_file = tmp_path / "cloud-usage.json"
    original = json.dumps(usage)
    usage_file.write_text(original, encoding="utf-8")
    calls = []

    def cloud(*args):
        calls.append("cloud")
        return {"segments": [{"start": 0, "end": 2, "text": "mock云端"}]}

    def local(*args):
        calls.append("local")
        return {"segments": [{"start": 0, "end": 2, "text": "mock本地"}]}

    result = t.transcribe_audio(audio, 3, config, tmp_path, key=key, now=1001,
                                cloud_fn=cloud, local_fn=local)
    assert calls == ["local"]
    assert result["backend"] == "local"
    assert usage_file.read_text("utf-8") == original


@pytest.mark.parametrize("changes, now", [
    *[({"cloud_enabled": value}, 1001) for value in (1, "true", "false", None, False)],
    *[({"free_plan_confirmed_at": value}, 1001) for value in
      (True, "1000", None, float("nan"), float("inf"), float("-inf"), -1, 1002)],
    *[({"free_plan_confirmed_at": 0}, value) for value in
      (True, "1001", float("nan"), float("inf"), float("-inf"), -1)],
])
def test_invalid_confirmation_never_calls_mock_cloud(tmp_path, mock_cloud_config, changes, now):
    import transcript as t
    key, config = mock_cloud_config
    config.update(changes)
    audio = tmp_path / "audio.flac"
    audio.write_bytes(b"mock-audio")
    calls = []

    def cloud(*args):
        calls.append("cloud")
        return {"segments": [{"start": 0, "end": 2, "text": "mock云端"}]}

    result = t.transcribe_audio(audio, 3, config, tmp_path, key=key, now=now,
        cloud_fn=cloud,
        local_fn=lambda *a: {"segments": [{"start": 0, "end": 2, "text": "mock本地"}]})
    assert calls == []
    assert result["backend"] == "local"
    assert t.cloud_decision(config, key, 100, 3, [], now)[0] is False


def test_missing_confirmation_time_never_calls_mock_cloud(tmp_path, mock_cloud_config):
    import transcript as t
    key, config = mock_cloud_config
    config.pop("free_plan_confirmed_at")
    audio = tmp_path / "audio.flac"
    audio.write_bytes(b"mock-audio")
    calls = []

    def cloud(*args):
        calls.append("cloud")
        return {"segments": [{"start": 0, "end": 2, "text": "mock云端"}]}

    result = t.transcribe_audio(audio, 3, config, tmp_path, key=key, now=1001,
        cloud_fn=cloud,
        local_fn=lambda *a: {"segments": [{"start": 0, "end": 2, "text": "mock本地"}]})
    assert calls == []
    assert result["backend"] == "local"


@pytest.mark.parametrize("field", ["start", "end"])
@pytest.mark.parametrize("value", ["0", "2", True, False, float("nan"), float("inf"), None])
def test_invalid_timestamps_fall_back_inside_mock_cloud(tmp_path, mock_cloud_config, field, value):
    import transcript as t
    key, config = mock_cloud_config
    audio = tmp_path / "audio.flac"
    audio.write_bytes(b"mock-audio")
    segment = {"start": 0, "end": 2, "text": "mock云端"} | {field: value}
    calls = []

    def cloud(*args):
        calls.append("cloud")
        return {"segments": [segment]}

    def local(*args):
        calls.append("local")
        return {"segments": [{"start": 0, "end": 2.5, "text": "mock本地"}]}

    result = t.transcribe_audio(audio, 3, config, tmp_path, key=key, now=1001,
                                cloud_fn=cloud, local_fn=local)
    assert calls == ["cloud", "local"]
    assert result["backend"] == "local"
    assert 3 - result["segments"][-1]["end"] == 0.5
    with pytest.raises(ValueError):
        t.validate_segments([segment], 3)


def test_valid_numeric_timestamps_keep_mock_cloud_result(tmp_path, mock_cloud_config):
    import transcript as t
    key, config = mock_cloud_config
    audio = tmp_path / "audio.flac"
    audio.write_bytes(b"mock-audio")
    segments = [{"start": 0, "end": 1.5, "text": "mock云端"},
                {"start": 1.5, "end": 2, "text": "末段"}]
    (tmp_path / "cloud-usage.json").write_text(
        json.dumps([{"time": 0, "seconds": 0}, {"time": 1000.5, "seconds": 10.5}]), encoding="utf-8")
    result = t.transcribe_audio(audio, 3, config, tmp_path, key=key, now=1001,
                                cloud_fn=lambda *a: {"segments": segments},
                                local_fn=lambda *a: pytest.fail("合法 mock 云端结果不得回退"))
    assert result["backend"] == "cloud"
    assert result["segments"] == segments
    assert 3 - result["segments"][-1]["end"] == 1


@pytest.mark.parametrize("key_mode, changes, expected", [
    ("missing", {}, False), ("changed", {}, False), ("same", {"confirmed_key_sha256": "wrong"}, False),
    *[("same", {"free_plan_confirmed_at": value}, False) for value in
      (True, "1000", None, float("nan"), float("inf"), -1, 1002, 1001 - 7 * 86400)],
    ("same", {}, True),
])
def test_doctor_checks_mock_key_confirmation(monkeypatch, tmp_path, mock_cloud_config,
                                             key_mode, changes, expected):
    import transcribe as cli
    key, config = mock_cloud_config
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setattr(cli, "load_config", lambda: config | {"local_model": "small", "device": "cpu"} | changes)
    monkeypatch.setattr(cli.time, "time", lambda: 1001)
    if key_mode == "missing":
        monkeypatch.delenv("GROQ_API_KEY", raising=False)
    else:
        monkeypatch.setenv("GROQ_API_KEY", key if key_mode == "same" else "mock-changed-key")
    assert cli.doctor()["free_confirmation_current"] is expected


@pytest.fixture
def mock_job(tmp_path, monkeypatch):
    """隔离 CLI I/O，媒体解析与识别均为 mock，不访问网络。"""
    import media
    import transcribe as cli
    from types import SimpleNamespace
    source = tmp_path / "source.wav"
    source.write_bytes(b"original-source")
    args = SimpleNamespace(source=str(source), output=str(tmp_path / "output"), local=True,
                           language=None, model=None, title="测试逐字稿", cookies_file=None)
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setattr(cli, "load_config", lambda: {"cloud_enabled": False})

    def resolve(source_arg, job, **kwargs):
        return {"path": source, "duration": 3, "title": "测试逐字稿",
                "source": source_arg, "platform": "local"}

    def normalize(source_arg, audio):
        audio.write_bytes(b"mock-audio")
        return 3

    monkeypatch.setattr(media, "resolve_input", resolve)
    monkeypatch.setattr(cli, "normalize_audio", normalize)
    monkeypatch.setattr(cli, "transcribe_audio", lambda *a, **kw: {
        "backend": "local", "model": "small", "language": "zh", "route_reason": "mock本地",
        "segments": [{"start": 0, "end": 2, "text": "测试原话"}]})
    return cli, args, source


def test_json_write_failure_leaves_no_final_markdown(mock_job, monkeypatch):
    cli, args, source = mock_job
    write_text = Path.write_text

    def fail_completed_json(path, data, *a, **kw):
        if data.startswith("{") and json.loads(data).get("status") == "completed":
            write_text(path, "partial-json", *a, **kw)
            raise OSError("mock JSON write failure")
        return write_text(path, data, *a, **kw)

    monkeypatch.setattr(Path, "write_text", fail_completed_json)
    with pytest.raises(OSError, match="mock JSON write failure"):
        cli.run_job(args)
    assert not list(Path(args.output).rglob("*.md"))
    assert not list(Path(args.output).rglob("*.pending*"))
    assert source.read_bytes() == b"original-source"
    manifest, = Path(args.output).rglob("result.json")
    assert json.loads(manifest.read_text("utf-8"))["status"] == "failed"


@pytest.mark.parametrize("failed_target", [None, "result.json", "测试逐字稿.md"])
def test_job_commits_outputs_with_atomic_replace(mock_job, monkeypatch, failed_target):
    cli, args, source = mock_job
    replace = cli.os.replace
    events = []

    def replace_output(pending, target):
        pending, target = Path(pending), Path(target)
        assert pending.parent == target.parent
        assert pending != target and pending.is_file()
        assert not target.exists()
        content = pending.read_text("utf-8")
        if target.suffix == ".json" and json.loads(content)["status"] == "failed":
            return replace(pending, target)
        events.append(target.name)
        if target.name == failed_target:
            raise OSError("mock atomic replace failure")
        return replace(pending, target)

    monkeypatch.setattr(cli.os, "replace", replace_output)
    if failed_target:
        with pytest.raises(OSError, match="mock atomic replace failure"):
            cli.run_job(args)
        assert not list(Path(args.output).rglob("*.md"))
        manifest, = Path(args.output).rglob("result.json")
        assert json.loads(manifest.read_text("utf-8"))["status"] == "failed"
    else:
        result = cli.run_job(args)
        assert set(events) == {"测试逐字稿.md", "result.json"}
        manifest = json.loads(Path(result["manifest"]).read_text("utf-8"))
        assert manifest["status"] == "completed"
        assert manifest["source"] == str(source)
        assert manifest["markdown_path"] == result["markdown"]
        assert "测试原话" in Path(result["markdown"]).read_text("utf-8")
    assert not list(Path(args.output).rglob("*.pending*"))
    assert source.read_bytes() == b"original-source"


@pytest.mark.parametrize("status_failure", [None, "write", "replace"])
def test_failed_status_is_atomic_and_keeps_original_error(mock_job, monkeypatch, status_failure):
    cli, args, source = mock_job
    original = RuntimeError("original transcription failure")
    writes = []
    replacements = []
    write_text, replace = Path.write_text, cli.os.replace

    def transcribe(*a, **kw):
        raise original

    def write_status(path, data, *a, **kw):
        writes.append(path)
        if status_failure == "write":
            write_text(path, "partial-status", *a, **kw)
            raise OSError("mock status write failure")
        return write_text(path, data, *a, **kw)

    def replace_status(pending, target):
        replacements.append((pending, target))
        assert pending != target and Path(pending).parent == Path(target).parent
        assert json.loads(Path(pending).read_text("utf-8"))["status"] == "failed"
        if status_failure == "replace":
            raise OSError("mock status replace failure")
        return replace(pending, target)

    monkeypatch.setattr(cli, "transcribe_audio", transcribe)
    monkeypatch.setattr(Path, "write_text", write_status)
    monkeypatch.setattr(cli.os, "replace", replace_status)
    with pytest.raises(RuntimeError) as error:
        cli.run_job(args)
    assert error.value is original
    assert len(writes) == 1 and writes[0].name != "result.json"
    assert len(replacements) == (0 if status_failure == "write" else 1)
    manifests = list(Path(args.output).rglob("result.json"))
    assert len(manifests) == (1 if status_failure is None else 0)
    assert not list(Path(args.output).rglob("*.md"))
    assert not list(Path(args.output).rglob("*.pending*"))
    assert source.read_bytes() == b"original-source"


def test_job_redacts_signed_source_url_with_mock_media(mock_job):
    cli, args, source = mock_job
    args.source = "https://example.com:8443/watch?token=mock-secret&v=dQw4w9WgXcQ&p=2&cookie=mock-cookie"
    result = cli.run_job(args)
    expected = "https://example.com:8443/watch?v=dQw4w9WgXcQ&p=2"
    manifest_text = Path(result["manifest"]).read_text("utf-8")
    markdown = Path(result["markdown"]).read_text("utf-8")
    assert json.loads(manifest_text)["source"] == expected
    assert expected in markdown
    for content in (manifest_text, markdown):
        assert "mock-secret" not in content
        assert "mock-cookie" not in content
        assert "token=" not in content
    assert source.read_bytes() == b"original-source"


def test_markdown_preserves_words_and_timestamps():
    assert importlib.util.find_spec("transcript") is not None, "需要实现逐字稿渲染模块"
    from transcript import render_markdown
    text = render_markdown({
        "title": "测试录音", "source": "录音.mp3", "duration": 12.5,
        "backend": "local", "model": "small", "language": "zh",
        "segments": [{"start": 0.5, "end": 3.2, "text": "嗯，这个，这个是原话。"},
                     {"start": 6.0, "end": 10.2, "text": "收入增长了12.5%。"}],
    })
    assert "嗯，这个，这个是原话。" in text
    assert "收入增长了12.5%。" in text
    assert "00:00:00.500" in text
    assert "00:00:10.200" in text
    assert "机器转录，未经人工校对" in text
    assert "测试录音" in text


def test_free_cloud_requires_confirmed_key_and_limits(tmp_path):
    import transcript as t
    import hashlib
    assert hasattr(t, "cloud_decision"), "需要实现免费云端准入规则"
    key = "unit-test-placeholder"
    config = {"cloud_enabled": True, "confirmed_key_sha256": hashlib.sha256(key.encode()).hexdigest(),
              "free_plan_confirmed_at": 1000}
    params = dict(config=config, key=key, size=1000, duration=60, usage=[], now=1001)
    assert t.cloud_decision(**params)[0] is True
    for changes in ({"key": ""}, {"key": "different"}, {"size": 25_000_000},
                    {"duration": 7201}, {"now": 1000 + 8 * 86400},
                    {"config": {}}, {"duration": float("nan")}):
        assert t.cloud_decision(**(params | changes))[0] is False
    assert t.cloud_decision(**(params | {"usage": [{"time": 1000, "seconds": 7190}]}))[0] is False
    assert t.cloud_decision(**(params | {"usage": [{"time": 1000, "seconds": 10}] * 20}))[0] is False
    assert t.cloud_decision(**(params | {"usage": [{"time": 1000, "seconds": 30000}]}))[0] is False


def test_cloud_error_falls_back_to_complete_local_result(tmp_path):
    import transcript as t
    import hashlib
    assert hasattr(t, "transcribe_audio"), "需要实现云端失败后的本地转写"
    audio = tmp_path / "test.flac"
    audio.write_bytes(b"unit-test-audio-placeholder")
    key = "unit-test-placeholder"
    config = {"cloud_enabled": True, "confirmed_key_sha256": hashlib.sha256(key.encode()).hexdigest(),
              "free_plan_confirmed_at": 1000}
    calls = []
    def cloud(*args, **kwargs):
        calls.append("cloud")
        raise RuntimeError("HTTP 429")
    def local(*args, **kwargs):
        calls.append("local")
        return {"segments": [{"start": 0, "end": 2, "text": "本地测试结果"}], "language": "zh"}
    result = t.transcribe_audio(audio, 3, config, tmp_path, key=key, now=1001,
                                cloud_fn=cloud, local_fn=local)
    assert calls == ["cloud", "local"]
    assert result["backend"] == "local"
    assert "云端" in result["route_reason"]
    assert result["segments"][0]["text"] == "本地测试结果"
    assert (tmp_path / "cloud-usage.json").exists()


def test_unconfirmed_cloud_never_receives_audio(tmp_path):
    import transcript as t
    audio = tmp_path / "test.flac"
    audio.write_bytes(b"unit-test-audio-placeholder")
    def cloud(*args, **kwargs):
        raise AssertionError("未经确认不得上传")
    def local(*args, **kwargs):
        return {"segments": [{"start": 0, "end": 2, "text": "本地测试"}], "language": "zh"}
    result = t.transcribe_audio(audio, 3, {}, tmp_path, key="", now=1001,
                                cloud_fn=cloud, local_fn=local)
    assert result["backend"] == "local"


def test_empty_or_invalid_segments_never_become_success(tmp_path):
    import transcript as t
    import pytest
    assert hasattr(t, "validate_segments"), "需要验证逐字稿片段"
    for segments in ([], [{"start": 2, "end": 1, "text": "坏时间"}],
                     [{"start": 0, "end": float("nan"), "text": "坏时间"}],
                     [{"start": 0, "end": 10, "text": "超出时长"}],
                     [{"start": 0, "end": 1, "text": ""}]):
        with pytest.raises(ValueError):
            t.validate_segments(segments, 3)
    assert t.validate_segments([{"start": 0, "end": 2, "text": "原话"}], 3)


def test_groq_request_is_fixed_endpoint_and_handles_response(tmp_path, monkeypatch):
    import transcript as t
    import requests
    import pytest
    assert hasattr(t, "groq_transcribe"), "需要实现 Groq 转写接口"
    audio = tmp_path / "test.flac"
    audio.write_bytes(b"test-fixture")
    calls = []
    def fake_post(url, **kw):
        calls.append((url, kw))
        assert kw["files"]["file"][1].read() == b"test-fixture"
        class Response:
            status_code = 200
            def json(self):
                return {"segments": [{"start": 0, "end": 2, "text": "测试返回"}], "language": "zh"}
            def raise_for_status(self):
                return None
        return Response()
    monkeypatch.setattr(requests, "post", fake_post)
    result = t.groq_transcribe(audio, {"language": "zh"}, "unit-placeholder")
    assert result["segments"][0]["text"] == "测试返回"
    assert calls[0][0] == "https://api.groq.com/openai/v1/audio/transcriptions"
    assert calls[0][1]["allow_redirects"] is False
    assert calls[0][1]["data"]["response_format"] == "verbose_json"
    with pytest.raises(ValueError):
        t.groq_transcribe(audio, {"cloud_model": "paid-unapproved-model"}, "unit-placeholder")


def test_real_local_audio_decoding(generated_media):
    from faster_whisper.audio import decode_audio
    waveform = decode_audio(str(generated_media[0]))
    assert len(waveform) > 16000


def test_local_adapter_exhausts_generator_and_preserves_text(tmp_path, monkeypatch):
    import transcript as t
    from types import SimpleNamespace
    import faster_whisper
    assert hasattr(t, "local_transcribe"), "需要实现本地识别接口"
    events = []
    class Model:
        def __init__(self, model, **kw):
            assert model == "small"
            assert kw["device"] == "cpu"
            assert kw["compute_type"] == "int8"
        def transcribe(self, audio, **kw):
            assert kw["vad_filter"] is False
            def generate():
                events.append("first")
                yield SimpleNamespace(start=0, end=2, text="嗯，嗯，原话。")
                events.append("last")
                yield SimpleNamespace(start=2, end=4, text="第二段。")
            return generate(), SimpleNamespace(language="zh")
    monkeypatch.setattr(faster_whisper, "WhisperModel", Model)
    r = t.local_transcribe(tmp_path / "audio.flac", {"model_dir": str(tmp_path)})
    assert events == ["first", "last"]
    assert r["segments"][0]["text"] == "嗯，嗯，原话。"


def test_invalid_cloud_payload_also_triggers_local(tmp_path):
    import transcript as t
    import hashlib
    key = "unit-placeholder"
    cfg = {"cloud_enabled": True, "free_plan_confirmed_at": 1000,
           "confirmed_key_sha256": hashlib.sha256(key.encode()).hexdigest()}
    audio = tmp_path / "a.flac"
    audio.write_bytes(b"fixture")
    r = t.transcribe_audio(audio, 3, cfg, tmp_path, key=key, now=1001,
        cloud_fn=lambda *a: {"segments": [], "language": "zh"},
        local_fn=lambda *a: {"segments": [{"start": 0, "end": 2, "text": "本地"}], "language": "zh"})
    assert r["backend"] == "local"


def test_normalize_real_mp4_to_complete_flac(tmp_path, generated_media):
    import transcript as t
    import subprocess
    import json
    assert hasattr(t, "normalize_audio"), "需要实现完整音轨提取"
    source = generated_media[1]
    output = tmp_path / "audio.flac"
    duration = t.normalize_audio(source, output)
    data = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(output)]))
    stream = data["streams"][0]
    assert stream["codec_name"] == "flac"
    assert stream["sample_rate"] == "16000"
    assert stream["channels"] == 1
    assert abs(float(data["format"]["duration"]) - duration) < 0.1
    assert duration > 5


def test_cli_help_and_invalid_input(tmp_path):
    import shutil
    import subprocess
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    for source in (ROOT / "scripts").glob("*.py"):
        shutil.copyfile(source, scripts / source.name)
    cli = scripts / "transcribe.py"
    # 子进程启动前确认隔离，回归失败也不得写实际项目状态。
    assert cli.is_relative_to(tmp_path)
    assert cli.is_file(), "需要实现 skill 命令入口"
    p = subprocess.run([sys.executable, str(cli), "--help"], cwd=tmp_path,
                       capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert p.returncode == 0
    assert "transcribe" in p.stdout
    p = subprocess.run([sys.executable, str(cli), "doctor"], cwd=tmp_path,
                       capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert p.returncode == 0
    status = json.loads(p.stdout)
    assert status["project"] == str(tmp_path)
    assert status["cloud_enabled"] is False
    assert status["groq_key_present"] is False
    p = subprocess.run([sys.executable, str(cli), "transcribe", "missing-file.mp3",
                        "--output", str(tmp_path / "output")], cwd=tmp_path,
                       capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert p.returncode != 0
    assert not list(tmp_path.rglob("*.md"))
    assert (tmp_path / ".state").is_dir()
    manifest, = (tmp_path / "output").rglob("result.json")
    assert json.loads(manifest.read_text("utf-8"))["status"] == "failed"


def test_doctor_and_cloud_confirmation_need_key(monkeypatch, tmp_path):
    import transcribe as cli
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    status = cli.doctor()
    assert status["cloud_enabled"] is False
    assert status["groq_key_present"] is False
    monkeypatch.setattr(sys, "argv", ["transcribe.py", "configure-cloud", "--confirm-free-plan"])
    assert cli.main() == 1
    assert not (tmp_path / "config.json").exists()
    monkeypatch.setenv("GROQ_API_KEY", "unit-only-placeholder")
    assert cli.main() == 0
    config = cli.load_config()
    assert config["cloud_enabled"] is True
    assert "unit-only-placeholder" not in (tmp_path / "config.json").read_text("utf-8")


def test_corrupt_usage_fails_closed_to_local(tmp_path):
    import transcript as t
    (tmp_path / "cloud-usage.json").write_text("corrupt", encoding="utf-8")
    audio = tmp_path / "audio.flac"
    audio.write_bytes(b"fixture")
    r = t.transcribe_audio(audio, 3, {}, tmp_path,
        cloud_fn=lambda *a: (_ for _ in ()).throw(AssertionError("不得上传")),
        local_fn=lambda *a: {"segments": [{"start": 0, "end": 2, "text": "本地"}], "language": "zh"})
    assert r["backend"] == "local"
