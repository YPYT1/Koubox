import { describe, expect, it } from 'vitest'
import { assertDownloadableVideoUrl, parsePlatformUrl } from '@koubox/shared'
import { resolveBilibiliPublicMedia } from '../src/bilibili.js'

describe('Bilibili URL parsing', () => {
  it.each([
    ['https://www.bilibili.com/video/BV1CJbc6JExi', 'BV1CJbc6JExi', 'https://www.bilibili.com/video/BV1CJbc6JExi'],
    ['https://www.bilibili.com/video/BV1gqtR6yEe6/?spm_id_from=333.1007', 'BV1gqtR6yEe6', 'https://www.bilibili.com/video/BV1gqtR6yEe6'],
    ['https://m.bilibili.com/video/BV1CJbc6JExi?p=2', 'BV1CJbc6JExi', 'https://www.bilibili.com/video/BV1CJbc6JExi?p=2'],
    ['https://www.bilibili.com/video/av170001', 'av170001', 'https://www.bilibili.com/video/av170001']
  ])('parses %s', (url, id, canonicalUrl) => {
    const parsed = parsePlatformUrl(url)
    expect(parsed?.platform).toBe('Bilibili')
    expect(parsed?.kind).toBe('bilibili-video')
    expect(parsed?.id).toBe(id)
    expect(parsed?.canonicalUrl).toBe(canonicalUrl)
    expect(assertDownloadableVideoUrl(url).platform).toBe('Bilibili')
  })

  it('rejects non-video bilibili paths', () => {
    expect(() => assertDownloadableVideoUrl('https://www.bilibili.com/cheese/play/ep123')).toThrow(
      'Bilibili 课程类链接暂不支持，请使用普通视频或番剧链接。'
    )
  })

  it.each([
    ['https://b23.tv/abc123', 'bilibili-short-link', true],
    ['https://www.bilibili.com/bangumi/play/ep307446', 'bilibili-bangumi', false],
    ['https://www.bilibili.com/bangumi/play/ss48831', 'bilibili-bangumi', false],
    ['https://www.bilibili.com/list/123?bvid=BV1CJbc6JExi', 'bilibili-video', false],
    ['https://www.bilibili.com/festival/2024?bvid=BV1CJbc6JExi', 'bilibili-video', false]
  ])('parses extended Bilibili forms %s', (url, kind, needsRedirect) => {
    const parsed = parsePlatformUrl(url)
    expect(parsed?.platform).toBe('Bilibili')
    expect(parsed?.kind).toBe(kind)
    expect(parsed?.needsRedirect).toBe(needsRedirect)
    expect(assertDownloadableVideoUrl(url).platform).toBe('Bilibili')
  })
})

describe('resolveBilibiliPublicMedia live API', () => {
  it('returns a progressive or dash media URL for a public BV', async () => {
    const resolution = await resolveBilibiliPublicMedia(
      'https://www.bilibili.com/video/BV1CJbc6JExi',
      '',
      0
    )
    expect(resolution.source).toBe('bilibili-page')
    expect(resolution.videoUrl).toMatch(/^https?:\/\//)
    expect(resolution.referer).toBe('https://www.bilibili.com')
    expect(resolution.userAgent.length).toBeGreaterThan(10)
    expect(resolution.cookieHeader).toMatch(/buvid3=/)
    expect(new URL(resolution.videoUrl).hostname).toMatch(/bilibili|bilivideo|akamaized|mountaintoys/i)
    if (resolution.audioUrl) {
      expect(resolution.audioUrl).toMatch(/^https?:\/\//)
    }
  }, 60_000)
})
