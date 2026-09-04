/**
 * Live end-to-end probe: native Bilibili playurl download, then optional yt-dlp fallback simulation.
 * Run: npx vitest run test/bilibili-download.integration.test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { defaultPlatformAuth } from '@koubox/shared'
import { resolveBilibiliPublicMedia } from '../src/bilibili.js'
import { downloadVideo, verifyDownloadedMedia, type VideoDownloadRequest } from '../src/video-download.js'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const ffmpegExecutable = join(REPO_ROOT, 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe')
const ytdlpExecutable = join(REPO_ROOT, 'vendor', 'yt-dlp', 'yt-dlp.exe')
const denoExecutable = join(REPO_ROOT, 'vendor', 'deno', 'deno.exe')
const SAMPLE_URL = 'https://www.bilibili.com/video/BV1CJbc6JExi'

function runCommand(command: string, args: string[], onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) onLine?.(line)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderr += text
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onLine?.(line)
      }
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} 退出码 ${code}: ${stderr.slice(-800)}`))
    })
  })
}

describe('Bilibili live download integration', () => {
  it('downloads a public BV via native playurl + ffmpeg', async () => {
    for (const path of [ffmpegExecutable]) {
      if (!existsSync(path)) throw new Error(`缺少依赖：${path}`)
    }
    const directory = mkdtempSync(join(tmpdir(), 'koubox-bili-live-'))
    mkdirSync(directory, { recursive: true })
    const fileStem = 'Bilibili_native_live'
    const progress: string[] = []

    const request: VideoDownloadRequest = {
      url: SAMPLE_URL,
      directory,
      fileStem,
      vendor: {
        ytdlpExecutable,
        ffmpegExecutable,
        denoExecutable: existsSync(denoExecutable) ? denoExecutable : join(directory, 'deno.exe')
      },
      config: {
        ytdlpProxy: '',
        ytdlpMaxHeight: 480,
        ytdlpExtraArgs: '',
        ytdlpPlatformAuth: defaultPlatformAuth()
      },
      updateProgress: (_percent, message) => {
        progress.push(message)
      },
      runCommand,
      // 强制走真实原生解析，不要注入 mock
      resolveAuthenticatedCookies: async () => undefined
    }

    const result = await downloadVideo(request)
    expect(result.platform).toBe('Bilibili')
    expect(result.strategy).toBe('public-page')
    expect(existsSync(result.path)).toBe(true)
    expect(result.media.duration).toBeGreaterThan(0)
    expect(result.media.width).toBeGreaterThan(0)
    expect(result.media.height).toBeGreaterThan(0)
    expect(result.media.videoCodec.length).toBeGreaterThan(0)
    writeFileSync(join(directory, 'RESULT.json'), JSON.stringify({
      strategy: result.strategy,
      path: result.path,
      media: result.media,
      progress
    }, null, 2))
  }, 180_000)

  it('can resolve playurl then download with ffprobe verification only', async () => {
    if (!existsSync(ffmpegExecutable)) throw new Error(`缺少依赖：${ffmpegExecutable}`)
    const resolution = await resolveBilibiliPublicMedia(SAMPLE_URL, '', 480)
    expect(resolution.videoUrl).toMatch(/^https?:\/\//)

    const directory = mkdtempSync(join(tmpdir(), 'koubox-bili-resolve-dl-'))
    const out = join(directory, 'direct.mp4')
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-user_agent', resolution.userAgent,
      '-referer', resolution.referer,
      '-i', resolution.videoUrl
    ]
    if (resolution.audioUrl) {
      args.push('-user_agent', resolution.userAgent, '-referer', resolution.referer, '-i', resolution.audioUrl)
      args.push('-map', '0:v:0', '-map', '1:a:0')
    } else {
      args.push('-map', '0:v:0', '-map', '0:a:0?')
    }
    args.push('-c', 'copy', '-movflags', '+faststart', out)
    await runCommand(ffmpegExecutable, args)
    const media = await verifyDownloadedMedia(out, ffmpegExecutable, { requireAudio: false })
    expect(media.duration).toBeGreaterThan(0)
    expect(dirname(out)).toBe(directory)
  }, 180_000)
})
