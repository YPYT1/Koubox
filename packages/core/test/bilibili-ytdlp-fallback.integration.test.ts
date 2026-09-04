import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { defaultPlatformAuth } from '@koubox/shared'
import { downloadVideo, type VideoDownloadRequest } from '../src/video-download.js'

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
      for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) onLine?.(line)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderr += text
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine?.(line)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} 退出码 ${code}: ${stderr.slice(-800)}`))
    })
  })
}

describe('Bilibili yt-dlp fallback live', () => {
  it('invokes real yt-dlp after native resolver fails', async () => {
    for (const path of [ffmpegExecutable, ytdlpExecutable]) {
      if (!existsSync(path)) throw new Error(`缺少依赖：${path}`)
    }
    const directory = mkdtempSync(join(tmpdir(), 'koubox-bili-ytdlp-'))
    mkdirSync(directory, { recursive: true })
    const ytdlpCalls: string[][] = []
    const request: VideoDownloadRequest = {
      url: SAMPLE_URL,
      directory,
      fileStem: 'Bilibili_ytdlp_fallback',
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
      updateProgress: () => undefined,
      runCommand: async (command, args, onLine, label) => {
        if (label === 'yt-dlp') ytdlpCalls.push(args)
        return runCommand(command, args, onLine)
      },
      resolvePublicMedia: async () => {
        throw new Error('forced native failure for yt-dlp fallback probe')
      },
      resolveAuthenticatedCookies: async () => undefined
    }

    const outcome = await downloadVideo(request).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error })
    )

    expect(ytdlpCalls.length).toBeGreaterThan(0)
    expect(ytdlpCalls[0]).toEqual(expect.arrayContaining(['--referer', 'https://www.bilibili.com/']))

    if (outcome.ok) {
      expect(outcome.result.strategy).toBe('yt-dlp')
      expect(outcome.result.failures[0]?.strategy).toBe('public-page')
      expect(existsSync(outcome.result.path)).toBe(true)
      return
    }

    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
    expect(message).toContain('public-page：forced native failure for yt-dlp fallback probe')
    expect(message).toContain('yt-dlp：')
  }, 300_000)
})
