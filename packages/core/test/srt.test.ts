import { describe, expect, it } from 'vitest'
import { alignKnownText, formatSrtTime, transcriptToSrt } from '../src/index.js'

describe('subtitle contracts', () => {
  it('formats standard SRT timestamps', () => {
    expect(formatSrtTime(3661.25)).toBe('01:01:01,250')
  })

  it('exports timestamped segments as UTF-8 BOM SRT with a trailing newline', () => {
    expect(transcriptToSrt({ segments: [{ text: '你好', start: 0, end: 1.2 }] })).toBe('\uFEFF1\n00:00:00,000 --> 00:00:01,200\n你好\n')
  })

  it('preserves supplied text during baseline alignment', () => {
    const result = alignKnownText('第一句。第二句。', { segments: [{ text: 'noise', start: 1, end: 5 }] })
    expect(result.segments.map((item) => item.text)).toEqual(['第一句。', '第二句。'])
    expect(result.segments[0].start).toBe(1)
    expect(result.segments[1].end).toBe(5)
  })
})
