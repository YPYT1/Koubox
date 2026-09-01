/**
 * Real GPU verification for Mode A + turbo→large alignment fallback.
 * Run: $env:KOUBOX_REAL_ASR='1'; pnpm --filter @koubox/core exec vitest run test/precise-srt-align-fallback.integration.test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { defaultPlatformAuth, type KouboxConfig } from '@koubox/shared'
import { resolveAsrExecutionPlan } from '../src/asr-execution.js'
import { detectGpu } from '../src/runtime.js'
import { TaskManager } from '../src/tasks.js'

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const ENABLED = process.env.KOUBOX_REAL_ASR === '1'
const AUDIO = process.env.KOUBOX_ALIGN_AUDIO
  ?? 'C:\\Users\\Administrator\\Desktop\\文案\\日语\\文案_05_高信頼性材料（语速1.4-声调2-音量1.6）.wav'
const SOURCE_TEXT_FILE = process.env.KOUBOX_ALIGN_TEXT
  ?? 'C:\\Users\\Administrator\\Desktop\\文案\\日语\\文案_05_高信頼性材料.txt'

const ffmpegExecutable = join(REPO_ROOT, 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe')
const pythonExecutable = join(REPO_ROOT, 'python', '.venv', 'Scripts', 'python.exe')
const turboDir = join(REPO_ROOT, 'models', 'faster-whisper-large-v3-turbo-int8-ct2')
const largeDir = join(REPO_ROOT, 'models', 'faster-whisper-large-v3')
const realPythonSrc = join(REPO_ROOT, 'python', 'src')

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function buildConfig(outputDirectory: string): KouboxConfig {
  return {
    modelsDirectory: join(REPO_ROOT, 'models'),
    outputDirectory,
    asrModelDirectory: largeDir,
    asrLightModelDirectory: turboDir,
    defaultAsrModel: 'faster-whisper-large-v3-turbo',
    translationModelDirectory: join(REPO_ROOT, 'models', 'HYMT21.8B'),
    demucsModelDirectory: join(REPO_ROOT, 'models', 'demucs'),
    ytdlpDirectory: join(REPO_ROOT, 'vendor', 'yt-dlp'),
    ffmpegDirectory: join(REPO_ROOT, 'vendor', 'ffmpeg', 'bin'),
    denoDirectory: join(REPO_ROOT, 'vendor', 'deno'),
    translationTargetLanguage: 'zh-Hans',
    asrLanguage: 'ja',
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

async function waitTask(manager: TaskManager, taskId: string, timeoutMs: number) {
  const started = Date.now()
  let task = manager.get(taskId)
  while (task && task.status !== 'complete' && task.status !== 'error' && Date.now() - started < timeoutMs) {
    await sleep(2_000)
    task = manager.get(taskId)
  }
  return { task, elapsedMs: Date.now() - started }
}

describe.runIf(ENABLED)('precise SRT real alignment with turbo primary', () => {
  const workDirs: string[] = []

  afterAll(() => {
    for (const dir of workDirs) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* lock */ }
    }
  })

  it('completes Mode A on Japanese fixture using turbo (near-match path allowed)', async () => {
    expect(detectGpu().available, '需要可用 NVIDIA GPU').toBe(true)
    for (const path of [AUDIO, SOURCE_TEXT_FILE, ffmpegExecutable, pythonExecutable, turboDir, largeDir]) {
      expect(existsSync(path), `缺少：${path}`).toBe(true)
    }

    const root = mkdtempSync(join(tmpdir(), 'koubox-real-align-'))
    workDirs.push(root)
    const sourceText = readFileSync(SOURCE_TEXT_FILE, 'utf8').replace(/^\uFEFF/, '').trim()
    const config = buildConfig(join(root, 'outputs'))
    const plan = resolveAsrExecutionPlan(config)
    expect(plan.primary.id).toBe('faster-whisper-large-v3-turbo')
    expect(plan.fallback?.id).toBe('faster-whisper-large-v3')

    const manager = new TaskManager({
      getConfig: () => config,
      resolveVendor: () => ({
        ytdlpExecutable: join(REPO_ROOT, 'vendor', 'yt-dlp', 'yt-dlp.exe'),
        ffmpegExecutable,
        denoExecutable: join(REPO_ROOT, 'vendor', 'deno', 'deno.exe')
      }),
      projectDirectory: REPO_ROOT,
      pythonProjectDirectory: join(REPO_ROOT, 'python'),
      taskIndexFile: join(root, 'runtime', 'tasks.json')
    })

    const queued = manager.startRequirementTwo(
      AUDIO,
      sourceText,
      join(root, 'outputs'),
      { asr: largeDir, asrLight: turboDir, asrPlan: plan, translation: config.translationModelDirectory },
      'ja',
      'off'
    )
    const { task, elapsedMs } = await waitTask(manager, queued.taskId, 20 * 60_000)

    expect(task?.status, task?.error?.message ?? task?.message).toBe('complete')
    expect(task?.artifacts.srt && existsSync(task.artifacts.srt)).toBe(true)
    expect(task?.asrExecution?.selectedModel).toBe('faster-whisper-large-v3-turbo')
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      case: 'natural-turbo',
      taskId: task?.taskId,
      asrExecution: task?.asrExecution,
      srtBytes: task?.artifacts.srt ? readFileSync(task.artifacts.srt).length : 0,
      elapsedMs
    }, null, 2))
  }, 21 * 60_000)

  it('auto-falls back to Large v3 when turbo Mode A reports incomplete alignment', async () => {
    expect(detectGpu().available, '需要可用 NVIDIA GPU').toBe(true)
    for (const path of [AUDIO, SOURCE_TEXT_FILE, ffmpegExecutable, pythonExecutable, largeDir, realPythonSrc]) {
      expect(existsSync(path), `缺少：${path}`).toBe(true)
    }

    const root = mkdtempSync(join(tmpdir(), 'koubox-forced-align-fallback-'))
    workDirs.push(root)
    const sourceText = readFileSync(SOURCE_TEXT_FILE, 'utf8').replace(/^\uFEFF/, '').trim()

    const pythonRoot = join(root, 'python')
    const workerRoot = join(pythonRoot, 'src', 'koubox_runtime')
    mkdirSync(workerRoot, { recursive: true })
    writeFileSync(join(workerRoot, '__init__.py'), '', 'utf8')
    writeFileSync(join(workerRoot, '__main__.py'), [
      'import json, os, subprocess, sys',
      'request = json.loads(sys.stdin.readline())',
      'if str(request.get("computeType", "")).lower() == "int8":',
      '    print(json.dumps({"type":"error","code":"PRECISE_SRT_ALIGNMENT_INCOMPLETE","message":"模式 A 对齐结果未完整保留用户文案。"}), flush=True)',
      '    raise SystemExit(1)',
      `real_python = ${JSON.stringify(pythonExecutable)}`,
      `real_src = ${JSON.stringify(realPythonSrc)}`,
      'env = os.environ.copy()',
      'env["PYTHONPATH"] = real_src + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")',
      'proc = subprocess.run([real_python, "-m", "koubox_runtime"], input=json.dumps(request) + "\\n", text=True, capture_output=True, env=env)',
      'sys.stdout.write(proc.stdout)',
      'sys.stderr.write(proc.stderr)',
      'raise SystemExit(proc.returncode)'
    ].join('\n'), 'utf8')

    const config = buildConfig(join(root, 'outputs'))
    const plan = resolveAsrExecutionPlan(config)
    const manager = new TaskManager({
      getConfig: () => config,
      resolveVendor: () => ({
        ytdlpExecutable: join(REPO_ROOT, 'vendor', 'yt-dlp', 'yt-dlp.exe'),
        ffmpegExecutable,
        denoExecutable: join(REPO_ROOT, 'vendor', 'deno', 'deno.exe')
      }),
      projectDirectory: REPO_ROOT,
      pythonProjectDirectory: pythonRoot,
      taskIndexFile: join(root, 'runtime', 'tasks.json')
    })

    const queued = manager.startRequirementTwo(
      AUDIO,
      sourceText,
      join(root, 'outputs'),
      { asr: largeDir, asrLight: turboDir, asrPlan: plan, translation: config.translationModelDirectory },
      'ja',
      'off'
    )
    const { task, elapsedMs } = await waitTask(manager, queued.taskId, 25 * 60_000)

    expect(task?.status, task?.error?.message ?? task?.message).toBe('complete')
    expect(task?.asrExecution).toMatchObject({
      selectedModel: 'faster-whisper-large-v3-turbo',
      effectiveModel: 'faster-whisper-large-v3',
      fallbackUsed: true,
      fallbackReason: 'alignment-quality'
    })
    expect(task?.asrExecution?.notice).toContain('Large v3')
    expect(task?.artifacts.srt && existsSync(task.artifacts.srt)).toBe(true)
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      case: 'forced-turbo-fail-then-large',
      taskId: task?.taskId,
      asrExecution: task?.asrExecution,
      srtBytes: task?.artifacts.srt ? readFileSync(task.artifacts.srt).length : 0,
      elapsedMs
    }, null, 2))
  }, 26 * 60_000)
})
