import type { Transcript } from '@koubox/shared'
import { formatSrtTime, transcriptToSrt } from '@koubox/shared'

export { formatSrtTime, transcriptToSrt }

export function assertValidTranscript(transcript: Transcript): void {
  if (transcript.segments.length === 0) throw new Error('SRT 没有字幕片段。')
  const language = transcript.language?.toLowerCase().replace('_', '-')
  let previousEnd = -1
  for (const [index, segment] of transcript.segments.entries()) {
    if (!segment.text.trim()) throw new Error(`第 ${index + 1} 条字幕为空。`)
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end)) {
      throw new Error(`第 ${index + 1} 条字幕时间不是有效数字。`)
    }
    if (segment.start < 0) throw new Error(`第 ${index + 1} 条字幕开始时间小于 0。`)
    if (segment.end <= segment.start) throw new Error(`第 ${index + 1} 条字幕不是正时长。`)
    if (segment.start < previousEnd) throw new Error(`第 ${index + 1} 条字幕时间轴重叠或倒退。`)
    if (segment.end - segment.start > 3.001) throw new Error(`第 ${index + 1} 条字幕超过 3 秒。`)
    const visibleCharacters = segment.text.replace(/\s+/g, '').length
    if ((language === 'ja' || language === 'zh' || language?.startsWith('zh-')) && visibleCharacters > 14) {
      throw new Error(`第 ${index + 1} 条字幕超过语言字符上限。`)
    }
    if (language === 'ko' && visibleCharacters > 18) {
      throw new Error(`第 ${index + 1} 条字幕超过语言字符上限。`)
    }
    if (language === 'en') {
      if (visibleCharacters > 42) throw new Error(`第 ${index + 1} 条英文字幕超过字符上限。`)
      if (segment.text.trim().split(/\s+/).length > 8) throw new Error(`第 ${index + 1} 条英文字幕超过单词上限。`)
    }
    previousEnd = segment.end
  }
}

/**
 * 将 Transcript 转换为标准 SRT 格式，完全兼容剪映导入
 *
 * 剪映 SRT 格式要求：
 * 1. 时间戳格式：HH:MM:SS,mmm（逗号分隔毫秒，非句点）
 * 2. 每条字幕：序号 + 时间轴 + 文本内容 + 空行
 * 3. 文本编码：UTF-8 with BOM（Windows 剪映推荐）
 * 4. 换行符：建议 CRLF（Windows）
 * 5. 时间不能倒退或重叠
 */
/**
 * 解析 SRT 文件为 Transcript 结构（用于导入和验证）
 */
export function parseSrt(srtContent: string): Transcript {
  const content = srtContent.replace(/^﻿/, '') // 移除 BOM
  const blocks = content.split(/\n\s*\n/).filter(Boolean)

  const segments = blocks.map((block) => {
    const lines = block.split(/\r?\n/).filter(Boolean)
    if (lines.length < 2) throw new Error('SRT 格式错误：缺少时间轴或文本')

    // 第一行：序号（跳过）
    // 第二行：时间轴
    const timeMatch = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/)
    if (!timeMatch) throw new Error(`SRT 时间轴格式错误：${lines[1]}`)

    const start =
      parseInt(timeMatch[1]) * 3600 +
      parseInt(timeMatch[2]) * 60 +
      parseInt(timeMatch[3]) +
      parseInt(timeMatch[4]) / 1000

    const end =
      parseInt(timeMatch[5]) * 3600 +
      parseInt(timeMatch[6]) * 60 +
      parseInt(timeMatch[7]) +
      parseInt(timeMatch[8]) / 1000

    // 第三行及之后：文本内容
    const text = lines.slice(2).join('\n')

    return { text, start, end }
  })

  return { segments }
}
