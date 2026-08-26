import type { Transcript } from '@koubox/shared'

function pad(value: number, digits = 2): string {
  return String(value).padStart(digits, '0')
}

export function formatSrtTime(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
  const secs = Math.floor((milliseconds % 60_000) / 1000)
  const millis = milliseconds % 1000
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`
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
export function transcriptToSrt(transcript: Transcript, options?: { addBom?: boolean }): string {
  const segments = transcript.segments
    .filter((segment) => segment.text.trim() && segment.end >= segment.start)
    // 确保时间不重叠：如果当前开始时间早于上一个结束时间，调整为上一个结束时间
    .reduce<Array<{ text: string; start: number; end: number }>>((acc, segment) => {
      const prevEnd = acc.length > 0 ? acc[acc.length - 1].end : 0
      const start = Math.max(segment.start, prevEnd)
      const end = Math.max(segment.end, start + 0.001) // 至少 1ms
      acc.push({ text: segment.text.trim(), start, end })
      return acc
    }, [])

  const srtContent = segments
    .map((segment, index) => {
      // 剪映支持多行字幕，但每行不宜过长（建议 15-20 字一行）
      const lines = splitTextForSubtitle(segment.text, 20)
      return `${index + 1}\n${formatSrtTime(segment.start)} --> ${formatSrtTime(segment.end)}\n${lines.join('\n')}`
    })
    .join('\n\n')

  // 添加 UTF-8 BOM 标记（剪映在 Windows 上推荐）
  const bom = options?.addBom !== false ? '﻿' : ''
  return bom + srtContent + '\n'
}

/**
 * 智能断行：将长文本按合理长度拆分为多行，方便阅读
 * 优先在标点符号处断行
 */
function splitTextForSubtitle(text: string, maxCharsPerLine = 20): string[] {
  if (text.length <= maxCharsPerLine) return [text]

  const lines: string[] = []
  let currentLine = ''

  // 按逗号、句号等标点符号预分段
  const segments = text.split(/([，。、；：！？,;:!?])/g).filter(Boolean)

  for (const segment of segments) {
    if (currentLine.length + segment.length <= maxCharsPerLine) {
      currentLine += segment
    } else {
      if (currentLine) lines.push(currentLine)
      currentLine = segment
    }
  }

  if (currentLine) lines.push(currentLine)

  // 如果没有标点符号或断行失败，强制按字数切分
  if (lines.length === 0 || lines.some((line) => line.length > maxCharsPerLine * 1.5)) {
    const chars = [...text]
    lines.length = 0
    for (let i = 0; i < chars.length; i += maxCharsPerLine) {
      lines.push(chars.slice(i, i + maxCharsPerLine).join(''))
    }
  }

  return lines
}

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
