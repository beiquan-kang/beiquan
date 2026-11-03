"""凭据只在进程内解析，测试使用隔离的假值。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


def test_credential_reads_only_selected_profile_key(tmp_path, monkeypatch):
    import transcribe as cli
    assert hasattr(cli, "groq_key"), "需要读取当前 Hermes 配置中保存的密钥"
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / ".env").write_text('GROQ_API_KEY="fixture-secret"\nUNRELATED=other\n', encoding="utf-8")
    assert cli.groq_key() == "fixture-secret"
    monkeypatch.setenv("GROQ_API_KEY", "environment-fixture")
    assert cli.groq_key() == "environment-fixture"
    monkeypatch.delenv("GROQ_API_KEY")
    monkeypatch.delenv("HERMES_HOME")
    assert cli.groq_key() == ""


def test_credential_file_does_not_expand_other_variables(tmp_path, monkeypatch):
    import transcribe as cli
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("OTHER_SECRET", "unrelated-fixture")
    (tmp_path / ".env").write_text('GROQ_API_KEY="${OTHER_SECRET}"\n', encoding="utf-8")
    assert cli.groq_key() == "${OTHER_SECRET}"


def test_doctor_uses_saved_key(tmp_path, monkeypatch):
    import transcribe as cli
    # 在调用 doctor 前断言隔离，回归失败也不得读取实际配置。
    assert cli.ROOT == tmp_path
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    (tmp_path / ".env").write_text('GROQ_API_KEY="fixture-secret"\n', encoding="utf-8")
    status = cli.doctor()
    assert status["groq_key_present"] is True
    assert status["project"] == str(tmp_path)
    assert status["cloud_enabled"] is False


def test_configure_cloud_uses_saved_key(tmp_path, monkeypatch):
    import transcribe as cli
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    (tmp_path / ".env").write_text('GROQ_API_KEY="fixture-secret"\n', encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["transcribe.py", "configure-cloud", "--confirm-free-plan"])
    assert cli.main() == 0
