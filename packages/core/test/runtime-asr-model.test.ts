import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { KouboxConfig } from '@koubox/shared'
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
    translationTargetLanguage: 'zh-Hans',
    asrLanguage: 'auto',
    openOutputOnComplete: false,
    ytdlpProxy: '',
    ytdlpCookieSource: 'none',
    ytdlpCookiesPath: '',
    ytdlpInstagramCookies: '',
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
      ytdlpInstagramCookies: 'sessionid=should-stay',
      debugMode: true
    }), 'utf8')

    const config = new RuntimeStore(runtimeFile, bundledDefaults, true).read()

    expect(config.modelsDirectory).toBe(bundled)
    expect(config.ytdlpDirectory).toBe(bundledDefaults.ytdlpDirectory)
    expect(config.ffmpegDirectory).toBe(bundledDefaults.ffmpegDirectory)
    expect(config.asrModelDirectory).toBe(bundledDefaults.asrModelDirectory)
    expect(config.ytdlpInstagramCookies).toBe('sessionid=should-stay')
    expect(config.debugMode).toBe(true)
  })
})
