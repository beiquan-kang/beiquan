"""下载媒体并生成带时间戳的逐字稿。"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import shutil
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache"
TEMP = CACHE / "tmp"
TEMP.mkdir(parents=True, exist_ok=True)
for name in ("TMPDIR", "TMP", "TEMP"):
    os.environ[name] = str(TEMP)
os.environ["HF_HOME"] = str(CACHE / "huggingface")
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_XET"] = "1"
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

from filelock import FileLock, Timeout  # noqa: E402
from transcript import normalize_audio, transcribe_audio, render_markdown, is_finite_number  # noqa: E402


def groq_key():
    """只在内存读取当前配置的密钥，环境变量优先。"""
    if "GROQ_API_KEY" in os.environ:
        return os.environ["GROQ_API_KEY"].strip()
    home = os.environ.get("HERMES_HOME")
    if not home:
        return ""
    from dotenv import dotenv_values
    try:
        return (dotenv_values(Path(home) / ".env", interpolate=False).get("GROQ_API_KEY") or "").strip()
    except (OSError, UnicodeError, ValueError):
        return ""


def load_config():
    cfg = {"cloud_enabled": False, "local_model": "small", "device": "cpu", "compute_type": "int8",
           "cpu_threads": 8, "cloud_model": "whisper-large-v3-turbo", "language": None}
    path = ROOT / "config.json"
    if path.exists():
        cfg.update(json.loads(path.read_text("utf-8")))
    cfg["model_dir"] = str(ROOT / "models")
    return cfg


def doctor():
    cfg = load_config()
    key = groq_key()
    confirmed = cfg.get("free_plan_confirmed_at")
    confirmation_current = (bool(key) and cfg.get("confirmed_key_sha256") == hashlib.sha256(key.encode()).hexdigest()
                            and is_finite_number(confirmed) and confirmed >= 0
                            and 0 <= time.time() - confirmed < 7 * 86400)
    return {"project": str(ROOT), "python": sys.executable,
            "ffmpeg": shutil.which("ffmpeg"), "ffprobe": shutil.which("ffprobe"),
            "packages": {p: importlib.metadata.version(p) for p in ("faster-whisper", "yt-dlp", "requests")},
            "local_model": cfg["local_model"], "device": cfg["device"],
            "model_files_present": any((ROOT / "models").rglob("model.bin")),
            "groq_key_present": bool(key),
            "cloud_enabled": cfg["cloud_enabled"],
            "free_confirmation_current": confirmation_current}


def run_job(args):
    from media import resolve_input, display_source
    config = load_config()
    if args.local:
        config["cloud_enabled"] = False
    if args.language:
        config["language"] = None if args.language == "auto" else args.language
    if args.model:
        config["local_model"] = args.model
    output = Path(args.output).expanduser().resolve() if args.output else ROOT / "output"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    job = output / f"{stamp}-{uuid.uuid4().hex[:8]}"
    job.mkdir(parents=True, exist_ok=False)
    manifest = job / "result.json"
    written = []
    started = time.monotonic()
    try:
        media = resolve_input(args.source, job, cookies_file=args.cookies_file)
        audio = job / "audio.flac"
        duration = normalize_audio(media["path"], audio)
        if abs(duration - float(media["duration"])) > max(2, float(media["duration"]) * .01):
            raise ValueError("音轨转换前后时长不一致")
        print(json.dumps({"status": "transcribing", "duration": duration}, ensure_ascii=False), flush=True)
        result = transcribe_audio(audio, duration, config, ROOT / ".state", key=groq_key())
        result.update(title=args.title or media["title"], source=display_source(media["source"]), platform=media["platform"],
                      duration=duration, status="completed", created_at=datetime.now(timezone.utc).isoformat(),
                      elapsed_seconds=round(time.monotonic() - started, 2))
        result["warnings"] = ["机器转录，未经人工校对；完成表示引擎已遍历整段音频，准确性仍需校对。"]
        tail = duration - result["segments"][-1]["end"]
        if tail > 30:
            result["warnings"].append(f"末段时间戳与音频结束相隔{tail:.1f}秒，请核对尾部静音或漏识别。")
        name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(result["title"]))[:80].strip(" .") or "逐字稿"
        if name.upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}:
            name = "逐字稿_" + name
        markdown = job / (name + ".md")
        result["markdown_path"] = str(markdown)
        markdown_pending = markdown.with_suffix(".md.pending")
        manifest_pending = manifest.with_suffix(".json.pending")
        written.append(markdown_pending)
        markdown_pending.write_text(render_markdown(result), encoding="utf-8")
        written.append(manifest_pending)
        manifest_pending.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        # Markdown 最后提交；任何前置写入失败都不得留下最终逐字稿。
        os.replace(manifest_pending, manifest)
        written.append(manifest)
        os.replace(markdown_pending, markdown)
        written.append(markdown)
        return {"status": "completed", "backend": result["backend"], "model": result["model"],
                "route_reason": result["route_reason"], "duration": duration,
                "segments": len(result["segments"]), "elapsed_seconds": result["elapsed_seconds"],
                "markdown": str(markdown), "manifest": str(manifest)}
    except Exception as exc:
        for path in reversed(written):
            try:
                path.unlink(missing_ok=True)
            except OSError as cleanup_error:
                exc.add_note(f"清理本次任务输出失败：{type(cleanup_error).__name__}")
        failed_pending = job / "result.failed.pending"
        try:
            failed_pending.write_text(json.dumps({"status": "failed", "error_type": type(exc).__name__}, indent=2),
                                      encoding="utf-8")
            os.replace(failed_pending, manifest)
        except Exception as status_error:
            exc.add_note(f"写入失败状态失败：{type(status_error).__name__}")
        finally:
            try:
                failed_pending.unlink(missing_ok=True)
            except OSError as cleanup_error:
                exc.add_note(f"清理状态临时文件失败：{type(cleanup_error).__name__}")
        raise


def main():
    parser = argparse.ArgumentParser(description="链接或音视频文件 → Markdown 逐字稿")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("doctor", help="检查运行环境")
    prepare = sub.add_parser("prepare-model", help="下载本地模型到项目 models 目录")
    prepare.add_argument("--model", default="small")
    cloud = sub.add_parser("configure-cloud", help="确认当前密钥属于 Groq 免费套餐并授权上传")
    cloud.add_argument("--confirm-free-plan", action="store_true", required=True)
    p = sub.add_parser("transcribe", help="转写完整音轨")
    p.add_argument("source")
    p.add_argument("--output", help="输出父目录，每次任务独立建文件夹")
    p.add_argument("--local", action="store_true", help="强制本地转写")
    p.add_argument("--language", help="zh、en 或 auto")
    p.add_argument("--model", help="已下载的本地模型名称")
    p.add_argument("--title")
    p.add_argument("--cookies-file", help="用户明确授权使用的 Netscape cookie 文件")
    args = parser.parse_args()
    state = ROOT / ".state"
    state.mkdir(exist_ok=True)
    try:
        if args.command == "doctor":
            result = doctor()
        else:
            with FileLock(str(state / "run.lock"), timeout=1):
                if args.command == "prepare-model":
                    from faster_whisper.utils import download_model
                    model_path = download_model(args.model, cache_dir=str(ROOT / "models"))
                    result = {"status": "ready", "model": args.model, "path": model_path}
                elif args.command == "configure-cloud":
                    key = groq_key().strip()
                    if not key:
                        raise ValueError("请先通过安全设置配置 GROQ_API_KEY")
                    cfg = load_config()
                    cfg.pop("model_dir", None)
                    cfg.update(cloud_enabled=True, confirmed_key_sha256=hashlib.sha256(key.encode()).hexdigest(),
                               free_plan_confirmed_at=time.time())
                    temp = ROOT / "config.pending.json"
                    temp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
                    os.replace(temp, ROOT / "config.json")
                    result = {"cloud_enabled": True, "confirmation_days": 7}
                else:
                    result = run_job(args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Timeout:
        print("已有任务正在运行，请在该任务完成后重试。", file=sys.stderr)
        return 2
    except Exception as exc:
        if isinstance(exc, (ValueError, FileNotFoundError)):
            print(f"处理失败：{exc}", file=sys.stderr)
        else:
            print(f"处理失败：{type(exc).__name__}。请检查依赖、网络、文件和本地模型。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
