import { describe, expect, it } from 'vitest'
import { extractTikTokPlayUrl, extractYoutubeVideoId, selectPipedStreams } from '../src/public-video.js'

describe('public video resolvers', () => {
  it('extracts the requested TikTok video instead of a related item', () => {
    const state = {
      related: { id: '999', video: { playAddr: 'https://cdn.example/related.mp4' } },
      detail: {
        itemInfo: {
          itemStruct: {
            id: '123',
            video: {
              playAddr: 'https://v16-webapp-prime.tiktok.com/video/target.mp4',
              bitrateInfo: [{ Bitrate: 900000, PlayAddr: { UrlList: ['https://v16-webapp-prime.tiktok.com/video/target-720.mp4'] } }]
            }
          }
        }
      }
    }
    const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(state)}</script>`
    expect(extractTikTokPlayUrl(html, '123')).toBe('https://v16-webapp-prime.tiktok.com/video/target-720.mp4')
  })

  it.each([
    ['https://www.youtube.com/shorts/fE36cvZY3-w', 'fE36cvZY3-w'],
    ['https://www.youtube.com/watch?v=fE36cvZY3-w', 'fE36cvZY3-w'],
    ['https://youtu.be/fE36cvZY3-w', 'fE36cvZY3-w']
  ])('extracts YouTube id from %s', (url, expected) => {
    expect(extractYoutubeVideoId(url)).toBe(expected)
  })

  it('selects a height-limited H.264 video and M4A audio from Piped', () => {
    const selected = selectPipedStreams({
      videoStreams: [
        { url: 'https://proxy.example/av1-1080', codec: 'av01', height: 1080, videoOnly: true, bitrate: 2_000_000 },
        { url: 'https://proxy.example/h264-720', codec: 'avc1', height: 720, videoOnly: true, bitrate: 1_000_000 }
      ],
      audioStreams: [
        { url: 'https://proxy.example/opus', codec: 'opus', bitrate: 160000 },
        { url: 'https://proxy.example/m4a', codec: 'mp4a', bitrate: 128000 }
      ]
    }, 720)
    expect(selected).toEqual({
      videoUrl: 'https://proxy.example/h264-720',
      audioUrl: 'https://proxy.example/m4a'
    })
  })
})
