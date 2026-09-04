import { describe, expect, it } from 'vitest'
import { assertDownloadableVideoUrl, assertMaterialsVideoUrl, detectPlatform } from '@koubox/shared'
import { normalizeTikTokVideoUrl } from '../src/public-video'
import { parsePlatformUrl } from '@koubox/shared'

describe('shared platform detection', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abc', 'YouTube'],
    ['https://www.tiktok.com/@creator/video/1', 'TikTok'],
    ['https://www.instagram.com/reel/abc', 'Instagram'],
    ['https://www.instagram.com/reels/abc', 'Instagram'],
    ['https://www.facebook.com/watch/?v=1234567890', 'Facebook'],
    ['https://www.facebook.com/share/r/abc/', 'Facebook'],
    ['https://www.facebook.com/share/v/abc/', 'Facebook'],
  ])('detects %s as %s', (url, expected) => {
    expect(detectPlatform(url)).toBe(expected)
    expect(assertDownloadableVideoUrl(url).platform).toBe(expected)
  })

  it('detects Bilibili video URLs as downloadable', () => {
    const url = 'https://www.bilibili.com/video/BV1CJbc6JExi'
    expect(detectPlatform(url)).toBe('Bilibili')
    expect(assertDownloadableVideoUrl(url).platform).toBe('Bilibili')
  })

  it('rejects Bilibili for materials pipeline', () => {
    expect(() => assertMaterialsVideoUrl('https://www.bilibili.com/video/BV1CJbc6JExi')).toThrow(
      '仅支持 YouTube / Facebook / Instagram / TikTok。'
    )
  })
})

describe('TikTok URL normalization', () => {
  it.each([
    'https://www.tiktok.com/@user706133680727/video/7678178992146386194?q=%23%E6%97%A5%E6%9C%AC%E6%A0%AA&t=1787717576834',
    'https://www.tiktok.com/@uxlfbh5sz7/video/7678178246583684372?q=%23%E6%97%A5%E6%9C%AC%E6%A0%AA&t=1787717576834#share'
  ])('strips query and hash from shared video URLs', (url) => {
    expect(normalizeTikTokVideoUrl(url)).toMatch(/^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/)
  })
})
