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
    asrLightModelDirectory: join(modelsDirectory, 'faster-whisper-large-v3-turbo-int8-ct2'),
    defaultAsrModel: 'faster-whisper-large-v3-turbo',
    translationModelDirectory: join(modelsDirectory, 'nllb-200-distilled-600M-multilang-ft-ct2'),
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
  it('isolates cached snapshots and reloads when runtime.json changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-runtime-cache-'))
    temporaryRoots.push(root)
    const modelsDirectory = join(root, 'models')
    const runtimeFile = join(root, 'runtime.json')
    const initial = defaults(modelsDirectory)
    writeFileSync(runtimeFile, JSON.stringify(initial), 'utf8')
    const store = new RuntimeStore(runtimeFile, initial)

    const first = store.read()
    first.outputDirectory = 'mutated-outside-store'
    expect(store.read().outputDirectory).toBe(initial.outputDirectory)

    const changed = { ...initial, outputDirectory: join(root, 'changed-output-directory') }
    writeFileSync(runtimeFile, JSON.stringify(changed), 'utf8')
    expect(store.read().outputDirectory).toBe(changed.outputDirectory)
  })

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
    expect(config.asrLightModelDirectory).toBe(join(modelsDirectory, 'faster-whisper-large-v3-turbo-int8-ct2'))
    expect(config.defaultAsrModel).toBe('faster-whisper-large-v3-turbo')
    expect(existsSync(runtimeFile)).toBe(true)
  })

  it('pins bundled vendor paths but keeps user model directories when packaging lock is enabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-runtime-pin-'))
    temporaryRoots.push(root)
    const bundled = join(root, 'bundled')
    const stale = join(root, 'stale-dev-paths')
    const runtimeFile = join(root, 'runtime.json')
    const bundledDefaults = defaults(bundled)
    const userModels = join(stale, 'external-models')
    writeFileSync(runtimeFile, JSON.stringify({
      ...defaults(stale),
      modelsDirectory: userModels,
      asrModelDirectory: join(userModels, 'faster-whisper-large-v3'),
      ytdlpDirectory: join(stale, 'yt-dlp'),
      ffmpegDirectory: join(stale, 'ffmpeg'),
      ytdlpPlatformAuth: {
        ...defaultPlatformAuth(),
        instagram: { mode: 'paste', cookies: 'sessionid=should-stay' }
      },
      debugMode: true
    }), 'utf8')

    const config = new RuntimeStore(runtimeFile, bundledDefaults, true).read()

    expect(config.modelsDirectory).toBe(userModels)
    expect(config.asrModelDirectory).toBe(join(userModels, 'faster-whisper-large-v3'))
    expect(config.ytdlpDirectory).toBe(bundledDefaults.ytdlpDirectory)
    expect(config.ffmpegDirectory).toBe(bundledDefaults.ffmpegDirectory)
    expect(config.denoDirectory).toBe(bundledDefaults.denoDirectory)
    expect(config.asrModelDirectory).toBe(join(userModels, 'faster-whisper-large-v3'))
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

  it('migrates the experimental worktree FFmpeg path to this checkout defaults', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-runtime-exp-vendor-'))
    temporaryRoots.push(root)
    const runtimeFile = join(root, 'runtime.json')
    const configured = defaults(join(root, 'models'))
    const currentDefaults = {
      ...configured,
      ytdlpDirectory: join(root, 'current-vendor', 'yt-dlp'),
      ffmpegDirectory: join(root, 'current-vendor', 'ffmpeg', 'bin')
    }
    writeFileSync(runtimeFile, JSON.stringify({
      ...configured,
      ytdlpDirectory: 'D:\\Project\\Koubox-exp-platform-fetch\\vendor\\yt-dlp',
      ffmpegDirectory: 'D:\\Project\\Koubox-exp-platform-fetch\\vendor\\ffmpeg\\bin'
    }), 'utf8')

    const config = new RuntimeStore(runtimeFile, currentDefaults).read()

    expect(config.ytdlpDirectory).toBe(currentDefaults.ytdlpDirectory)
    expect(config.ffmpegDirectory).toBe(currentDefaults.ffmpegDirectory)
  })

  it('migrates Koubox-subtitle-tool model and vendor paths to this checkout defaults', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-runtime-subtitle-tool-'))
    temporaryRoots.push(root)
    const runtimeFile = join(root, 'runtime.json')
    const currentModels = join(root, 'models')
    const configured = defaults(currentModels)
    const currentDefaults = {
      ...configured,
      ytdlpDirectory: join(root, 'current-vendor', 'yt-dlp'),
      ffmpegDirectory: join(root, 'current-vendor', 'ffmpeg', 'bin'),
      denoDirectory: join(root, 'current-vendor', 'deno')
    }
    writeFileSync(runtimeFile, JSON.stringify({
      ...configured,
      modelsDirectory: 'D:\\Project\\Koubox-subtitle-tool\\models',
      asrModelDirectory: 'D:\\Project\\Koubox-subtitle-tool\\models\\faster-whisper-large-v3',
      asrLightModelDirectory: 'D:\\Project\\Koubox-subtitle-tool\\models\\faster-whisper-large-v3-turbo-int8-ct2',
      translationModelDirectory: 'D:\\Project\\Koubox-subtitle-tool\\models\\nllb-200-distilled-600M-multilang-ft-ct2',
      demucsModelDirectory: 'D:\\Project\\Koubox-subtitle-tool\\models\\demucs',
      ytdlpDirectory: 'D:\\Project\\Koubox-subtitle-tool\\vendor\\yt-dlp',
      ffmpegDirectory: 'D:\\Project\\Koubox-subtitle-tool\\vendor\\ffmpeg\\bin',
      denoDirectory: 'D:\\Project\\Koubox-subtitle-tool\\vendor\\deno'
    }), 'utf8')

    const config = new RuntimeStore(runtimeFile, currentDefaults).read()

    expect(config.modelsDirectory).toBe(currentModels)
    expect(config.asrModelDirectory).toBe(join(currentModels, 'faster-whisper-large-v3'))
    expect(config.asrLightModelDirectory).toBe(join(currentModels, 'faster-whisper-large-v3-turbo-int8-ct2'))
    expect(config.translationModelDirectory).toBe(join(currentModels, 'nllb-200-distilled-600M-multilang-ft-ct2'))
    expect(config.demucsModelDirectory).toBe(join(currentModels, 'demucs'))
    expect(config.ytdlpDirectory).toBe(currentDefaults.ytdlpDirectory)
    expect(config.ffmpegDirectory).toBe(currentDefaults.ffmpegDirectory)
    expect(config.denoDirectory).toBe(currentDefaults.denoDirectory)
  })

  it('migrates legacy Hy-MT2 translation directory to NLLB CT2', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-runtime-nllb-migrate-'))
    temporaryRoots.push(root)
    const runtimeFile = join(root, 'runtime.json')
    const currentModels = join(root, 'models')
    const configured = defaults(currentModels)
    writeFileSync(runtimeFile, JSON.stringify({
      ...configured,
      translationModelDirectory: join(currentModels, 'HYMT21.8B')
    }), 'utf8')

    const config = new RuntimeStore(runtimeFile, configured).read()

    expect(config.translationModelDirectory).toBe(join(currentModels, 'nllb-200-distilled-600M-multilang-ft-ct2'))
  })

  it('migrates old Koubox model paths to the current checkout models directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-runtime-model-paths-'))
    temporaryRoots.push(root)
    const runtimeFile = join(root, 'runtime.json')
    const currentModels = join(root, 'models')
    const configured = defaults(currentModels)
    writeFileSync(runtimeFile, JSON.stringify({
      ...configured,
      modelsDirectory: 'D:\\Project\\Koubox\\models',
      asrModelDirectory: 'D:\\Project\\Koubox\\models\\faster-whisper-large-v3',
      translationModelDirectory: 'D:\\Project\\Koubox\\models\\nllb-200-distilled-600M-multilang-ft-ct2',
      demucsModelDirectory: 'D:\\Project\\Koubox\\models\\demucs'
    }), 'utf8')

    const config = new RuntimeStore(runtimeFile, configured).read()

    expect(config.modelsDirectory).toBe(currentModels)
    expect(config.asrModelDirectory).toBe(join(currentModels, 'faster-whisper-large-v3'))
    expect(config.translationModelDirectory).toBe(join(currentModels, 'nllb-200-distilled-600M-multilang-ft-ct2'))
    expect(config.demucsModelDirectory).toBe(join(currentModels, 'demucs'))
    const persisted = JSON.parse(readFileSync(runtimeFile, 'utf8')) as KouboxConfig
    expect(persisted.modelsDirectory).toBe(currentModels)
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

  it('leaves tool paths configurable in development while pinning them when packaged', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-runtime-bundled-download-tools-'))
    temporaryRoots.push(root)
    const runtimeFile = join(root, 'runtime.json')
    const bundled = defaults(join(root, 'bundled'))
    const custom = defaults(join(root, 'custom'))
    writeFileSync(runtimeFile, JSON.stringify(custom), 'utf8')

    const devConfig = new RuntimeStore(runtimeFile, bundled).read()

    expect(devConfig.ytdlpDirectory).toBe(custom.ytdlpDirectory)
    expect(devConfig.denoDirectory).toBe(custom.denoDirectory)
    expect(devConfig.ffmpegDirectory).toBe(custom.ffmpegDirectory)

    const packagedConfig = new RuntimeStore(runtimeFile, bundled, true).read()

    expect(packagedConfig.ytdlpDirectory).toBe(bundled.ytdlpDirectory)
    expect(packagedConfig.denoDirectory).toBe(bundled.denoDirectory)
    expect(packagedConfig.ffmpegDirectory).toBe(bundled.ffmpegDirectory)
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
