# 开发方案：Electron 本地软件 + TypeScript 主进程业务

> 对应需求：[[../需求分析/总需求]]、[[../需求分析/爆款视频、音频、文案获取-需求1]]、[[../需求分析/需求 2-精准的srt文件]]、[[../需求分析/需求1和需求2重合部分]]  
> 产品：口播匣（Koubox）  
> 状态：技术方案（可指导建仓与排期）  
> 更新日期：2026-08-21  
> **变更**：桌面壳由 Tauri + Node 侧车改为 **Electron**（主进程即业务进程，不再单独养侧车）

---

## 1. 目标与约束

### 1.1 产品目标

- 交付形态：**本地桌面软件**（非公网 SaaS）
- 先完整交付 **需求 1**（链接 → 视频/音频/文案/译文），再在同架构上做 **需求 2**（精准 SRT）
- 架构：**契约优先流水线**（货物 / 积木 / 流水线），全部能力模块化，需求 = 搭积木

### 1.2 硬约束

| 约束 | 说明 |
| --- | --- |
| 本地 ASR | 模型在本机；启动需做存在性/完整性检测 |
| 下载 | 调用 [yt-dlp](https://github.com/yt-dlp/yt-dlp)，**不重写**其源码 |
| 壳 | **Electron**（Chromium + Node） |
| 业务 | **TypeScript**，写在 **Electron 主进程**（或主进程可加载的 `packages/core`） |
| GPU | 主力 RTX 5070 Ti；备用 2060 |
| 包管理 | 默认 **pnpm**；若 Bun 对主进程/依赖/打包**完整可用**则可采用 Bun |

### 1.3 为何选 Electron（相对原 Tauri 方案）

- 业务本就全是 Node/TS（yt-dlp、ffmpeg、ASR 绑定）→ **不必再起独立侧车进程**
- 原生 addon / ONNX 等与 Electron 主进程兼容面大、联调简单
- 建仓不依赖 Rust / rustup，与当前开发环境更贴

代价：安装包与内存相对 Tauri 更大——对本工具（本就带二进制与模型）可接受。

---

## 2. 总体架构

```
┌──────────────────────────────────────────────┐
│  渲染进程 Renderer（React/Vue + TypeScript + Tailwind CSS） │
│  功能页：需求1 / 模型管理 /（后续）需求2          │
└────────────────────┬─────────────────────────┘
                     │ IPC（推荐）或 localhost HTTP
┌────────────────────▼─────────────────────────┐
│  Electron 主进程 Main（TypeScript）★ 主要开发区 │
│  · 窗口生命周期、菜单、对话框、路径权限            │
│  · runtime → modules → pipelines               │
│  · check_env / check_models                    │
│  · download(yt-dlp) / extract_audio / asr / …  │
│  · 外置二进制路径（yt-dlp、ffmpeg）              │
└──────────────────────────────────────────────┘
                     │
        yt-dlp · ffmpeg · ASR 运行时/模型文件
```

### 2.1 语言分工

| 层 | 语言 | 原则 |
| --- | --- | --- |
| Electron 主进程 | TypeScript | 窗口 + **全部业务流水线**；spawn yt-dlp/ffmpeg；调 ASR |
| 渲染进程 UI | TypeScript | 页面与交互；**不直接** spawn 二进制、不读模型盘符逻辑 |
| 外部引擎 | 二进制 / 绑定 | yt-dlp、ffmpeg；ASR 按选型使用 Node 绑定或子进程 |

能用 TS 写的业务一律写在主进程（或 `packages/core` 被主进程引用）；渲染进程只通过 IPC/API 调能力。

---

## 3. 运行时与包管理：pnpm / Bun

### 3.1 默认方案：Node.js + pnpm

- 包管理、workspace、锁文件统一用 **pnpm**
- 开发态：`electron-vite` / `electron-forge` 等启动主进程 + 渲染进程
- 发布态：`electron-builder`（或等价）打 Windows 安装包；用户机**不需要**自备 Node

**选用理由**

- 与原生 addon（部分 ASR / ONNX 绑定）兼容面最广
- Electron 生态与打包方案成熟
- CI、锁文件、monorepo（`pnpm-workspace`）成熟

### 3.2 可选方案：Bun（需「完整支持」才切换）

Bun 可作为包管理或辅助脚本；**主进程仍建议跑在 Electron 自带的 Node**（原生模块兼容更稳）。

**切换/加深 Bun 的准入条件（全部满足才换默认包管理或脚本）**

| # | 条件 | 说明 |
| --- | --- | --- |
| 1 | 主进程能稳定 spawn yt-dlp / ffmpeg | 子进程、stdio、路径在 Windows 正常 |
| 2 | 选定的 ASR 方案在 Electron 主进程可用 | 原生模块 / ONNX / 子进程方案实测通过 |
| 3 | `electron-builder`（或选定打包器）在 Win x64 通过 | 含 vendor 二进制一并打进包 |
| 4 | 与 Vite 前端工具链不冲突 | `dev` / `build` 脚本跑通 |

任一不满足 → **继续 pnpm + Electron 自带 Node**，不阻塞需求 1。

### 3.3 建议落地策略

1. **建仓即用 pnpm workspace**（desktop 应用 + core 业务 + shared types）  
2. 可选做一次 Bun 作包管理的 spike；主进程仍以 Electron 为准  
3. 通过则文档与脚本注明；不通过则本阶段以 pnpm 为准  

命令约定（pnpm 示例）：

```bash
pnpm install
pnpm --filter @koubox/desktop dev
pnpm --filter @koubox/desktop build
```

---

## 4. 仓库与目录建议（Monorepo）

```
koubox/
  pnpm-workspace.yaml
  package.json
  apps/
    desktop/                 # Electron 工程
      electron/              # 主进程入口（或 src/main）
      src/                   # 渲染进程前端 TS/React
      # 打包配置：electron-builder.yml 等
  packages/
    core/                    # 业务核心 ★（原「侧车」职责）
      src/
        runtime/             # 注册表、check_models、check_env
        artifacts/           # 货物类型（也可放 shared）
        modules/             # download / audio / asr / translate / …
        pipelines/           # req1 / req2
        # 主进程 import core；可选另暴露 CLI 入口
    shared/                  # 前后端共用类型、IPC 契约
  models/                    # 或配置指向外部模型目录（勿强行进 git）
  vendor/                    # 预置 yt-dlp、ffmpeg（随包装）
  docs/                      # 需求/技术文档副本或链接
```

原则：

- **流水线不 import 某个「需求页」**；渲染进程只调 IPC/API  
- **积木不写死模型盘符**；一律走 `runtime` 注册表  
- **yt-dlp 源码不进业务包**；只保留二进制  
- **不单独维护 sidecar 进程**；需要独立调试时，可用同一套 `packages/core` 跑 CLI  

---

## 5. 通信方式（渲染进程 ↔ 主进程）

推荐二选一（实现时锁一个）：

| 方案 | 做法 | 优点 | 注意 |
| --- | --- | --- | --- |
| **A. Electron IPC**（推荐默认） | `ipcMain` / `ipcRenderer`（或 `contextBridge` 暴露安全 API）；长任务用事件推进度 | 无端口、贴 Electron 模型、打包简单 | 定义好共享契约（`packages/shared`） |
| B. 本地 HTTP | 主进程内起 Hono/Fastify 仅监听 `127.0.0.1`；渲染进程 fetch + SSE | 调试可用浏览器工具；与纯 Web 习惯接近 | 端口占用；注意勿对外网开放 |

需求 1 建议先 **A（IPC + 进度事件）**；若团队更熟 REST，可用 B，但业务仍在主进程，不是外挂侧车。

---

## 6. 启动与环境流程

```
用户打开软件
  → Electron 启动（主进程加载 runtime）
  → 自动检测 GPU（显卡名 / CUDA）+ 显存（总量 / 已用 / 剩余）
  → 读取已保存的 ASR 模型路径；未配置则在「模型与环境」提示选择
  → yt-dlp / ffmpeg 使用安装包内置路径（不弹配置、不做「请安装」检测页）
  → ASR 路径有效后，才开放识别类功能
```

「模型与环境」页只暴露：

1. **ASR 模型路径**：选择 / 保存 / 清除  
2. **GPU**：展示自动检测结果（含**显存总量 / 已用 / 剩余**）+ 重新检测  

缺失 ASR 路径时明确提示，禁止静默失败。

---

## 7. 积木与流水线（与需求对齐）

### 7.1 货物（Artifact）

统一 TypeScript 类型（放 `packages/shared`），至少包括：

- `Video` / `Audio` / `Text` / `Transcript` / `Translation` / `SRT`
- **`Transcript` 必须含片段：`{ text, start, end }[]`**

### 7.2 需求 1 流水线

```
URL → download → extract_audio → asr → translate
```

| 积木 | 实现要点 |
| --- | --- |
| `download` | 主进程 `child_process` 调 yt-dlp；输出目录可配置；解析进度 |
| `extract_audio` | 调 ffmpeg，统一采样率/格式 |
| `asr` | 本地模型；返回带时间戳 `Transcript`（需求 1 UI 可只展示全文） |
| `translate` | LLM API 或本地；非中文 → 中文 |

### 7.3 需求 2 流水线（后置）

```
Audio（± Text）→ 模式 A：asr → align → export_srt
              → 模式 B：asr → export_srt
（仅文案无音频时可先 tts）
```

复用 `asr` / `export_srt`；新增 `tts`、`align`。

---

## 8. 分阶段开发计划

### 阶段 0：工程骨架（0.5～1 天）

- [ ] pnpm monorepo + Electron 空窗可启动  
- [ ] 主进程 hello：IPC 或 `/health` 等价探针  
- [ ] 渲染进程能调到主进程健康检查  
- [ ] `runtime/check` 骨架（解析内置 yt-dlp、ffmpeg 路径）  
- [ ]（可选）Bun spike 结论写入本文「3.2」  

### 阶段 1：需求 1 闭环（约 3 天，可与阶段 0 部分重叠）

| 日 | 重点 |
| --- | --- |
| D1 | `download` + `extract_audio`；真实链接下视频抽音；四平台各冒烟 1 条 |
| D2 | `asr` 出 `Transcript`（含时间戳）；模型注册表 + 缺失提示页 |
| D3 | `translate` + 需求 1 页面（进度、原文/译文、文件下载）；打包冒烟 |

验收对齐需求 1 文档清单。

### 阶段 2：需求 2（约 4 天）

- [ ] `tts`（可跳过：允许用户直接给音频）  
- [ ] `align` + `export_srt`；模式 A / B 分支  
- [ ] 第二功能页；按需扩展 TTS 模型路径选择  

### 阶段 3：打磨与分发

- [ ] Windows 安装包；yt-dlp / ffmpeg 一并打进 `vendor`  
- [ ] 日志、错误码、输出目录设置  
- [ ] 2060 降级说明（模型大小/设备选择）  

---

## 9. 关键技术选型（本阶段锁定 / 待锁）

| 项 | 方案 | 状态 |
| --- | --- | --- |
| 桌面壳 | **Electron** | **已定**（2026-08-21） |
| 业务位置 | 主进程 + `packages/core` | 已定 |
| 业务语言 | TypeScript | 已定 |
| 包管理 | **pnpm**（默认）；Bun 满足 3.2 可升格 | 已定策略 |
| 下载 | yt-dlp 二进制 + TS 封装 | 已定 |
| 抽音 | ffmpeg | 已定 |
| 前端框架 | Vue 3 或 React（二选一，建仓时定） | 待锁 |
| **UI 样式** | **Tailwind CSS**（渲染进程） | **已定** |
| 进程通信 | IPC（默认）或主进程内 HTTP | 待锁 |
| ASR | Node/TS 可调用方案（绑定 / ONNX / 子进程）；须 GPU + 时间戳 | 待锁 |
| 翻译 | 云 API 优先（快）；本地模型可选 | 待锁 |
| 打包 | electron-builder（或等价） | 待锁具体配置 |

---

## 10. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 平台下载失效 | 升级 yt-dlp，不维护自研解析器 |
| ASR 原生模块与 Electron/ABI 不匹配 | 锁定 Electron 大版本；优先子进程方案降风险 |
| 5070 Ti 驱动/CUDA 与绑定不匹配 | 阶段 1 尽早在真机跑通；预留 CPU 降级开关 |
| 若用本地 HTTP：端口冲突 | 固定 127.0.0.1 + 可配置端口 / 文件锁选端口 |
| 安装包体积（Electron + 模型） | 模型不进安装包或按需下载；软件内「模型管理」 |
| 渲染进程误用 Node API | 开 `contextIsolation`；业务只走 preload 暴露的 API |

---

## 11. 开发环境清单（Windows）

- Node.js LTS + **pnpm**  
- **不必**安装 Rust / rustup（已不再使用 Tauri）  
-（可选）Bun —— 仅用于 spike / 包管理实验  
- yt-dlp、ffmpeg（开发机 PATH 或 `vendor/`）  
- NVIDIA 驱动；按 ASR 选型准备 CUDA/运行时  
- Git  

---

## 12. 文档与代码同步约定

- 需求变更改 `需求分析/`  
- 架构/选型变更改本文，并回写 `需求分析/总需求.md` 技术栈摘要  
- 不把 yt-dlp 上游源码 vendoring 进业务目录当作「重写基线」  

---

## 13. 下一步（立即执行）

1. 在 `D:\Project\Koubox` 建 pnpm monorepo + Electron 空项目  
2. 主进程健康检查 IPC（或等价）+ `runtime/check`  
3. 锁定前端框架（Vue / React）与 ASR 候选并做 5070 Ti 实测  
4. 按阶段 1 排期开发需求 1  
5. UI 壳按「工具箱」模型：见 [[工具箱交互设计]]、浏览器打开 [[工具箱UI原型]]  

---

## 附录 A：pnpm vs Bun 决策记录（填写）

| 日期 | 项 | 结果 | 结论 |
| --- | --- | --- | --- |
|  | yt-dlp/ffmpeg 子进程（Electron 主进程） | 通过 / 失败 |  |
|  | ASR 方案在 Electron 主进程 | 通过 / 失败 |  |
|  | electron-builder 打包含 vendor | 通过 / 失败 |  |
|  | 最终默认包管理 | pnpm / Bun |  |

---

## 附录 B：相对旧方案的映射

| 旧（Tauri + 侧车） | 新（Electron） |
| --- | --- |
| Tauri 壳（Rust） | Electron 壳（主进程窗口） |
| Node 侧车进程 | **主进程内的 `packages/core`**（同进程） |
| Tauri invoke / 拉起侧车 | IPC（或主进程内 HTTP） |
| 需 rustup | **不需要** |
