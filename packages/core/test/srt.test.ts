import { describe, expect, it } from 'vitest'
import { assertValidTranscript, formatSrtTime, transcriptToSrt } from '../src/index.js'

describe('subtitle contracts', () => {
  it('formats standard SRT timestamps', () => {
    expect(formatSrtTime(3661.25)).toBe('01:01:01,250')
  })

  it('exports timestamped segments as UTF-8 BOM SRT with a trailing newline', () => {
    expect(transcriptToSrt({ segments: [{ text: '你好', start: 0, end: 1.2 }] })).toBe('\uFEFF1\n00:00:00,000 --> 00:00:01,200\n你好\n')
  })

  it('rejects zero-duration and overlapping final subtitle segments', () => {
    expect(() => assertValidTranscript({
      segments: [{ text: '零时长', start: 1, end: 1 }]
    })).toThrow(/正时长/)

    expect(() => assertValidTranscript({
      segments: [
        { text: '第一条', start: 0, end: 1 },
        { text: '第二条', start: 0.9, end: 1.5 }
      ]
    })).toThrow(/重叠|倒退/)
  })

  it('enforces precise SRT language length and duration limits', () => {
    expect(() => assertValidTranscript({
      language: 'ja',
      segments: [{ text: '一二三四五六七八九十一二三四五', start: 0, end: 1 }]
    })).toThrow(/字符上限/)

    expect(() => assertValidTranscript({
      language: 'en',
      segments: [{ text: 'one two three four five six seven eight nine', start: 0, end: 1 }]
    })).toThrow(/单词上限/)

    expect(() => assertValidTranscript({
      language: 'ko',
      segments: [{ text: '정상 자막', start: 0, end: 3.01 }]
    })).toThrow(/3 秒/)
  })
})
