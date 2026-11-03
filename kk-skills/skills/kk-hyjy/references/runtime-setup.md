# audio-transcript

平台链接或本地音视频 → 完整音轨 → 带时间戳的 Markdown 逐字稿。

支持 YouTube、B站、小宇宙和本地媒体。默认本地 Whisper small，也可启用 Groq。已在 Windows／Python 3.14 实测；其他环境尚未实机验收。平台访问受内容权限和网络环境影响，YouTube 可能需要登录 Cookie。

## 安装

需要 Python 3.11+、[FFmpeg／ffprobe](https://ffmpeg.org/download.html)；YouTube 需要 [Node.js 22+](https://nodejs.org/en/download)，工具须在 PATH 中。

在项目目录执行，`prepare-model` 会下载模型：

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r scripts/requirements.txt
.venv/Scripts/python.exe scripts/transcribe.py prepare-model
.venv/Scripts/python.exe scripts/transcribe.py doctor
```

模型从 Hugging Face 下载至 `models/`，成功返回 `status=ready`。`doctor` 中 FFmpeg／ffprobe 应显示路径，`model_files_present` 应为 `true`；YouTube 另执行 `node --version`。实际可用性以完成一次转写为准。

Linux／macOS 使用 `.venv/bin/python`。本运行程序随 `kk-hyjy` 分发；在当前技能目录执行以上命令，新会话加载 `kk-hyjy`。

## 使用

```bash
.venv/Scripts/python.exe scripts/transcribe.py transcribe "链接或文件路径"
```

| 参数 | 用途 |
|---|---|
| `--local` | 强制本地识别 |
| `--language zh` | 指定语言，默认自动识别 |
| `--model small` | 使用已下载的本地模型 |
| `--cookies-file "路径"` | 使用明确授权的 Netscape Cookie 文件 |
| `--title "标题"` | 设置标题 |
| `--output "目录"` | 设置输出父目录 |

结果保存在 `output/` 的独立目录：完整音轨、`result.json`、带时间戳的 `.md`。逐字稿保持识别原文；专业名词、数字和多人重叠语音需要听音校对。

仅下载时，可调用 `scripts/media.py` 的 `resolve_input(source, job_dir, cookies_file=None)`，返回媒体路径及探测时长。

Cookie 文件仅导出目标平台，保存在本地，以普通文本提供路径，勿上传或粘贴内容。账号用于自动下载存在平台限制风险。本工具用于个人本地处理可信来源，不提供面向匿名 URL 的网络隔离。

## 可选 Groq

通过安全设置配置环境变量 `GROQ_API_KEY`。确认免费套餐并同意上传音频后执行：

```bash
.venv/Scripts/python.exe scripts/transcribe.py configure-cloud --confirm-free-plan
```

启用状态保存在本地，后续任务在确认有效期内可上传音频。敏感媒体使用 `--local`。确认绑定当前密钥，有效期7天；完整音轨超限、额度不足或接口异常时回退本地。套餐变化需重新核实，脚本不保证服务费用。

## 测试

```bash
.venv/Scripts/python.exe -m pip install pytest ruff
.venv/Scripts/python.exe -m pytest -q
.venv/Scripts/python.exe -m ruff check scripts tests
```

测试自动生成音频样本，云端调用使用测试替身。许可见 [MIT](LICENSE)，来源见 [第三方声明](THIRD_PARTY_NOTICES.md)。
