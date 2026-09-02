import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assertDownloadableVideoUrl } from '@koubox/shared'

const resolveFacebookShareUrlMock = vi.fn()

vi.mock('../src/facebook.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/facebook.js')>()
  return {
    ...actual,
    resolveFacebookShareUrl: (...args: unknown[]) => resolveFacebookShareUrlMock(...args)
  }
})

import { parsePlatformUrl, parsePlatformUrlOrThrow } from '@koubox/shared'
import { prepareDownloadUrl } from '../src/download-url.js'

const youtubeMatrix = [
  ['https://www.youtube.com/watch?v=sVbr9YKUnDo', 'sVbr9YKUnDo'],
  ['https://youtu.be/sVbr9YKUnDo', 'sVbr9YKUnDo'],
  ['https://www.youtube.com/watch?v=7CZenGLM2ds', '7CZenGLM2ds'],
  ['https://youtu.be/7CZenGLM2ds', '7CZenGLM2ds'],
  ['https://www.youtube.com/shorts/vLtYU3fP7fM', 'vLtYU3fP7fM'],
  ['https://www.youtube.com/shorts/vLtYU3fP7fM?feature=share', 'vLtYU3fP7fM'],
  ['https://www.youtube.com/shorts/Vcnkxb65rtY', 'Vcnkxb65rtY'],
  ['https://www.youtube.com/shorts/Vcnkxb65rtY?feature=share', 'Vcnkxb65rtY'],
  ['https://www.youtube.com/watch?v=pbNs7tAUFkk&list=RDbzRY8Rs0Q4M&index=2', 'pbNs7tAUFkk']
] as const

const tiktokMatrix = [
  'https://www.tiktok.com/@jintaozhang0607/video/7652209936830582030?is_from_webapp=1&sender_device=pc',
  'https://www.tiktok.com/@dvdjebsj/video/7680004323081719047?q=%23%E6%97%A5%E6%9C%AC%E6%A0%AA&t=1788161533987',
  'https://www.tiktok.com/@hide._money/video/7677775825894165778?q=%23%E6%97%A5%E6%9C%AC%E6%A0%AA&t=1787717576834',
  'https://www.tiktok.com/@hide._money/video/7677775825894165778'
]

const instagramMatrix = [
  ['https://www.instagram.com/reels/DbqaVFtTBUv/', 'DbqaVFtTBUv', 'instagram-reels'],
  ['https://www.instagram.com/reel/DbqaVFtTBUv/?utm_source=ig_web_copy_link&igsi=NTc4MTIwNjQ2YQ==', 'DbqaVFtTBUv', 'instagram-reel'],
  ['https://www.instagram.com/p/Db-yNiMzPeV/', 'Db-yNiMzPeV', 'instagram-post'],
  ['http://instagram.com/p/DcnqbRXOdQ7/', 'DcnqbRXOdQ7', 'instagram-post']
] as const

const facebookMatrix = [
  ['https://www.facebook.com/watch/?ref=search&v=1071464599175027&external_log_id=abc&q=test', '1071464599175027', 'facebook-watch', false],
  ['https://www.facebook.com/watch?v=1763161341605188', '1763161341605188', 'facebook-watch', false],
  ['https://www.facebook.com/reel/966859349599866', '966859349599866', 'facebook-reel', false],
  ['https://www.facebook.com/share/r/19dWe6xqiR/', undefined, 'facebook-share', true],
  ['https://www.facebook.com/share/v/1FCHgEUeAu/', undefined, 'facebook-share', true]
] as const

describe('parsePlatformUrl', () => {
  it.each(youtubeMatrix)('parses YouTube %s', (url, videoId) => {
    const parsed = parsePlatformUrl(url)
    expect(parsed?.platform).toBe('YouTube')
    expect(parsed?.id).toBe(videoId)
    expect(parsed?.needsRedirect).toBe(false)
  })

  it.each(tiktokMatrix)('normalizes TikTok %s', (url) => {
    const parsed = parsePlatformUrl(url)!
    expect(parsed.platform).toBe('TikTok')
    expect(parsed.canonicalUrl).toMatch(/^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/)
    expect(parsed.canonicalUrl).not.toMatch(/[?#]/)
    expect(assertDownloadableVideoUrl(url).platform).toBe('TikTok')
  })

  it.each(instagramMatrix)('parses Instagram %s', (url, shortcode, kind) => {
    const parsed = parsePlatformUrl(url)
    expect(parsed?.platform).toBe('Instagram')
    expect(parsed?.kind).toBe(kind)
    expect(parsed?.id).toBe(shortcode)
    expect(parsed?.canonicalUrl).toBe(`https://www.instagram.com/${kind === 'instagram-post' ? 'p' : kind === 'instagram-reel' ? 'reel' : 'reels'}/${shortcode}/`)
    expect(assertDownloadableVideoUrl(url).platform).toBe('Instagram')
  })

  it.each(facebookMatrix)('parses Facebook %s', (url, id, kind, needsRedirect) => {
    const parsed = parsePlatformUrl(url)
    expect(parsed?.platform).toBe('Facebook')
    expect(parsed?.kind).toBe(kind)
    expect(parsed?.needsRedirect).toBe(needsRedirect)
    if (id) expect(parsed?.id).toBe(id)
    expect(assertDownloadableVideoUrl(url).platform).toBe('Facebook')
  })

  it('rejects malformed Instagram paths', () => {
    expect(() => assertDownloadableVideoUrl('https://www.instagram.com/stories/user/1/')).toThrow(
      'Instagram 链接格式不正确，支持 /p/、/reel/、/reels/。'
    )
  })

  it('does not convert Instagram /p/ to /reel/', () => {
    const post = parsePlatformUrlOrThrow('https://www.instagram.com/p/Db-yNiMzPeV/')
    const reel = parsePlatformUrlOrThrow('https://www.instagram.com/reel/Db-yNiMzPeV/')
    expect(post.canonicalUrl).toContain('/p/')
    expect(reel.canonicalUrl).toContain('/reel/')
    expect(post.id).toBe(reel.id)
    expect(post.canonicalUrl).not.toBe(reel.canonicalUrl)
  })
})

describe('prepareDownloadUrl', () => {
  beforeEach(() => {
    resolveFacebookShareUrlMock.mockReset()
  })

  it('resolves Facebook share links before download', async () => {
    resolveFacebookShareUrlMock.mockResolvedValue({
      finalUrl: 'https://www.facebook.com/watch?v=1386554406910989',
      redirectChain: [
        'https://www.facebook.com/share/r/1ESHQ171kU/',
        'https://www.facebook.com/watch?v=1386554406910989'
      ]
    })
    const prepared = await prepareDownloadUrl('https://www.facebook.com/share/r/1ESHQ171kU/', '')
    expect(prepared.downloadUrl).toBe('https://www.facebook.com/watch?v=1386554406910989')
    expect(prepared.parsed.kind).toBe('facebook-watch')
    expect(prepared.parsed.id).toBe('1386554406910989')
  })
})
