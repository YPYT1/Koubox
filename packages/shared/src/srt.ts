import type { Transcript } from './index.js'

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

/** Serialize a transcript to the Jianying-compatible UTF-8 BOM SRT contract. */
export function transcriptToSrt(transcript: Transcript, options?: { addBom?: boolean }): string {
  const segments = transcript.segments
    .filter((segment) => segment.text.trim() && segment.end >= segment.start)
    .reduce<Array<{ text: string; start: number; end: number }>>((acc, segment) => {
      const prevEnd = acc.length > 0 ? acc[acc.length - 1].end : 0
      const start = Math.max(segment.start, prevEnd)
      const end = Math.max(segment.end, start + 0.001)
      acc.push({ text: segment.text.trim(), start, end })
      return acc
    }, [])

  const srtContent = segments
    .map((segment, index) => {
      const lines = splitTextForSubtitle(segment.text, 20)
      return `${index + 1}\n${formatSrtTime(segment.start)} --> ${formatSrtTime(segment.end)}\n${lines.join('\n')}`
    })
    .join('\n\n')

  const bom = options?.addBom !== false ? '\uFEFF' : ''
  return bom + srtContent + '\n'
}

function splitTextForSubtitle(text: string, maxCharsPerLine = 20): string[] {
  if (text.length <= maxCharsPerLine) return [text]

  const lines: string[] = []
  let currentLine = ''
  const segments = text.split(/([，。、；：！？,;:!?])/g).filter(Boolean)

  for (const segment of segments) {
    if (currentLine.length + segment.length <= maxCharsPerLine) currentLine += segment
    else {
      if (currentLine) lines.push(currentLine)
      currentLine = segment
    }
  }

  if (currentLine) lines.push(currentLine)
  if (lines.length === 0 || lines.some((line) => line.length > maxCharsPerLine * 1.5)) {
    const chars = [...text]
    lines.length = 0
    for (let i = 0; i < chars.length; i += maxCharsPerLine) lines.push(chars.slice(i, i + maxCharsPerLine).join(''))
  }
  return lines
}
