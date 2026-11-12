# Skills

用于 Hermes Agent 的中文阅读与会议整理技能。

| 技能 | 功能 | 默认交付 |
|---|---|---|
| [结构深读](../../skills/kk-structural-reading/SKILL.md) | 还原观点材料的核心答案、论证推进与原文位置 | 对话中的 Markdown 正文 |
| [会议纪要](../../skills/kk-hyjy/SKILL.md) | 将音视频或文字稿整理为会议纪要、逐字稿或会议实录 | 成品文件；纪要包含「全文结构图、结构深读、逐字稿」 |

## 安装

将仓库中的 `skills/kk-structural-reading/` 和 `skills/kk-hyjy/` 完整复制到当前 Hermes 配置的 `skills/` 目录。使用命名配置时，复制到对应配置的技能目录。保留技能内的 `references/`、`scripts/`、`assets/` 等子目录。

可用 `/kk-structural-reading` 或 `/kk-hyjy` 调用。会议纪要使用结构深读技能整理正文，因此建议两个技能一起安装。

已有文字稿时可直接开始。需要处理音视频时，先按 [转写环境安装说明](../../skills/kk-hyjy/references/runtime-setup.md) 安装 Python 依赖、FFmpeg 和本地模型。YouTube 另需 Node.js；平台访问受权限与网络环境影响。

## 使用示例

```text
/kk-structural-reading 深读这篇材料：[链接或正文]
/kk-hyjy 将这份逐字稿整理成会议纪要：[文件路径]
/kk-hyjy 整理这期播客：[链接]
/kk-hyjy 把这份文字稿整理成会议实录：[文件路径]
```

`kk-structural-reading` 默认输出约两三千字，先给一句话核心答案，再还原核心问题、发声语境与正文论证地图。独立使用时直接在对话中交付，用户要求保存时才生成文档。

`kk-hyjy` 完整读取材料后整理，保留发言顺序、数字、限定和说话人归属。会议纪要的附录默认轻度整理；独立逐字稿默认严格保留。机器识别稿须继续校订，最终内容由助手按技能流程制作。

## 音视频运行环境

- Python 3.11+、FFmpeg／ffprobe。
- 默认使用本地 faster-whisper small、CPU、INT8，首次需准备模型。
- 可选 Groq 默认关闭，启用前需配置自己的密钥、确认套餐并授权上传。
- 已有转写程序在 Windows／Python 3.14 环境实测；其他系统的运行方式见安装说明。
- PDF 汇编按需使用 Hermes 的 `pdf` 技能，网页访问使用 Hermes 现有工具。

音视频运行脚本及回归测试位于 `skills/kk-hyjy/`。在该目录安装运行依赖与 `pytest`、`ruff` 后，可执行：

```bash
python -m pytest -q
python -m ruff check scripts tests
```

运行命令时使用该技能虚拟环境中的 Python。具体准备步骤见安装说明。

## 来源与许可

采用 MIT 许可。结构深读由北圈设计，Hermes Agent 协作整理；转写程序的参考来源与依赖许可见 [第三方声明](THIRD_PARTY_NOTICES.md)。
