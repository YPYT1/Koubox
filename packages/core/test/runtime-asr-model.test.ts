import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { KouboxConfig } from '@koubox/shared'
import { defaultPlatformAuth } from '@koubox/shared'
import { RuntimeStore } from '../src/runtime.js'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function defaults(modelsDirectory: string): KouboxConfig {
  return {
    modelsDirectory,
    outputDirectory: join(modelsDirectory, 'outputs'),
    asrModelDirectory: join(modelsDirectory, 'faster-whisper-large-v3'),
    translationModelDirectory: join(modelsDirectory, 'HYMT21.8B'),
    demucsModelDirectory: join(modelsDirectory, 'demucs'),
    ytdlpDirectory: join(modelsDirectory, 'yt-dlp'),
    ffmpegDirectory: join(modelsDirectory, 'ffmpeg'),
    denoDirectory: join(modelsDirectory, 'deno'),
    translationTargetLanguage: 'zh-Hans',
    asrLanguage: 'auto',
    openOutputOnComplete: false,
    ytdlpProxy: '',
    ytdlpPlatformAuth: defaultPlatformAuth(),
    ytdlpMaxHeight: 0,
    ytdlpExtraArgs: '',
    maxConcurrentTasks: 1,
    translationTemperature: 0.7,
    translationMaxNewTokens: 4096,
    translationTopP: 0.8,
    whisperChunkLengthS: 30,
    pythonExecutable: '',
    debugMode: false
  }
}

