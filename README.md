# 口播匣 / Koubox

本地 GPU 创作者工具箱：多平台视频获取、音频处理、语音识别、精准 SRT 对齐，以及文案库与局域网分享。  
数据与推理默认在本机完成；Electron 桌面端通过 `127.0.0.1` HTTP API 调用 `packages/core` 与 Python 运行时。

当前版本：**0.9.1** · 仅支持 **Windows 10/11 x64** · 包管理器锁定 **pnpm@11**。

---

## 功能一览

### 创作工具

| 工具 | 输入 | 产出 | 说明 |
|------|------|------|------|
| 爆款素材获取 | 链接或本地视频 | 下载 / 抽音 / 人声 / ASR 原文 | 识别后可手动翻译为简中 |
| 精准 SRT 对齐 | 音频或视频 + 可选文案 | 标准 SRT | stable-whisper；质量不足时可回退 Large v3 |
| 视频下载 | YouTube / TikTok / Instagram / Facebook / Bilibili | 视频文件 | 原生 playurl 优先，失败回退 `yt-dlp` |
| 视频提取音频 | 链接或本地视频 | 高精度 WAV | 无音轨视频会完成并提示 |
| 去除背景音乐 | 本地音频 | Demucs 人声轨 | 需要 CUDA |
| 语音转文字 | 本地音频或视频 | 带时间轴原文 | Faster-Whisper；默认 turbo，可回退 Large v3 |

### 文案库与局域网分享

| 能力 | 说明 |
|------|------|
| 文案库 | 本地 SQLite 保存原文 / 译文 / 转写；支持标签、检索、从任务结果入库 |
| 局域网发现 | 同网段设备互相可见（别名 + 指纹） |
| 一键分享 | 选中文案发送到对端；对端确认后写入本地文案库 |
| 传输记录 | 发送 / 接收状态、进度与错误可在界面查看 |

### 授权

桌面端通过远端许可证服务校验 Token / API Key（含宽限期与休眠后补偿验证）。  
开发时可在根目录 `.env` 配置 `KOUBOX_LICENSE_*`（见 `.env.example`）；授权地址须为远端，禁止 localhost。

---

## 架构速览

```text
apps/desktop (Electron + React，液态玻璃 UI / shadcn)
        │  HTTP 127.0.0.1
        ▼
packages/core（任务队列 / 本地 API / 文案库 / LAN 分享 / worker）
        │
        ├── packages/license-client（授权客户端）
        ├── packages/shared（工具契约、配置、SRT、文案库 / LAN 类型）
        ├── vendor/{ffmpeg,yt-dlp,deno}
        ├── models/{faster-whisper-*, demucs, …}
        └── python/.venv → koubox_runtime（ASR / 精准 SRT / Demucs）
```

---

## 环境要求

| 类别 | 要求 |
|------|------|
| 系统 | Windows 10/11 x64 |
| Node | Node.js ≥ 20，pnpm ≥ 9（推荐仓库锁定的 pnpm 11） |
| Python | **3.12 x64**（`python/` 用 uv；不要用 3.11 / 3.13） |
| GPU | NVIDIA + 兼容驱动（人声分离 / ASR / 精准 SRT 需要 CUDA） |
| 磁盘 | 便携包解压约 6 GB；模型另计（仅 ASR 常见数 GB～十余 GB） |

纯下载 / 抽音可在无 CUDA 时部分使用；完整工具链建议有可用 GPU。  
局域网分享仅依赖本机 HTTP 与同网段可达，不依赖 GPU。

---

## 从零跑通（开发机）

按顺序做完即可 `pnpm dev`。任一步失败应停下排查，不要跳过。

### 1. 克隆与 Node 依赖

```powershell
git clone <本仓库 URL>
cd Koubox
pnpm install
```

可选：复制 `.env.example` 为根目录 `.env`，调整日志与授权相关变量。

### 2. 准备 `vendor/`（不纳入 Git）

```text
vendor/
  ffmpeg/bin/ffmpeg.exe
  ffmpeg/bin/ffprobe.exe
  yt-dlp/yt-dlp.exe
  deno/deno.exe
```

打包预检会校验上述路径；开发机若用 Junction，`pnpm pack:portable` 的 after-pack 会解引用为实体目录再打进包。

### 3. 准备 `models/`（不纳入 Git）

| 目录 | 用途 |
|------|------|
| `faster-whisper-large-v3-turbo-int8-ct2/` | **默认 ASR**；冒烟与资源不足时的轻量模型 |
| `faster-whisper-large-v3/` | 完整 ASR / 对齐回退 |
| `demucs/` | 去除背景音乐（可先建空目录，运行时再下权重） |
| `nllb-200-distilled-600M-multilang-ft-ct2/` | 翻译（日 / 英 / 韩 → 简中，手动触发） |

