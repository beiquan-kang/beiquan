"""整文件语音转写，输出可追溯的 Markdown 逐字稿。"""
import json
import hashlib
import math
from pathlib import Path
import os
import time
import subprocess


def normalize_audio(source, output, ffmpeg="ffmpeg", ffprobe="ffprobe"):
    subprocess.run([ffmpeg, "-v", "error", "-nostdin", "-n", "-protocol_whitelist", "file,pipe",
                    "-i", str(source), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000",
                    "-c:a", "flac", str(output)], check=True, capture_output=True, timeout=3600)
    data = json.loads(subprocess.check_output([ffprobe, "-v", "error", "-show_format", "-of", "json",
                                               str(output)], timeout=30))
    duration = float(data["format"]["duration"])
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("音轨时长无效")
    return duration


def validate_segments(segments, duration):
    if not isinstance(segments, list) or not segments:
        raise ValueError("识别结果为空，未生成逐字稿")
    previous = -1
    for seg in segments:
        start, end = seg["start"], seg["end"]
        if not all(map(is_finite_number, (start, end))) or not 0 <= start <= end <= duration + 1:
            raise ValueError("识别时间戳超出音频范围")
        if start < previous or not isinstance(seg.get("text"), str) or not seg["text"].strip():
            raise ValueError("识别片段无效")
        previous = start
    return segments


def groq_transcribe(audio, config, key):
    import requests
    model = config.get("cloud_model", "whisper-large-v3-turbo")
    if model not in ("whisper-large-v3-turbo", "whisper-large-v3"):
        raise ValueError("云端模型未列入免费模型清单")
    data = {"model": model, "response_format": "verbose_json",
            "timestamp_granularities[]": "segment", "temperature": "0"}
    if config.get("language"):
        data["language"] = config["language"]
    with Path(audio).open("rb") as stream:
        response = requests.post("https://api.groq.com/openai/v1/audio/transcriptions",
                                 headers={"Authorization": f"Bearer {key}"},
                                 files={"file": ("audio.flac", stream, "audio/flac")},
                                 data=data, timeout=(20, 300), allow_redirects=False)
    if response.status_code != 200:
        raise RuntimeError(f"Groq HTTP {response.status_code}")
    payload = response.json()
    return {"segments": [{"start": x["start"], "end": x["end"], "text": x["text"]}
                         for x in payload.get("segments", [])],
            "language": payload.get("language", config.get("language", "auto"))}


def local_transcribe(audio, config):
    from faster_whisper import WhisperModel
    model = WhisperModel(config.get("local_model", "small"),
                         device=config.get("device", "cpu"), compute_type=config.get("compute_type", "int8"),
                         cpu_threads=config.get("cpu_threads", 8),
                         download_root=config.get("model_dir"), local_files_only=True)
    segments, info = model.transcribe(str(audio), language=config.get("language") or None,
                                      beam_size=5, vad_filter=False, condition_on_previous_text=True)
    rows = []
    for seg in segments:
        if seg.text.strip():
            rows.append({"start": float(seg.start), "end": float(seg.end), "text": seg.text.strip()})
    return {"segments": rows, "language": info.language}


def transcribe_audio(audio, duration, config, state_dir, *, key="", now=None,
                     cloud_fn=None, local_fn=None):
    cloud_fn = cloud_fn or groq_transcribe
    local_fn = local_fn or local_transcribe
    now = time.time() if now is None else now
    state_dir = Path(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    usage_file = state_dir / "cloud-usage.json"
    reason = "额度记录无法读取"
    usage = []
    try:
        usage = json.loads(usage_file.read_text("utf-8")) if usage_file.exists() else []
        allowed, reason = cloud_decision(config, key, Path(audio).stat().st_size, duration, usage, now)
    except (OSError, ValueError, TypeError, KeyError):
        allowed = False
    backend = "local"
    result = None
    if allowed:
        try:
            usage = [r for r in usage if now - r["time"] < 86400]
            usage.append({"time": now, "seconds": max(10, duration)})
            pending = usage_file.with_suffix(".tmp")
            pending.write_text(json.dumps(usage), encoding="utf-8")
            os.replace(pending, usage_file)
            result = cloud_fn(audio, config, key)
            validate_segments(result["segments"], duration)
            backend = "cloud"
        except Exception as exc:
            result = None
            reason = f"云端未完成，转为本地识别（{type(exc).__name__}）"
    if result is None:
        result = local_fn(audio, config)
        validate_segments(result["segments"], duration)
    result.update(backend=backend, route_reason=reason,
                  model=config.get("cloud_model", "whisper-large-v3-turbo") if backend == "cloud"
                  else config.get("local_model", "small"))
    return result


def is_finite_number(value):
    return type(value) in (int, float) and -math.inf < value < math.inf


def cloud_decision(config, key, size, duration, usage, now):
    if not is_finite_number(now) or now < 0:
        return False, "当前时间无效"
    if not isinstance(usage, list) or any(
        not isinstance(row, dict)
        or not is_finite_number(row.get("time")) or not 0 <= row["time"] <= now
        or not is_finite_number(row.get("seconds")) or row["seconds"] < 0
        for row in usage
    ):
        return False, "额度记录无效，本次使用本地识别"
    if config.get("cloud_enabled") is not True or not key:
        return False, "免费云端未启用或未配置密钥"
    if config.get("confirmed_key_sha256") != hashlib.sha256(key.encode()).hexdigest():
        return False, "当前密钥对应的免费套餐尚未确认"
    confirmed = config.get("free_plan_confirmed_at")
    if not is_finite_number(confirmed) or confirmed < 0 or not 0 <= now - confirmed < 7 * 86400:
        return False, "免费套餐确认已过期"
    if size <= 0 or size >= 24_000_000:
        return False, "音轨大小超过免费档安全阈值"
    if not math.isfinite(duration) or duration <= 0:
        return False, "音频时长无效"
    billable = max(10, duration)
    hourly = [r for r in usage if now - r["time"] < 3600]
    daily = [r for r in usage if now - r["time"] < 86400]
    if sum(r["seconds"] for r in hourly) + billable > 7200:
        return False, "本地记录的每小时免费额度不足"
    if sum(r["seconds"] for r in daily) + billable > 28800:
        return False, "本地记录的每日免费额度不足"
    if len([r for r in daily if now - r["time"] < 60]) >= 20 or len(daily) >= 2000:
        return False, "本地记录的免费请求次数已用尽"
    return True, "文件与本地额度记录满足免费条件"


def timestamp(seconds):
    ms = max(0, round(float(seconds) * 1000))
    hours, ms = divmod(ms, 3600000)
    minutes, ms = divmod(ms, 60000)
    seconds, ms = divmod(ms, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{ms:03d}"


def render_markdown(result):
    keys = ("title", "source", "duration", "backend", "model", "language")
    front = ["---"] + [f"{k}: {json.dumps(result.get(k), ensure_ascii=False)}" for k in keys]
    front += ["review_status: 机器转录，未经人工校对", "---", "", f"# {result['title']}", "",
              "> 机器转录，未经人工校对。专业名称、数字和听辨困难的内容请结合原音频核对。", ""]
    for seg in result["segments"]:
        front += [f"**[{timestamp(seg['start'])} → {timestamp(seg['end'])}]**", "", seg["text"].strip(), ""]
    return "\n".join(front)
