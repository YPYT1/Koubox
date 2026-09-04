import { describe, expect, it } from 'vitest'
import { parsePlatformUrl } from '@koubox/shared'
import { prepareDownloadUrl } from '../src/download-url.js'
import { resolveBilibiliPublicMedia } from '../src/bilibili.js'

const enabled = process.env.KOUBOX_BILIBILI_MATRIX === '1'

describe.skipIf(!enabled)('Bilibili live link matrix', () => {
  it.each([
    ['video', 'https://www.bilibili.com/video/BV1CJbc6JExi'],
    ['mobile-video', 'https://m.bilibili.com/video/BV1CJbc6JExi?p=1'],
    ['short-link', 'https://b23.tv/BV1CJbc6JExi'],
    ['bangumi-episode', 'https://www.bilibili.com/bangumi/play/ep307446'],
    ['bangumi-season', 'https://www.bilibili.com/bangumi/play/ss48831']
  ])('resolves %s', async (_name, input) => {
    const prepared = await prepareDownloadUrl(input, '')
    expect(prepared.parsed.platform).toBe('Bilibili')
    expect(prepared.downloadUrl).toMatch(/^https:\/\//)
    const media = await resolveBilibiliPublicMedia(prepared.downloadUrl, '', 720)
    expect(media.videoUrl).toMatch(/^https?:\/\//)
    expect(media.referer).toBe('https://www.bilibili.com')
  }, 60_000)

  it('extracts bvid from list and festival query links', () => {
    for (const input of [
      'https://www.bilibili.com/list/123?bvid=BV1CJbc6JExi',
      'https://www.bilibili.com/festival/2024?bvid=BV1CJbc6JExi'
    ]) {
      expect(parsePlatformUrl(input)?.id).toBe('BV1CJbc6JExi')
    }
  })
})
