# 精准 SRT 模型切换空白问题分析

更新时间：2026-09-09

## 结论

有文案模式的“中间空白”来自 fallback 重新开始处理完整音频时的进度跳回。最终输出不是因为该跳回而静默丢失内容。当前仍存在的工程问题是：fallback 可能重复计算整个音频，且模型切换之前没有向用户提供稳定的连续进度语义。

## 调用链

```text
TaskManager.performPreciseSrt()
  → executeAsrPlan()
    → runAttempt(primary)
      → precise_srt_worker.run()
        → _ensure_mode_a_preserves_source()
    → fallback runAttempt(fallback)
      → 重新处理完整音频
```

Python 侧的日文对齐失败路径现在先执行：

```text
常规日文对齐
  → Sudachi tokenized realign
  → 仍失败则返回明确对齐错误
  → 上层执行计划决定是否使用 fallback 模型
```

## 当前已完成

- 已识别 `PRECISE_SRT_ALIGNMENT_INCOMPLETE` 的触发点。
- 已移除旧的 `_mode_a_near_match` 和按字符权重重分配逻辑。
- 已加入 Sudachi 词元化重对齐路径。
- 已保留正文完全一致校验，避免把错误识别文字直接作为用户文案输出。
- 已保留上层模型执行计划的 fallback 机制。

## 当前未完成

### 1. 当前版本重新回归

之前的“无 fallback”记录对应旧实现，不能直接覆盖当前 Sudachi 改造后的行为。需要用现有真实日文音频重新确认：

- turbo 是否仍会触发模型 fallback；
- Sudachi tokenized realign 的成功率；
- 有文案模式正文完整性；
- 最终字幕的时间轴和边界质量。

### 2. 有文案模式模型策略对比

需要在相同输入上比较：

- 当前 turbo + Sudachi tokenized realign；
- 有文案模式直接使用 Large v3；
- 当前执行计划 fallback。

比较项包括总耗时、fallback 次数、显存峰值、正文一致率和人工边界质量。对比完成前，保持当前生产策略，不凭单个样本决定强制 Large v3。

### 3. 增量 fallback

目标是只对失败的音频区间使用 Large v3。实现前必须确定：

- 失败区间如何从对齐结果中定位；
- 局部音频需要扩展多少上下文；
- 局部时间轴如何与已有片段合并；
- 相邻片段如何去重；
- 进度如何连续计算；
- 局部失败后如何显式报告。

### 4. UI 进度语义

在增量 fallback 完成前，界面应把模型切换显示为明确的“正在重新对齐”阶段，并避免把用户误导为任务已经丢失中间结果。该项需要结合实际产品交互回归，不在本轮文档整理中修改界面代码。

## 不采用的旧结论

旧记录中的“放宽 near-match 阈值”只对应当时的实现。当前代码已删除该函数，因此旧阈值、旧代码片段和旧的 8 秒/12 秒单样本对比不能作为当前版本证据。

## 验收标准

模型切换问题的最终验收必须同时记录：

1. primary 模型和 fallback 模型；
2. fallback 是否发生；
3. 是否重新处理完整音频；
4. 进度事件的阶段和百分比；
5. 最终 SRT 的正文、时间轴和边界指标；
6. 失败时的明确错误信息。
