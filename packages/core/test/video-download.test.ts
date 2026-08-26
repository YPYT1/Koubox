import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { downloadVideo, type VideoDownloadRequest } from '../src/video-download.js'
import type { PublicMediaResolution } from '../src/public-video.js'

function createRequest(overrides: Partial<VideoDownloadRequest> = {}): VideoDownloadRequest {
  const directory = mkdtempSync(join(tmpdir(), 'koubox-video-download-'))
  mkdirSync(directory, { recursive: true })
  return {
    url: 'https://www.tiktok.com/@creator/video/123',
    directory,
    fileStem: 'Tiktok_20260825_001',
    vendor: {
      ytdlpExecutable: join(directory, 'yt-dlp.exe'),
      ffmpegExecutable: join(directory, 'ffmpeg.exe'),
      denoExecutable: join(directory, 'deno.exe')
    },
    config: {
      ytdlpProxy: '',
      ytdlpMaxHeight: 0,
      ytdlpExtraArgs: ''
    },
    updateProgress: () => undefined,
    runCommand: async (_command, args) => {
      const output = args.at(-1)
      if (output && !output.includes('%(ext)s')) writeFileSync(output, 'media')
    },
    verifyMediaFile: async () => ({
      duration: 1,
      size: 5,
      videoCodec: 'h265',
      audioCodec: 'aac',
      width: 1080,
      height: 1920
    }),
    ...overrides
  }
}

const directResolution: PublicMediaResolution = {
  source: 'tiktok-page',
  videoUrl: 'https://cdn.example/direct.mp4',
  referer: 'https://www.tiktok.com/',
  userAgent: 'test-agent'
}

