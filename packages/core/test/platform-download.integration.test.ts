import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { defaultPlatformAuth } from '@koubox/shared'
import { createTemporaryPlatformCookieFile } from '../src/platform-auth.js'
import { downloadVideo } from '../src/video-download.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const INTEGRATION_ENABLED = process.env.KOUBOX_INTEGRATION === '1'
const OUTPUT_ROOT = process.env.KOUBOX_VERIFY_OUTPUT ?? 'C:\\Users\\Administrator\\Desktop\\8月29日'
const YOUTUBE_COOKIE_FILE = process.env.KOUBOX_YOUTUBE_COOKIES ?? 'C:\\Users\\Administrator\\Downloads\\youtube-cookies.txt'
const YOUTUBE_URL = process.env.KOUBOX_YOUTUBE_URL ?? 'https://www.youtube.com/shorts/fE36cvZY3-w'

const ffmpegExecutable = join(REPO_ROOT, 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe')
const ytdlpExecutable = join(REPO_ROOT, 'vendor', 'yt-dlp', 'yt-dlp.exe')
const denoExecutable = join(REPO_ROOT, 'vendor', 'deno', 'deno.exe')

function assertIntegrationPrerequisites(): void {
  for (const path of [ffmpegExecutable, ytdlpExecutable, denoExecutable]) {
    if (!existsSync(path)) throw new Error(`集成测试缺少依赖：${path}`)
  }
  if (!existsSync(YOUTUBE_COOKIE_FILE)) throw new Error(`缺少 YouTube Cookie 文件：${YOUTUBE_COOKIE_FILE}`)
}

describe.runIf(INTEGRATION_ENABLED)('platform download integration', () => {
  const workDirs: string[] = []

  afterAll(() => {
    for (const dir of workDirs) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('downloads YouTube with exported cookies into verification directory', async () => {
    assertIntegrationPrerequisites()
    mkdirSync(OUTPUT_ROOT, { recursive: true })
    const directory = join(tmpdir(), `koubox-youtube-integration-${Date.now()}`)
    mkdirSync(directory, { recursive: true })
    workDirs.push(directory)

    const cookieText = readFileSync(YOUTUBE_COOKIE_FILE, 'utf8')
    const cookieFile = createTemporaryPlatformCookieFile({
      platformId: 'youtube',
      source: 'paste',
      cookieText,
      validatePastedCookies: true
    })

    const fileStem = `YouTube_integration_${Date.now()}`
    const result = await downloadVideo({
      url: YOUTUBE_URL,
      directory,
      fileStem,
      vendor: { ytdlpExecutable, ffmpegExecutable, denoExecutable },
      config: { ytdlpProxy: process.env.KOUBOX_PROXY ?? '', ytdlpMaxHeight: 720, ytdlpExtraArgs: '', ytdlpPlatformAuth: defaultPlatformAuth() },
      updateProgress: () => undefined,
      runCommand: async (command, args, onLine, commandLabel) => {
        const { spawn } = await import('node:child_process')
        await new Promise<void>((resolveRun, rejectRun) => {
          const child = spawn(command, args, { windowsHide: true })
          child.stdout.on('data', (chunk: Buffer) => {
            for (const line of chunk.toString().split(/\r?\n/)) {
              if (line.trim()) onLine?.(line)
            }
          })
          child.stderr.on('data', (chunk: Buffer) => {
            for (const line of chunk.toString().split(/\r?\n/)) {
              if (line.trim()) onLine?.(line)
            }
          })
          child.on('error', rejectRun)
          child.on('close', (code) => {
            if (code === 0) resolveRun()
            else rejectRun(new Error(`${commandLabel ?? command} 退出码 ${code}`))
          })
        })
      },
      resolveAuthenticatedCookies: async () => cookieFile
    })

    expect(result.strategy).toBe('yt-dlp-authenticated')
    expect(existsSync(result.path)).toBe(true)

    const verifyOutput = join(OUTPUT_ROOT, `${fileStem}.mp4`)
    const copy = spawnSync(ffmpegExecutable, ['-y', '-i', result.path, '-c', 'copy', verifyOutput], { encoding: 'utf8' })
    expect(copy.status).toBe(0)
    expect(existsSync(verifyOutput)).toBe(true)

    const probe = spawnSync(join(dirname(ffmpegExecutable), 'ffprobe.exe'), [
      '-v', 'error',
      '-show_entries', 'stream=codec_type',
      '-of', 'json',
      verifyOutput
    ], { encoding: 'utf8' })
    expect(probe.status).toBe(0)
    const streams = JSON.parse(probe.stdout || '{}') as { streams?: Array<{ codec_type?: string }> }
    expect(streams.streams?.some((stream) => stream.codec_type === 'video')).toBe(true)
    expect(streams.streams?.some((stream) => stream.codec_type === 'audio')).toBe(true)

    await cookieFile.cleanup()
  }, 300_000)
})
