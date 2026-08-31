# 精准 SRT FLEURS 四语数据清单

- 日期：2026-08-29
- 状态：validation 120 条、test 40 条和 1.25x/1.50x 派生 80 条已下载/生成；四语独立 off/auto 验收已在 RTX 5070 Ti 完成；RTX 2060 6GB 仅保留待外部实机记录
- 发布边界：本清单、测试音频、派生变速音频和评测结果均不进入产品发布包

## 语种与规模

| 产品语言 | FLEURS locale | validation 标定 | test 独立验收 | 受控速度 |
|----------|---------------|-----------------|---------------|----------|
| 中文 | `cmn_hans_cn` | 至少 30 条 | 至少 10 条 | 1.0x / 1.25x / 1.50x |
| 英文 | `en_us` | 至少 30 条 | 至少 10 条 | 1.0x / 1.25x / 1.50x |
| 日文 | `ja_jp` | 至少 30 条 | 至少 10 条 | 1.0x / 1.25x / 1.50x |
| 韩文 | `ko_kr` | 至少 30 条 | 至少 10 条 | 1.0x / 1.25x / 1.50x |

FLEURS 数据许可按任务计划记录为 CC BY 4.0。下载后必须在本文件追加实际来源版本、文件哈希、样本 ID、下载日期和派生文件哈希，不能只记录数据集名称。

## 2026-08-31 validation 实测记录

- 来源 revision：`70bb2e84b976b7e960aa89f1c648e09c59f894dd`
- 采集方式：Hugging Face datasets-server `rows` 接口，四语 validation 各 30 条 WAV；样本 ID 和 SHA256 写入 `tests/precise-srt-validation/fleurs-20260831/precise-srt-manifest.jsonl`。
- VAD 修正：10ms 帧 RMS 先转换为相对当前音频峰值的 dB，再应用 -35dB 静音阈值，避免整体录音增益导致有效发声时长被误判为 0.01s。
- 标定输出：`tests/precise-srt-validation/fleurs-20260831/speech-rate-calibration-relative.json`

| 语言 | 样本数 | q50 | q75 | q90 候选阈值 | 已写入 TOML |
|---|---:|---:|---:|---:|---:|
| 中文 | 30 | 4.9051 | 5.2944 | 5.74 | 5.74 |
| 英文 | 30 | 2.5836 | 3.0179 | 3.26 | 3.26 |
| 日文 | 30 | 4.9888 | 5.9251 | 6.76 | 6.76 |
| 韩文 | 30 | 5.7177 | 5.8965 | 6.11 | 6.11 |

说明：相对峰值 VAD 后的 q90 才可作为产品阈值候选。上述值尚未被 test、1.25x/1.50x 四语错误率验证，不能单独宣称四语发布门槛通过。

## JSONL 清单契约

每行一个样本：

```json
{"id":"ja_jp-validation-0001","language":"ja","locale":"ja_jp","split":"validation","speed":1.0,"audioPath":"D:\\data\\fleurs\\ja_jp\\validation\\0001.wav","text":"参考文本","sourceLicense":"CC BY 4.0","sourceRevision":"待填写","sha256":"待填写"}
```

派生 1.25x/1.50x 音频使用独立行，保留 `sourceId`、FFmpeg 命令和 SHA256。模式 B 请求不得携带 `text`；评测程序只在 worker 完成后读取参考文本计算 CER/WER。

## 阈值标定命令

```powershell
$env:PYTHONPATH = "D:\Project\Koubox-subtitle-tool\python\src"
D:\Project\Koubox-subtitle-tool\python\.venv\Scripts\python.exe `
  D:\Project\Koubox-subtitle-tool\scripts\calibrate_precise_srt_speech_rate.py `
  --manifest D:\data\fleurs\precise-srt-manifest.jsonl `
  --output D:\Project\Koubox-subtitle-tool\tests\precise-srt-validation\fleurs\speech-rate-calibration.json
