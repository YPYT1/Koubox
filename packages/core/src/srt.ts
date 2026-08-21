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

export function transcriptToSrt(transcript: Transcript): string {
  return transcript.segments
    .filter((segment) => segment.text.trim() && segment.end >= segment.start)
    .map((segment, index) => `${index + 1}\n${formatSrtTime(segment.start)} --> ${formatSrtTime(segment.end)}\n${segment.text.trim()}`)
    .join('\n\n')
}
