import { describe, expect, it } from 'vitest'
import { detectPlatform } from '@koubox/shared'

describe('shared platform detection', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abc', 'YouTube'],
    ['https://www.tiktok.com/@creator/video/1', 'TikTok'],
    ['https://www.instagram.com/reel/abc', 'Instagram'],
    ['https://www.facebook.com/watch/?v=abc', 'Facebook'],
  ])('detects %s as %s', (url, expected) => {
    expect(detectPlatform(url)).toBe(expected)
  })
})