describe('Faster-Whisper ASR configuration', () => {
  it('migrates the legacy Turbo path to the Faster-Whisper Large-v3 directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-runtime-asr-'))
    temporaryRoots.push(root)
    const modelsDirectory = join(root, 'models')
    const runtimeFile = join(root, 'runtime.json')
    writeFileSync(runtimeFile, JSON.stringify({
      ...defaults(modelsDirectory),
      asrModelDirectory: join(modelsDirectory, 'whisperlargev3turbo')
    }), 'utf8')

    const config = new RuntimeStore(runtimeFile, defaults(modelsDirectory)).read()

    expect(config.asrModelDirectory).toBe(join(modelsDirectory, 'faster-whisper-large-v3'))
    expect(existsSync(runtimeFile)).toBe(true)
  })

  it('pins bundled vendor and model paths when packaging lock is enabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-runtime-pin-'))
    temporaryRoots.push(root)
    const bundled = join(root, 'bundled')
    const stale = join(root, 'stale-dev-paths')
    const runtimeFile = join(root, 'runtime.json')
    const bundledDefaults = defaults(bundled)
    writeFileSync(runtimeFile, JSON.stringify({
      ...defaults(stale),
      ytdlpDirectory: join(stale, 'yt-dlp'),
      ffmpegDirectory: join(stale, 'ffmpeg'),
      ytdlpPlatformAuth: {
        ...defaultPlatformAuth(),
        instagram: { mode: 'paste', cookies: 'sessionid=should-stay' }
      },
      debugMode: true
    }), 'utf8')

    const config = new RuntimeStore(runtimeFile, bundledDefaults, true).read()

    expect(config.modelsDirectory).toBe(bundled)
    expect(config.ytdlpDirectory).toBe(bundledDefaults.ytdlpDirectory)
    expect(config.ffmpegDirectory).toBe(bundledDefaults.ffmpegDirectory)
    expect(config.denoDirectory).toBe(bundledDefaults.denoDirectory)
    expect(config.asrModelDirectory).toBe(bundledDefaults.asrModelDirectory)
    expect(config.ytdlpPlatformAuth.instagram.cookies).toBe('sessionid=should-stay')
    expect(config.debugMode).toBe(true)
  })

  it('migrates legacy ytdlpInstagramCookies into platform auth', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-runtime-ig-'))
    temporaryRoots.push(root)
    const modelsDirectory = join(root, 'models')
    const runtimeFile = join(root, 'runtime.json')
    writeFileSync(runtimeFile, JSON.stringify({
      ...defaults(modelsDirectory),
      ytdlpInstagramCookies: 'sessionid=legacy\tds_user_id=1'
    }), 'utf8')

    const config = new RuntimeStore(runtimeFile, defaults(modelsDirectory)).read()
    expect(config.ytdlpPlatformAuth.instagram.cookies).toContain('sessionid=legacy')
    expect(config.ytdlpPlatformAuth.instagram.mode).toBe('paste')
  })

  it('migrates only the old Koubox development vendor paths to this checkout defaults', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-runtime-vendor-'))
    temporaryRoots.push(root)
    const runtimeFile = join(root, 'runtime.json')
    const configured = defaults(join(root, 'models'))
    const currentVendor = join(root, 'current-vendor')
    const currentDefaults = {
      ...configured,
      ytdlpDirectory: join(currentVendor, 'yt-dlp'),
      ffmpegDirectory: join(currentVendor, 'ffmpeg', 'bin')
    }
    writeFileSync(runtimeFile, JSON.stringify({
      ...configured,
      ytdlpDirectory: 'D:\\Project\\Koubox\\vendor\\yt-dlp',
      ffmpegDirectory: 'D:\\Project\\Koubox\\vendor\\ffmpeg\\bin'
    }), 'utf8')

    const config = new RuntimeStore(runtimeFile, currentDefaults).read()

    expect(config.ytdlpDirectory).toBe(currentDefaults.ytdlpDirectory)
    expect(config.ffmpegDirectory).toBe(currentDefaults.ffmpegDirectory)
    expect(JSON.parse(readFileSync(runtimeFile, 'utf8')).ytdlpDirectory).toBe(currentDefaults.ytdlpDirectory)
  })

  it('preserves existing per-platform modes and pasted cookie contents', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-runtime-auth-'))
    temporaryRoots.push(root)
    const runtimeFile = join(root, 'runtime.json')
    const configured = defaults(join(root, 'models'))
    const existingAuth = {
      youtube: { mode: 'builtin' as const, cookies: 'youtube-existing' },
      tiktok: { mode: 'paste' as const, cookies: 'tiktok-existing' },
      instagram: { mode: 'builtin' as const, cookies: 'instagram-existing' },
      facebook: { mode: 'paste' as const, cookies: 'facebook-existing' }
    }
    writeFileSync(runtimeFile, JSON.stringify({ ...configured, ytdlpPlatformAuth: existingAuth }), 'utf8')

    const config = new RuntimeStore(runtimeFile, configured).read()

    expect(config.ytdlpPlatformAuth).toEqual(existingAuth)
  })

  it('always pins yt-dlp and Deno to bundled runtime while leaving FFmpeg configurable in development', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-runtime-bundled-download-tools-'))
    temporaryRoots.push(root)
    const runtimeFile = join(root, 'runtime.json')
    const bundled = defaults(join(root, 'bundled'))
    const custom = defaults(join(root, 'custom'))
    writeFileSync(runtimeFile, JSON.stringify(custom), 'utf8')

    const config = new RuntimeStore(runtimeFile, bundled).read()

    expect(config.ytdlpDirectory).toBe(bundled.ytdlpDirectory)
    expect(config.denoDirectory).toBe(bundled.denoDirectory)
    expect(config.ffmpegDirectory).toBe(custom.ffmpegDirectory)
  })

  it('writes back stale yt-dlp and Deno paths so the old checkout is removed from runtime.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-runtime-stale-download-tools-'))
    temporaryRoots.push(root)
    const runtimeFile = join(root, 'runtime.json')
    const bundled = defaults(join(root, 'bundled'))
    writeFileSync(runtimeFile, JSON.stringify({
      ...bundled,
      ytdlpDirectory: 'D:\\Project\\Koubox\\vendor\\yt-dlp',
      denoDirectory: ''
    }), 'utf8')

    const config = new RuntimeStore(runtimeFile, bundled).read()
    const persisted = JSON.parse(readFileSync(runtimeFile, 'utf8')) as KouboxConfig

    expect(config.ytdlpDirectory).toBe(bundled.ytdlpDirectory)
    expect(config.denoDirectory).toBe(bundled.denoDirectory)
    expect(persisted.ytdlpDirectory).toBe(bundled.ytdlpDirectory)
    expect(persisted.denoDirectory).toBe(bundled.denoDirectory)
  })

  it('removes legacy browser selection fields without changing platform auth', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-runtime-legacy-browser-'))
    temporaryRoots.push(root)
    const runtimeFile = join(root, 'runtime.json')
    const configured = defaults(join(root, 'models'))
    writeFileSync(runtimeFile, JSON.stringify({
      ...configured,
      ytdlpCookieSource: 'builtin',
      ytdlpCookiesPath: 'old.txt',
      platformBrowserProfiles: { youtube: { browser: 'chrome' } },
      ytdlpPlatformAuth: {
        ...defaultPlatformAuth(),
        youtube: { mode: 'builtin', cookies: 'keep-me' }
      }
    }), 'utf8')

    const config = new RuntimeStore(runtimeFile, configured).read()
    const persisted = JSON.parse(readFileSync(runtimeFile, 'utf8')) as Record<string, unknown>

    expect(config.ytdlpPlatformAuth.youtube).toEqual({ mode: 'builtin', cookies: 'keep-me' })
    expect(persisted).not.toHaveProperty('ytdlpCookieSource')
    expect(persisted).not.toHaveProperty('ytdlpCookiesPath')
    expect(persisted).not.toHaveProperty('platformBrowserProfiles')
  })
})