describe('public video download pipeline', () => {
  it('uses a directly resolved public stream before browser or yt-dlp fallbacks', async () => {
    const calls: string[] = []
    const request = createRequest({
      resolvePublicMedia: async () => {
        calls.push('direct')
        return directResolution
      },
      resolveTikTokBrowserMedia: async () => {
        calls.push('browser')
        return { ...directResolution, source: 'browser' }
      },
      runCommand: async (_command, args, _onLine, label) => {
        calls.push(label ?? 'command')
        const output = args.at(-1)
        if (output) writeFileSync(output, 'media')
      }
    })

    const result = await downloadVideo(request)

    expect(result.strategy).toBe('public-page')
    expect(calls).toEqual(['direct', '公开媒体下载'])
  })

  it('falls back to the anonymous TikTok browser after direct page resolution fails', async () => {
    const calls: string[] = []
    const request = createRequest({
      resolvePublicMedia: async () => {
        calls.push('direct')
        throw new Error('challenge')
      },
      resolveTikTokBrowserMedia: async () => {
        calls.push('browser')
        return { ...directResolution, source: 'browser' }
      },
      runCommand: async (_command, args, _onLine, label) => {
        calls.push(label ?? 'command')
        const output = args.at(-1)
        if (output) writeFileSync(output, 'media')
      }
    })

    const result = await downloadVideo(request)

    expect(result.strategy).toBe('tiktok-browser')
    expect(calls).toEqual(['direct', 'browser', '公开媒体下载'])
  })

  it('tries alternate public media URLs before leaving the public-page strategy', async () => {
    const attemptedInputs: string[] = []
    const request = createRequest({
      resolvePublicMedia: async () => ({
        ...directResolution,
        videoUrl: 'https://cdn.example/expired.mp4',
        alternateVideoUrls: ['https://cdn.example/live.mp4']
      }),
      runCommand: async (_command, args) => {
        const input = args[args.indexOf('-i') + 1]
        attemptedInputs.push(input)
        if (input.includes('expired')) throw new Error('HTTP 403')
        writeFileSync(args.at(-1)!, 'media')
      }
    })

    const result = await downloadVideo(request)

    expect(result.strategy).toBe('public-page')
    expect(attemptedInputs).toEqual([
      'https://cdn.example/expired.mp4',
      'https://cdn.example/live.mp4'
    ])
  })

  it('stops after public strategies when no platform authentication is configured', async () => {
    const calls: string[] = []
    let ytdlpArgs: string[] = []
    const request = createRequest({
      config: {
        ytdlpProxy: '',
        ytdlpMaxHeight: 0,
        ytdlpExtraArgs: '--cookies account.txt --retries 2 --cookies-from-browser chrome --netrc-location auth.netrc -u user -p pass --config-locations secret.conf'
      },
      resolvePublicMedia: async () => {
        calls.push('direct')
        throw new Error('challenge')
      },
      resolveTikTokBrowserMedia: async () => {
        calls.push('browser')
        throw new Error('no stream')
      },
      resolveAuthenticatedCookies: async () => undefined,
      runCommand: async (_command, args, _onLine, label) => {
        calls.push(label ?? 'command')
        if (label === 'yt-dlp') {
          ytdlpArgs = args
          const template = args[args.indexOf('-o') + 1]
          writeFileSync(template.replace('%(ext)s', 'mp4'), 'media')
        }
      }
    })

    await expect(downloadVideo(request)).rejects.toThrow('TikTok 公开视频解析失败')

    expect(calls).toEqual(['direct', 'browser', 'browser', 'browser'])
    expect(ytdlpArgs).toEqual([])
  })

  it('never forwards yt-dlp self-update flags from advanced arguments', async () => {
    let downloadArgs: string[] = []
    const request = createRequest({
      url: 'https://www.youtube.com/watch?v=123',
      config: {
        ytdlpProxy: '',
        ytdlpMaxHeight: 0,
        ytdlpExtraArgs: '-U --update --update-to nightly --retries 2'
      },
      resolveAuthenticatedCookies: async () => ({
        path: join(request.directory, 'youtube.cookies.txt'),
        platform: 'YouTube',
        source: 'paste',
        cleanup: async () => undefined
      }),
      runCommand: async (_command, args, _onLine, label) => {
        if (label !== 'yt-dlp') return
        downloadArgs = args
        const template = args[args.indexOf('-o') + 1]
        writeFileSync(template.replace('%(ext)s', 'mp4'), 'media')
      }
    })

    await downloadVideo(request)

    expect(downloadArgs).not.toContain('-U')
    expect(downloadArgs).not.toContain('--update')
    expect(downloadArgs).not.toContain('--update-to')
    expect(downloadArgs).not.toContain('nightly')
    expect(downloadArgs).toEqual(expect.arrayContaining(['--retries', '2']))
  })

  it.each([
    ['https://www.youtube.com/watch?v=123', 'YouTube'],
    ['https://www.tiktok.com/@creator/video/123', 'TikTok'],
    ['https://www.instagram.com/reel/abc', 'Instagram'],
    ['https://www.facebook.com/watch/?v=1234567890', 'Facebook']
  ] as const)('uses the selected platform authentication for %s after public strategies fail', async (url, platform) => {
    const calls: string[] = []
    let cookieArgument = ''
    let cleaned = false
    const request = createRequest({
      url,
      resolvePublicMedia: async () => {
        calls.push('public')
        throw new Error('public unavailable')
      },
      resolveFacebookPublicMedia: async () => {
        calls.push('facebook-public')
        throw new Error('facebook public unavailable')
      },
      resolveAuthenticatedCookies: async (actualPlatform) => {
        expect(actualPlatform).toBe(platform)
        return {
          path: join(request.directory, `${actualPlatform}.cookies.txt`),
          platform: actualPlatform,
          source: 'paste',
          userAgent: `browser-agent-${actualPlatform}`,
          cleanup: async () => { cleaned = true }
        }
      },
      runCommand: async (_command, args, _onLine, label) => {
        calls.push(label ?? 'command')
        if (label !== 'yt-dlp') return
        cookieArgument = args[args.indexOf('--cookies') + 1]
        const template = args[args.indexOf('-o') + 1]
        writeFileSync(template.replace('%(ext)s', 'mp4'), 'media')
      }
    })

    const result = await downloadVideo(request)

    expect(result.strategy).toBe('yt-dlp-authenticated')
    expect(cookieArgument).toBe(join(request.directory, `${platform}.cookies.txt`))
    expect(cleaned).toBe(true)
    const preflightCall = calls.indexOf('yt-dlp 认证预检')
    expect(preflightCall).toBeGreaterThanOrEqual(0)
    expect(calls).toContain('yt-dlp')
  })

  it('preflights authenticated yt-dlp with the exported browser User-Agent and proxy before downloading', async () => {
    const commands: Array<{ label?: string; args: string[] }> = []
    const request = createRequest({
      url: 'https://www.youtube.com/watch?v=123',
      config: { ytdlpProxy: '127.0.0.1:7897', ytdlpMaxHeight: 0, ytdlpExtraArgs: '' },
      resolveAuthenticatedCookies: async () => ({
        path: join(request.directory, 'youtube.cookies.txt'),
        platform: 'YouTube',
        source: 'builtin',
        userAgent: 'Mozilla/5.0 Browser Profile UA',
        cleanup: async () => undefined
      }),
      runCommand: async (_command, args, _onLine, label) => {
        commands.push({ label, args })
        if (label === 'yt-dlp') {
          const template = args[args.indexOf('-o') + 1]
          writeFileSync(template.replace('%(ext)s', 'mp4'), 'media')
        }
      }
    })

    await downloadVideo(request)

    const preflight = commands.find((command) => command.label === 'yt-dlp 认证预检')!.args
    expect(preflight).toEqual(expect.arrayContaining([
      '--skip-download', '--simulate', '--cookies', join(request.directory, 'youtube.cookies.txt'),
      '--user-agent', 'Mozilla/5.0 Browser Profile UA', '--proxy', 'http://127.0.0.1:7897',
      '--js-runtimes', `deno:${join(request.directory, 'deno.exe')}`
    ]))
    expect(commands.map((command) => command.label)).toEqual(['yt-dlp 认证预检', 'yt-dlp'])
  })

  it('reports a YouTube authentication preflight failure as browser login valid but yt-dlp rejected it', async () => {
    const request = createRequest({
      url: 'https://www.youtube.com/watch?v=123',
      resolveAuthenticatedCookies: async () => ({
        path: join(request.directory, 'youtube.cookies.txt'),
        platform: 'YouTube',
        source: 'paste',
        userAgent: 'browser-agent',
        cleanup: async () => undefined
      }),
      runCommand: async (_command, _args, _onLine, label) => {
        if (label === 'yt-dlp 认证预检') throw new Error('Sign in to confirm you are not a bot')
      }
    })

    await expect(downloadVideo(request)).rejects.toThrow('YouTube 粘贴 Cookie 已配置，但 yt-dlp 鉴权失败：Sign in to confirm you are not a bot')
  })

  it('re-resolves an expired direct media URL before failing over to another strategy', async () => {
    const calls: string[] = []
    let mediaAttempts = 0
    const request = createRequest({
      resolvePublicMedia: async () => {
        calls.push('direct')
        return directResolution
      },
      runCommand: async (_command, args, _onLine, label) => {
        calls.push(label ?? 'command')
        mediaAttempts += 1
        if (mediaAttempts === 1) throw new Error('expired URL')
        const output = args.at(-1)
        if (output) writeFileSync(output, 'media')
      }
    })

    const result = await downloadVideo(request)

    expect(result.strategy).toBe('public-page')
    expect(calls).toEqual(['direct', '公开媒体下载', 'direct', '公开媒体下载'])
  })

  it('uses Facebook authentication only after public and anonymous Chromium strategies fail', async () => {
    const calls: string[] = []
    const request = createRequest({
      url: 'https://www.facebook.com/watch/?v=1234567890',
      resolveFacebookPublicMedia: async () => {
        calls.push('page')
        throw new Error('no page media')
      },
      resolveFacebookAnonymousMedia: async () => {
        calls.push('anonymous-browser')
        throw new Error('no browser media')
      },
      resolveAuthenticatedCookies: async () => ({
        path: join(request.directory, 'facebook.cookies.txt'),
        platform: 'Facebook',
        source: 'builtin',
        cleanup: async () => undefined
      }),
      runCommand: async (_command, args, _onLine, label) => {
        calls.push(label ?? 'command')
        if (label === 'yt-dlp') {
          const template = args[args.indexOf('-o') + 1]
          writeFileSync(template.replace('%(ext)s', 'mp4'), 'media')
        }
      }
    })

    const result = await downloadVideo(request)

    expect(result.strategy).toBe('yt-dlp-authenticated')
    expect(calls).toEqual(['page', 'anonymous-browser', 'yt-dlp 认证预检', 'yt-dlp'])
  })
})