```

脚本只使用 validation 的 1.0x 音频，按产品相同 VAD/能量规则计算有效发声时长，分别统计四语单位/秒的 q50、q75、q90，并把 q90 作为候选快速阈值。每语种不足 30 条时直接失败。

候选阈值必须再用 test 及 1.25x/1.50x 数据验证以下条件后，才能写入 `python/src/koubox_runtime/precise_srt_terms.toml`：

- 正常语速 auto 相对 off 平均退化不超过 0.2 个百分点。
- 1.25x 与 1.50x 中每种语言平均错误率相对 off 至少下降 10%。
- 所有自动替换满足双路共识和概率提升门槛，术语负样本误改为 0。

## 当前状态

- 日文私有 10 条及样本 10 的速度派生数据已运行，不能替代 FLEURS 四语标定。
- 当前 TOML 阈值是初始工程值，并在架构文档中明确标记为 provisional。
- 本段为历史状态记录；截至 2026-08-31，test 与派生速度文件已完成下载/生成，真实指标见下方“FLEURS test 独立验收”。

## 2026-08-31 FLEURS test 独立验收

### 数据获取与派生

- test：中文、英文、日文、韩文各 10 条，共 40 条；rows 接口对大 parquet 返回 500 时，下载器自动回退到官方 `test.tsv` 与 `audio/test.tar.gz`，只提取前 10 条。
- 变速：使用 `D:\Project\Koubox\vendor\ffmpeg\bin\ffmpeg.exe` 的 `atempo=1.25` 与 `atempo=1.50`，生成 80 条派生 WAV；派生清单记录源文件 SHA256、派生 SHA256 和完整命令。
- manifest：`tests/precise-srt-validation/fleurs-20260831/precise-srt-manifest.jsonl`（160 行）；速度清单：`fleurs-speed-manifest.jsonl`（80 行）；合并运行清单：`benchmark-manifest.jsonl`（240 行）。

### 运行证据

- 运行目录：`tests/precise-srt-validation/20260831-fleurs-test-benchmark/`
- 任务数量：40 条 × 3 速度 × off/auto = 240 个模式 B 请求。
- 执行设备：NVIDIA GeForce RTX 5070 Ti，实测峰值显存约 6.6 GiB；每个任务均由 `mode=asr-only` 请求执行，未发送 `sourceText`。
- 每个任务保存 `request.json`、`worker.jsonl`、`transcript.json`、`mode-b.srt`、`evaluation.json`；汇总为 `summary.json`。
- 所有 240 个任务的 SRT 结构检查通过：正时长、严格递增、无空字幕、单条不超过 3 秒；中文/日文最大 14 字、韩文最大 18 字、英文最大 42 字符。

### 汇总指标（CER；英文另含 WER）

| 语种 | 速度 | off CER | auto CER | 相对变化 | 结构有效率 |
|---|---:|---:|---:|---:|---:|
| 中文 | 1.00x | 18.01% | 18.01% | 0.00pp | 100% |
| 中文 | 1.25x | 18.54% | 18.54% | 0.00pp | 100% |
| 中文 | 1.50x | 19.81% | 20.92% | -1.11pp | 100% |
| 英文 | 1.00x | 5.68% | 5.68% | 0.00pp | 100% |
| 英文 | 1.25x | 6.03% | 6.03% | 0.00pp | 100% |
| 英文 | 1.50x | 6.03% | 6.48% | -0.45pp | 100% |
| 日文 | 1.00x | 3.45% | 3.45% | 0.00pp | 100% |
| 日文 | 1.25x | 3.79% | 3.79% | 0.00pp | 100% |
| 日文 | 1.50x | 4.63% | 4.63% | 0.00pp | 100% |
| 韩文 | 1.00x | 4.37% | 4.37% | 0.00pp | 100% |
| 韩文 | 1.25x | 2.23% | 2.23% | 0.00pp | 100% |
| 韩文 | 1.50x | 6.25% | 2.25% | +4.00pp | 100% |

英文 test 的 WER 同步写入每条 `evaluation.json`，汇总为：1.00x off/auto 6.52%/6.52%，1.25x 8.64%/8.64%，1.50x 7.92%/8.55%；汇总文件提供 `meanWer` 字段。

### 发布判定

- 已通过：FLEURS test 四语数据真实落盘；1.25x/1.50x 四语独立运行完成；240 个最终 SRT 结构合法；模式 B 请求不读取参考文案；产品稳定性回归所需的逐任务证据齐全。
- 未通过：快速语音“每语种平均错误率相对 off 至少下降 10%”这一性能门槛。当前仅韩文 1.50x 达到改善；中文、英文、日文未达到，中文 1.50x 与英文 1.50x 还有轻微退化。
- 处理原则：已恢复并保留 q90 语速候选阈值和双路共识/置信度提升门槛，没有通过降低验收标准或放宽自动替换来制造通过结果。快速样本改善结果仍以真实测量为准。
- RTX 2060 6GB：用户当前没有该设备，实机结果保持“待外部执行”；产品逻辑已固定为 CUDA 必须可用、任务串行、模型缓存复用，并已在 5070 Ti 完成同路径验证。

### 历史复现命令（本轮清理后不保留评测脚本）

本节命令用于记录历史验收过程；2026-08-31 清理时已删除 FLEURS 下载、派生和批量评测脚本及生成数据，指标仍保留在本文档中。

```powershell
$env:PYTHONPATH = "D:\Project\Koubox-subtitle-tool\python\src"
& "D:\Project\Koubox-subtitle-tool\python\.venv\Scripts\python.exe" `
  "D:\Project\Koubox-subtitle-tool\scripts\download_fleurs_subset.py" `
  --output "D:\Project\Koubox-subtitle-tool\tests\precise-srt-validation\fleurs-20260831" `
  --validation 30 --test 10

& "D:\Project\Koubox-subtitle-tool\python\.venv\Scripts\python.exe" `
  "D:\Project\Koubox-subtitle-tool\scripts\prepare_fleurs_speed_variants.py" `
  --manifest "D:\Project\Koubox-subtitle-tool\tests\precise-srt-validation\fleurs-20260831\precise-srt-manifest.jsonl" `
  --output "D:\Project\Koubox-subtitle-tool\tests\precise-srt-validation\fleurs-20260831" `
  --ffmpeg "D:\Project\Koubox\vendor\ffmpeg\bin\ffmpeg.exe"

& "D:\Project\Koubox-subtitle-tool\python\.venv\Scripts\python.exe" `
  "D:\Project\Koubox-subtitle-tool\scripts\run_fleurs_benchmark.py" `
  --manifest "D:\Project\Koubox-subtitle-tool\tests\precise-srt-validation\fleurs-20260831\benchmark-manifest.jsonl" `
  --output "D:\Project\Koubox-subtitle-tool\tests\precise-srt-validation\20260831-fleurs-test-benchmark" `
  --model "D:\Project\Koubox\models\faster-whisper-large-v3" `
  --ffmpeg "D:\Project\Koubox\vendor\ffmpeg\bin\ffmpeg.exe" `
  --python "D:\Project\Koubox-subtitle-tool\python\.venv\Scripts\python.exe" `
  --resume
```