开发时默认读取仓库根目录 `models/`；输出目录可在桌面端「全局设置」中修改。

### 4. 安装 Python 推理环境

固定使用 **CUDA 版 Torch wheel**。完整步骤见：

→ [`python/README-手动安装Torch.md`](python/README-手动安装Torch.md)

摘要：

```powershell
# 1) 从 https://download.pytorch.org/whl/cu128/ 下载
#    torch-2.11.0+cu128-cp312-cp312-win_amd64.whl
# 2) 放到 python/wheels/
cd python
uv sync --python 3.12
.\.venv\Scripts\python.exe -m pip install --no-deps .\wheels\torch-2.11.0+cu128-cp312-cp312-win_amd64.whl
.\.venv\Scripts\python.exe -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

最后一条应打印 CUDA 版 torch、`True` 与显卡名称。  
桌面端：**开发**用 `python/.venv`；**打包后**用包内 `resources/python`。

### 5. 启动

```powershell
pnpm dev
```

开发工作目录为 `apps/desktop`。缺模型 / 缺 ffmpeg / CUDA 不可用时，回到第 2～4 步核对。

---

## 常用命令

```powershell
pnpm dev              # Electron 开发版
pnpm typecheck        # 全仓 TypeScript
pnpm test             # @koubox/core 单元测试（vitest）
pnpm smoke            # 六工具端到端冒烟
pnpm pack:portable    # 便携包：预检 → 打包 → 后检（推荐发布入口）
```

文案库 / 局域网相关快速校验：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-copy-library-lan.ps1
```

仅跑打包预检（不真正出包）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pack-portable.ps1 -SkipPackage
```

**请使用 `pnpm pack:portable`，不要单独 `pnpm package`。**  
后者会跳过预检 / 后检，容易漏 vendor、python 或运行时文件。

钩子：`scripts/pack/hooks/` · 清单：`scripts/pack/manifests/pack-manifest.json`。

---

## 项目结构

```text
apps/desktop/             Electron + React 桌面壳
packages/core/            本地 API、任务队列、文案库、LAN、Python worker
packages/shared/          工具清单、配置、SRT、文案库 / LAN 契约
packages/license-client/  授权客户端
python/                   koubox_runtime（ASR、精准 SRT、Demucs、翻译）
scripts/pack/             便携包预检 / 后检钩子
scripts/                  pack-portable、smoke-six-tools、smoke-copy-library-lan 等
docs/                     需求、计划、技术分析、AI 协作任务包
models/                   本地模型（自备，不提交）
vendor/                   ffmpeg、yt-dlp、deno（自备，不提交）
```

---

## 发布流程

1. `pnpm typecheck` 与 `pnpm test`
2. 建议再跑 `pnpm smoke`（需 GPU、turbo 模型、vendor、venv、真实口播素材）
3. 有文案库 / LAN 改动时，再跑 `scripts/smoke-copy-library-lan.ps1`
4. `pnpm pack:portable`
5. 在 `apps/desktop/release/Koubox-x.y.z/` 解压，点验六个工具 + 文案库分享
6. 分发包内模型目录保持空壳说明；由使用者按本文「models/」放入权重

---

## 冒烟测试（维护）

```powershell
pnpm smoke
```

前置：GPU、`models/faster-whisper-large-v3-turbo-int8-ct2`、`vendor`、`python/.venv`，以及默认可找到的口播素材。

| 变量 | 作用 |
|------|------|
| （默认） | 从 `%USERPROFILE%\Desktop\文案` 递归找一对同名 stem 的 `.wav` + `.txt` |
| `KOUBOX_SMOKE_FIXTURE_ROOT` | 改素材根目录 |
| `KOUBOX_SMOKE_SPEECH_WAV` + `KOUBOX_SMOKE_SOURCE_TEXT` | 指定单个 WAV，以及文案字符串或 `.txt` 路径 |
| `KOUBOX_SMOKE_DOWNLOAD_URL` | 覆盖下载冒烟用的公开链接（未设时用内置 TikTok 桩 URL） |

---

## 更多文档

| 路径 | 内容 |
|------|------|
| [`python/README-手动安装Torch.md`](python/README-手动安装Torch.md) | CUDA Torch / uv 环境安装 |
| [`docs/开发计划/`](docs/开发计划/) | 开发计划索引 |
| [`docs/需求分析/`](docs/需求分析/) | 产品需求 |
| [`docs/技术分析/`](docs/技术分析/) | 精准 SRT 等技术笔记 |
| [`docs/AI协作/`](docs/AI协作/) | 任务包与协作规范 |

---

## 许可证

本仓库根目录暂无统一 LICENSE。第三方与 vendored 代码保留各自许可证（例如 `python/src/stable_whisper/LICENSE`）。对外分发前请自行核对依赖与模型许可。
