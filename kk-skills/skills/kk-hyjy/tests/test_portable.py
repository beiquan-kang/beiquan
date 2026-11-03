"""分享包的安装与可移植性检查。"""
import ast
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


def test_scripts_support_python_311():
    for path in (ROOT / "scripts").glob("*.py"):
        ast.parse(path.read_text("utf-8"), filename=path.name, feature_version=(3, 11))


def test_prepare_model_uses_project_directory(tmp_path, monkeypatch):
    import transcribe as cli
    import faster_whisper.utils

    calls = []

    def download(model, **kwargs):
        calls.append((model, kwargs))
        return str(tmp_path / "models" / "downloaded")

    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setattr(faster_whisper.utils, "download_model", download)
    monkeypatch.setattr(sys, "argv", ["transcribe.py", "prepare-model"])
    assert cli.main() == 0
    assert calls == [("small", {"cache_dir": str(tmp_path / "models")})]


def test_prepare_custom_model_reports_ready(tmp_path, monkeypatch, capsys):
    import json
    import faster_whisper.utils
    import transcribe as cli

    calls = []
    path = str(tmp_path / "models" / "custom")
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setattr(faster_whisper.utils, "download_model",
                        lambda model, **kw: calls.append((model, kw)) or path)
    monkeypatch.setattr(sys, "argv", ["transcribe.py", "prepare-model", "--model", "base"])
    assert cli.main() == 0
    assert calls == [("base", {"cache_dir": str(tmp_path / "models")})]
    assert json.loads(capsys.readouterr().out) == {"status": "ready", "model": "base", "path": path}


def test_prepare_failure_returns_nonzero(tmp_path, monkeypatch, capsys):
    import faster_whisper.utils
    import transcribe as cli

    def fail(*args, **kwargs):
        raise OSError("test download failure")

    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setattr(faster_whisper.utils, "download_model", fail)
    monkeypatch.setattr(sys, "argv", ["transcribe.py", "prepare-model"])
    assert cli.main() == 1
    assert "ready" not in capsys.readouterr().out

