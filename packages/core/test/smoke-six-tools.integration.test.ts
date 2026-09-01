import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultPlatformAuth, type KouboxConfig, type TaskSnapshot } from '@koubox/shared'
import { startLocalApi } from '../src/server.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SMOKE_ENABLED = process.env.KOUBOX_SMOKE === '1'
const SMOKE_TIKTOK_URL = 'https://www.tiktok.com/@smoke/video/9999999999999999999'
const SMOKE_DOWNLOAD_URL = process.env.KOUBOX_SMOKE_DOWNLOAD_URL?.trim() || SMOKE_TIKTOK_URL

const ffmpegExecutable = join(REPO_ROOT, 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe')
const ytdlpExecutable = join(REPO_ROOT, 'vendor', 'yt-dlp', 'yt-dlp.exe')
const pythonExecutable = join(REPO_ROOT, 'python', '.venv', 'Scripts', 'python.exe')

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function assertSmokePrerequisites(): void {
  for (const path of [ffmpegExecutable, ytdlpExecutable, pythonExecutable]) {
    if (!existsSync(path)) throw new Error(`冒烟缺少依赖：${path}`)
  }
  if (!existsSync(join(REPO_ROOT, 'models', 'faster-whisper-large-v3'))) {
    throw new Error('冒烟缺少 ASR 模型：models/faster-whisper-large-v3')
  }
}

function buildConfig(outputDirectory: string): KouboxConfig {
  return {
    modelsDirectory: join(REPO_ROOT, 'models'),
    outputDirectory,
    asrModelDirectory: join(REPO_ROOT, 'models', 'faster-whisper-large-v3'),
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

function generateFixtures(fixtureDir: string): { wavPath: string; mp4Path: string } {
  mkdirSync(fixtureDir, { recursive: true })
  const wavPath = join(fixtureDir, 'smoke.wav')
  const mp4Path = join(fixtureDir, 'smoke.mp4')
  const wavResult = spawnSync(ffmpegExecutable, [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-ar', '16000', '-ac', '1', wavPath
  ], { encoding: 'utf8' })
  if (wavResult.status !== 0) {
    throw new Error(`生成测试音频失败：${wavResult.stderr || wavResult.stdout}`)
  }
  const mp4Result = spawnSync(ffmpegExecutable, [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mp4Path
  ], { encoding: 'utf8' })
  if (mp4Result.status !== 0) {
    throw new Error(`生成测试视频失败：${mp4Result.stderr || mp4Result.stdout}`)
  }
  return { wavPath, mp4Path }
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

  beforeAll(async () => {
    assertSmokePrerequisites()
    fixtureDir = mkdtempSync(join(tmpdir(), 'koubox-smoke-fixtures-'))
    outputRoot = mkdtempSync(join(tmpdir(), 'koubox-smoke-output-'))
    ;({ wavPath, mp4Path } = generateFixtures(fixtureDir))
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
    expect(existsSync(task.artifacts.audio!)).toBe(true)
  }, 180_000)

  it('语音转文字', async () => {
    const queued = await postPipeline(api, '/pipelines/speech-to-text', {
      outputDirectory: outputRoot,
      mediaPath: wavPath
    })
    const task = await waitForTask(api, queued.taskId, 300_000)
    expect(task.transcript?.segments?.length).toBeGreaterThan(0)
  }, 360_000)

  it('人声分离', async () => {
    const queued = await postPipeline(api, '/pipelines/vocal-separation', {
      outputDirectory: outputRoot,
      audioPath: wavPath
    })
    const task = await waitForTask(api, queued.taskId, 600_000)
    expect(task.artifacts.vocals).toBeTruthy()
    expect(existsSync(task.artifacts.vocals!)).toBe(true)
  }, 660_000)

  it('精准 SRT（纯音频识别）', async () => {
    const queued = await postPipeline(api, '/pipelines/req2', {
      outputDirectory: outputRoot,
      audioPath: wavPath,
      language: 'auto',
      speechRateMode: 'auto'
    })
    const task = await waitForTask(api, queued.taskId, 900_000)
    expect(task.artifacts.srt).toBeTruthy()
    expect(existsSync(task.artifacts.srt!)).toBe(true)
  }, 960_000)

  it('爆款素材获取（本地视频）', async () => {
    const queued = await postPipeline(api, '/pipelines/req1', {
      outputDirectory: outputRoot,
      videoPath: mp4Path,
      separateVocals: true
    })
    const task = await waitForTask(api, queued.taskId, 900_000)
    expect(task.artifacts.audio).toBeTruthy()
    expect(existsSync(task.artifacts.audio!)).toBe(true)
    expect(task.artifacts.vocals).toBeTruthy()
    expect(existsSync(task.artifacts.vocals!)).toBe(true)
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
    expect(existsSync(task.artifacts.video!)).toBe(true)
  }, 360_000)
})
