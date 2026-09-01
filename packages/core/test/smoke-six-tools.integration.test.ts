import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultPlatformAuth, type KouboxConfig, type TaskSnapshot } from '@koubox/shared'
import { startLocalApi } from '../src/server.js'
import { assertValidTranscript, parseSrt } from '../src/srt.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SMOKE_ENABLED = process.env.KOUBOX_SMOKE === '1'
const SMOKE_TIKTOK_URL = 'https://www.tiktok.com/@smoke/video/9999999999999999999'
const SMOKE_DOWNLOAD_URL = process.env.KOUBOX_SMOKE_DOWNLOAD_URL?.trim() || SMOKE_TIKTOK_URL

const ffmpegExecutable = join(REPO_ROOT, 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe')
const ytdlpExecutable = join(REPO_ROOT, 'vendor', 'yt-dlp', 'yt-dlp.exe')
const pythonExecutable = join(REPO_ROOT, 'python', '.venv', 'Scripts', 'python.exe')
const ffprobeExecutable = join(REPO_ROOT, 'vendor', 'ffmpeg', 'bin', 'ffprobe.exe')

type SpeechFixture = { wavPath: string; sourceText: string }

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function walkFiles(root: string): string[] {
  const result: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) result.push(...walkFiles(full))
    else if (entry.isFile()) result.push(full)
  }
  return result
}

