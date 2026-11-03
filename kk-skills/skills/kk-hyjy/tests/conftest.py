"""测试隔离凭据，音频样本在项目缓存中生成。"""
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
TEMP = ROOT / ".cache" / "tmp"
TEMP.mkdir(parents=True, exist_ok=True)
for name in ("TMPDIR", "TEMP", "TMP"):
    os.environ[name] = str(TEMP)
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))


@pytest.fixture(autouse=True)
def isolated_credentials(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-test-home"))
    monkeypatch.delenv("GROQ_API_KEY", raising=False)


@pytest.fixture(autouse=True)
def isolated_root(tmp_path, monkeypatch, isolated_credentials):
    """导入后统一隔离配置、模型检查和任务状态；先隔离凭据。"""
    import transcribe as cli
    monkeypatch.setattr(cli, "ROOT", tmp_path)


@pytest.fixture(scope="session")
def generated_media():
    folder = ROOT / ".cache" / "fixtures"
    folder.mkdir(parents=True, exist_ok=True)
    wav, mp4 = folder / "sample.wav", folder / "sample.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
                    "sine=frequency=440:duration=6", "-ar", "16000", "-ac", "1", str(wav)],
                   check=True, capture_output=True, timeout=30)
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(wav),
                    "-c:a", "aac", str(mp4)], check=True, capture_output=True, timeout=30)
    return wav, mp4
