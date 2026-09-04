import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultPlatformAuth } from '@koubox/shared'
import { downloadVideo, type VideoDownloadRequest } from '../src/video-download.js'
import type { PublicMediaResolution } from '../src/public-video.js'

function createRequest(overrides: Partial<VideoDownloadRequest> = {}): VideoDownloadRequest {
  const directory = mkdtempSync(join(tmpdir(), 'koubox-bilibili-download-'))
  mkdirSync(directory, { recursive: true })
  return {
    url: 'https://www.bilibili.com/video/BV1CJbc6JExi',
    directory,
    fileStem: 'Bilibili_20260904_001',
    vendor: {
      ytdlpExecutable: join(directory, 'yt-dlp.exe'),
      ffmpegExecutable: join(directory, 'ffmpeg.exe'),
      denoExecutable: join(directory, 'deno.exe')
    },
    config: {
      ytdlpProxy: '',
      ytdlpMaxHeight: 0,
      ytdlpExtraArgs: '',
      ytdlpPlatformAuth: defaultPlatformAuth()
    },
    updateProgress: () => undefined,
    runCommand: async (_command, args) => {
      const output = args.at(-1)
      if (output && !output.includes('%(ext)s')) writeFileSync(output, 'media')
    },
    verifyMediaFile: async () => ({
      duration: 1,
      size: 5,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 852,
      height: 480
    }),
    ...overrides
  }
}

const bilibiliResolution: PublicMediaResolution = {
  source: 'bilibili-page',
  videoUrl: 'https://upos-sz-mirrorcos.bilivideo.com/example-192.mp4',
  referer: 'https://www.bilibili.com',
  userAgent: 'test-agent'
}

describe('Bilibili download pipeline', () => {
  it('uses native playurl resolution before yt-dlp', async () => {
    const calls: string[] = []
    const request = createRequest({
      resolvePublicMedia: async () => {
        calls.push('native')
        return bilibiliResolution
      },
      runCommand: async (_command, args, _onLine, label) => {
        calls.push(label ?? 'command')
        const output = args.at(-1)
        if (output) writeFileSync(output, 'media')
      }
    })

    const result = await downloadVideo(request)
    expect(result.strategy).toBe('public-page')
    expect(result.platform).toBe('Bilibili')
    expect(calls).toEqual(['native', '公开媒体下载'])
  })

  it('falls back to anonymous yt-dlp when native playurl fails', async () => {
    const calls: string[] = []
    const request = createRequest({
      resolvePublicMedia: async () => {
        calls.push('native')
        throw new Error('Bilibili API HTTP 412')
      },
      runCommand: async (_command, args, _onLine, label) => {
        calls.push(label ?? 'command')
        if (label === 'yt-dlp') {
          const template = args[args.indexOf('-o') + 1]
          writeFileSync(template.replace('%(ext)s', 'mp4'), 'media')
          return
        }
        const output = args.at(-1)
        if (output && !output.includes('%(ext)s')) writeFileSync(output, 'media')
      }
    })

    const result = await downloadVideo(request)
    expect(result.strategy).toBe('yt-dlp')
    expect(result.failures).toEqual([
      { strategy: 'public-page', message: 'Bilibili API HTTP 412' }
    ])
    expect(calls.filter((item) => item === 'native')).toHaveLength(3)
    expect(calls.at(-1)).toBe('yt-dlp')
  })

  it('reports both native and yt-dlp failures when both paths fail', async () => {
    const request = createRequest({
      resolvePublicMedia: async () => {
        throw new Error('原生解析失败')
      },
      runCommand: async (_command, _args, _onLine, label) => {
        if (label === 'yt-dlp') throw new Error('HTTP Error 412: Precondition Failed')
      }
    })

    await expect(downloadVideo(request)).rejects.toThrow(/Bilibili 下载失败.*public-page.*yt-dlp/)
  })
})