function fixtureStem(filePath: string): string {
  return filePath
    .split(/[/\\]/).pop()!
    .replace(/(?:\.txt)+$/i, '')
    .replace(/\.wav$/i, '')
    .split(/[（(]/, 1)[0]
    .trim()
    .toLowerCase()
}

function resolveSpeechFixture(): SpeechFixture {
  const explicitWav = process.env.KOUBOX_SMOKE_SPEECH_WAV?.trim()
  const explicitText = process.env.KOUBOX_SMOKE_SOURCE_TEXT?.trim()
  if (explicitWav) {
    if (!existsSync(explicitWav)) throw new Error(`冒烟口播不存在：${explicitWav}`)
    const sourceText = explicitText && existsSync(explicitText)
      ? readFileSync(explicitText, 'utf8').replace(/^\uFEFF/, '').trim()
      : explicitText ?? ''
    if (!sourceText) throw new Error('使用 KOUBOX_SMOKE_SPEECH_WAV 时还需提供 KOUBOX_SMOKE_SOURCE_TEXT 文本或文本文件路径。')
    return { wavPath: explicitWav, sourceText }
  }

  const fixtureRoot = process.env.KOUBOX_SMOKE_FIXTURE_ROOT?.trim()
    || join(process.env.USERPROFILE ?? '', 'Desktop', '文案')
  if (!fixtureRoot || !existsSync(fixtureRoot)) {
    throw new Error(`冒烟缺少真实口播目录：${fixtureRoot || '<empty>'}`)
  }
  const files = walkFiles(fixtureRoot)
  const textFiles = files.filter((file) => /\.txt$/i.test(file))
  const candidates = files
    .filter((file) => /\.wav$/i.test(file))
    .sort((left, right) => statSync(left).size - statSync(right).size)

  for (const wavPath of candidates) {
    const stem = fixtureStem(wavPath)
    const textPath = textFiles.find((file) => fixtureStem(file) === stem)
    if (!textPath) continue
    const sourceText = readFileSync(textPath, 'utf8').replace(/^\uFEFF/, '').trim()
    if (sourceText) return { wavPath, sourceText }
  }
  throw new Error(`冒烟目录没有找到 WAV 与对应文案：${fixtureRoot}`)
}

function assertSmokePrerequisites(): SpeechFixture {
  for (const path of [ffmpegExecutable, ffprobeExecutable, ytdlpExecutable, pythonExecutable]) {
    if (!existsSync(path)) throw new Error(`冒烟缺少依赖：${path}`)
  }
  if (!existsSync(join(REPO_ROOT, 'models', 'faster-whisper-large-v3-turbo-int8-ct2'))) {
    throw new Error('冒烟缺少 ASR 轻量模型：models/faster-whisper-large-v3-turbo-int8-ct2')
  }
  return resolveSpeechFixture()
}

function buildConfig(outputDirectory: string): KouboxConfig {
  return {
    modelsDirectory: join(REPO_ROOT, 'models'),
    outputDirectory,
    asrModelDirectory: join(REPO_ROOT, 'models', 'faster-whisper-large-v3'),
    asrLightModelDirectory: join(REPO_ROOT, 'models', 'faster-whisper-large-v3-turbo-int8-ct2'),
    defaultAsrModel: 'faster-whisper-large-v3-turbo',
    translationModelDirectory: join(REPO_ROOT, 'models', 'HYMT21.8B'),
    demucsModelDirectory: join(REPO_ROOT, 'models', 'demucs'),
    ytdlpDirectory: join(REPO_ROOT, 'vendor', 'yt-dlp'),
    ffmpegDirectory: join(REPO_ROOT, 'vendor', 'ffmpeg', 'bin'),
    denoDirectory: join(REPO_ROOT, 'vendor', 'deno'),
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
    pythonExecutable,
    debugMode: false
  }
}

function generateFixtures(fixtureDir: string, speech: SpeechFixture): { wavPath: string; mp4Path: string } {
  mkdirSync(fixtureDir, { recursive: true })
  const wavPath = join(fixtureDir, 'smoke.wav')
  const mp4Path = join(fixtureDir, 'smoke.mp4')
  copyFileSync(speech.wavPath, wavPath)
  const mp4Result = spawnSync(ffmpegExecutable, [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=15',
    '-i', wavPath,
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mp4Path
  ], { encoding: 'utf8' })
  if (mp4Result.status !== 0) {
    throw new Error(`生成测试视频失败：${mp4Result.stderr || mp4Result.stdout}`)
  }
  return { wavPath, mp4Path }
}

function assertMediaStream(filePath: string, streamType: 'audio' | 'video'): void {
  expect(existsSync(filePath)).toBe(true)
  expect(statSync(filePath).size).toBeGreaterThan(0)
  const probe = spawnSync(ffprobeExecutable, [
    '-v', 'error', '-select_streams', `${streamType === 'audio' ? 'a' : 'v'}:0`,
    '-show_entries', 'stream=codec_type', '-of', 'default=noprint_wrappers=1:nokey=1', filePath
  ], { encoding: 'utf8' })
  expect(probe.status, probe.stderr || probe.stdout).toBe(0)
  expect(probe.stdout.trim()).toBe(streamType)
}

type SmokeApi = Awaited<ReturnType<typeof startLocalApi>>

async function postPipeline(
  api: SmokeApi,
  path: string,
  body: Record<string, unknown>
): Promise<TaskSnapshot> {
  const response = await fetch(`${api.baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  expect(response.status).toBe(202)
  return response.json() as Promise<TaskSnapshot>
}

async function waitForTask(api: SmokeApi, taskId: string, timeoutMs: number): Promise<TaskSnapshot> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${api.baseUrl}/tasks/${encodeURIComponent(taskId)}`, {
      headers: { authorization: `Bearer ${api.token}` }
    })
    expect(response.status).toBe(200)
    const task = await response.json() as TaskSnapshot
    if (task.status === 'complete') return task
    if (task.status === 'error') {
      throw new Error(`${taskId} 失败：${task.error?.message ?? task.message ?? '未知错误'}`)
    }
    await sleep(2_000)
  }
  throw new Error(`${taskId} 超时（${timeoutMs}ms）`)
}

