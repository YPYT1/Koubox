# 口播匣 / Koubox

本地 GPU 创作者工具箱：多平台视频获取、音频处理、语音识别与精准 SRT 对齐。数据与推理均在本地完成，通过受保护的 `127.0.0.1` HTTP API 供 Electron 桌面端调用。

## 功能一览

| 工具 | 说明 |
|------|------|
| 爆款素材获取 | 链接或本地视频 → 下载 / 抽音 / 人声分离 / ASR 原文（翻译步骤当前关闭） |
| 精准 SRT 对齐 | 音频或视频 + 可选文案 → stable-whisper 对齐，导出标准 SRT |
| 视频下载 | YouTube / TikTok / Instagram / Facebook 公开链接下载 |
| 视频提取音频 | 链接或本地视频 → 高精度 WAV |
| 人声分离 | 本地音频 → Demucs 人声轨 |
| 语音转文字 | 本地音频或视频 → Faster-Whisper 带时间轴原文 |

## 环境要求

- Windows 10/11 x64
- Node.js ≥ 20、pnpm ≥ 9
- NVIDIA GPU + 驱动（人声分离、ASR、精准 SRT 需要 CUDA）
- 约 6 GB 磁盘（便携包解压后；模型另计）

## 开发启动

```bash
pnpm install
pnpm dev
```

开发时工作目录为 `apps/desktop`，模型默认读取仓库根目录 `models/`，输出目录可在「全局设置」修改。

### Python 推理环境

```bash
cd python
# 按 python/README-手动安装Torch.md 创建 .venv 并安装依赖
```

桌面端在开发模式下使用 `python/.venv`；打包后使用 `resources/python`。

### 模型目录

在仓库根目录 `models/` 下放置（不纳入 Git）：

- `faster-whisper-large-v3/` — ASR / 语音转文字 / 爆款素材
- `faster-whisper-large-v3-turbo-int8-ct2/` — 默认 ASR 模型 / 资源不足时的轻量回退模型
- `HYMT21.8B/` — 翻译（当前 UI 未启用）
- `demucs/` — 人声分离（可为空目录，运行时下载权重）

`vendor/` 需包含 `ffmpeg/bin`、`yt-dlp`、`deno`（开发机本地资源，不提交）。

## 常用命令

```bash
pnpm dev              # 启动 Electron 开发版
pnpm typecheck        # 全仓 TypeScript 检查
pnpm test             # core 单元测试（vitest）
pnpm pack:portable    # 便携包：预检 → 打包 → 后检（推荐发布入口）

# 仅预检（改打包脚本后快速验证）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pack-portable.ps1 -SkipPackage

# 六个工具端到端冒烟（需 GPU、turbo 模型、vendor、python venv，以及桌面“文案”目录中的真实口播）
pnpm smoke
```

冒烟默认从 `%USERPROFILE%\Desktop\文案` 自动选择 WAV 与对应 TXT。也可通过
`KOUBOX_SMOKE_FIXTURE_ROOT` 指定素材根目录，或同时设置
`KOUBOX_SMOKE_SPEECH_WAV` 与 `KOUBOX_SMOKE_SOURCE_TEXT` 覆盖单个样本。

**打包注意：** 请使用 `pnpm pack:portable`，不要单独 `pnpm package`。后者跳过预检/后检钩子，易漏文件或运行时依赖。

打包钩子位于 `scripts/pack/hooks/`，清单单一来源为 `scripts/pack/manifests/pack-manifest.json`。

## 项目结构

```
apps/desktop/     Electron + React 桌面壳
packages/core/    本地 API、任务队列、Python worker 调度
packages/shared/  工具清单、配置与 SRT 等共享契约
python/           koubox_runtime（ASR、精准 SRT、Demucs、翻译）
scripts/pack/     便携包预检 / 后检钩子
models/           本地模型（用户自备，不提交）
vendor/           ffmpeg、yt-dlp、deno（用户自备，不提交）
```

## 发布流程（简述）

1. `pnpm typecheck` + `pnpm test`
2. `pnpm smoke`（可选，发布前建议）
3. `pnpm pack:portable`（或 `-SkipPackage` 预检通过后自行 `pnpm package`）
4. 在 `apps/desktop/release/Koubox-x.y.z/` 解压验证六个工具
5. 模型目录保持空壳，由用户按说明放入权重

## 许可证

见各子目录中的 LICENSE 文件。