describe.skipIf(!SMOKE_ENABLED)('six tools smoke', () => {
  let api: SmokeApi
  let fixtureDir: string
  let outputRoot: string
  let wavPath: string
  let mp4Path: string
  let sourceText: string

  beforeAll(async () => {
    const speech = assertSmokePrerequisites()
    sourceText = speech.sourceText
    fixtureDir = mkdtempSync(join(tmpdir(), 'koubox-smoke-fixtures-'))
    outputRoot = mkdtempSync(join(tmpdir(), 'koubox-smoke-output-'))
    ;({ wavPath, mp4Path } = generateFixtures(fixtureDir, speech))
    api = await startLocalApi({
      configFile: join(outputRoot, 'runtime.json'),
      defaults: buildConfig(outputRoot),
      projectDirectory: REPO_ROOT,
      pythonProjectDirectory: join(REPO_ROOT, 'python'),
      selectDirectory: async () => undefined,
      selectAudioFile: async () => undefined,
      selectFile: async () => undefined,
      openPath: async () => undefined,
      openLoginWindow: async () => undefined,
      getLoginCookieStatus: async () => ({ status: 'unknown' } as never),
      resolveActiveYtdlp: () => ({ executable: ytdlpExecutable } as never),
      checkYtdlpUpdate: async () => ({ status: 'unknown' } as never),
      installYtdlpUpdate: async () => ({ status: 'unknown' } as never),
      restoreBundledYtdlp: async () => ({ status: 'unknown' } as never),
      downloadTikTokPublic: async (_url, directory, fileStem) => {
        const dest = join(directory, `${fileStem}.mp4`)
        copyFileSync(mp4Path, dest)
        return dest
      }
    })
  }, 120_000)

  afterAll(async () => {
    await api?.close()
    for (const dir of [fixtureDir, outputRoot]) {
      if (dir) {
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows file lock */ }
      }
    }
  })

  it('视频提取音频（本地视频）', async () => {
    const queued = await postPipeline(api, '/pipelines/video-audio', {
      outputDirectory: outputRoot,
      videoPath: mp4Path
    })
    const task = await waitForTask(api, queued.taskId, 120_000)
    expect(task.artifacts.audio).toBeTruthy()
    assertMediaStream(task.artifacts.audio!, 'audio')
  }, 180_000)

  it('语音转文字', async () => {
    const queued = await postPipeline(api, '/pipelines/speech-to-text', {
      outputDirectory: outputRoot,
      mediaPath: wavPath
    })
    const task = await waitForTask(api, queued.taskId, 300_000)
    expect(task.transcript?.segments?.length).toBeGreaterThan(0)
    expect(task.artifacts.transcriptText).toBeTruthy()
    expect(readFileSync(task.artifacts.transcriptText!, 'utf8').trim()).not.toBe('')
  }, 360_000)

  it('人声分离', async () => {
    const queued = await postPipeline(api, '/pipelines/vocal-separation', {
      outputDirectory: outputRoot,
      audioPath: wavPath
    })
    const task = await waitForTask(api, queued.taskId, 600_000)
    expect(task.artifacts.vocals).toBeTruthy()
    assertMediaStream(task.artifacts.vocals!, 'audio')
  }, 660_000)

  it('精准 SRT（真实文案对齐）', async () => {
    const queued = await postPipeline(api, '/pipelines/req2', {
      outputDirectory: outputRoot,
      audioPath: wavPath,
      sourceText,
      language: 'auto',
      speechRateMode: 'auto'
    })
    const task = await waitForTask(api, queued.taskId, 900_000)
    expect(task.artifacts.srt).toBeTruthy()
    const transcript = parseSrt(readFileSync(task.artifacts.srt!, 'utf8'))
    expect(transcript.segments.length).toBeGreaterThan(0)
    assertValidTranscript({ ...transcript, language: task.detectedLanguage })
  }, 960_000)

  it('爆款素材获取（本地视频）', async () => {
    const queued = await postPipeline(api, '/pipelines/req1', {
      outputDirectory: outputRoot,
      videoPath: mp4Path,
      separateVocals: true
    })
    const task = await waitForTask(api, queued.taskId, 900_000)
    expect(task.artifacts.audio).toBeTruthy()
    assertMediaStream(task.artifacts.audio!, 'audio')
    expect(task.artifacts.vocals).toBeTruthy()
    assertMediaStream(task.artifacts.vocals!, 'audio')
    const transcriptReady = Boolean(task.artifacts.transcriptText && existsSync(task.artifacts.transcriptText))
      || (task.transcript?.segments?.length ?? 0) > 0
    expect(transcriptReady).toBe(true)
  }, 960_000)

  it('视频下载', async () => {
    const queued = await postPipeline(api, '/pipelines/download', {
      outputDirectory: outputRoot,
      url: SMOKE_DOWNLOAD_URL
    })
    const task = await waitForTask(api, queued.taskId, 300_000)
    expect(task.artifacts.video).toBeTruthy()
    assertMediaStream(task.artifacts.video!, 'video')
    assertMediaStream(task.artifacts.video!, 'audio')
  }, 360_000)
})
