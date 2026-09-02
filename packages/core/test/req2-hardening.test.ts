import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultPlatformAuth, type KouboxConfig } from '@koubox/shared'
import { startLocalApi } from '../src/server.js'
import { createWorkerTaskError, parseWorkerFailure, TaskManager } from '../src/tasks.js'

const temporaryRoots: string[] = []

function defaults(root: string): KouboxConfig {
  return {
    modelsDirectory: join(root, 'models'), outputDirectory: join(root, 'outputs'),
    asrModelDirectory: join(root, 'models', 'asr'),
    asrLightModelDirectory: join(root, 'models', 'asr-turbo'),
    defaultAsrModel: 'faster-whisper-large-v3-turbo',
    translationModelDirectory: join(root, 'models', 'translation'),
    demucsModelDirectory: join(root, 'models', 'demucs'), ytdlpDirectory: join(root, 'vendor', 'yt-dlp'),
    ffmpegDirectory: join(root, 'vendor', 'ffmpeg'), denoDirectory: join(root, 'vendor', 'deno'),
    translationTargetLanguage: 'zh-Hans', asrLanguage: 'auto', openOutputOnComplete: false,
    ytdlpProxy: '', ytdlpPlatformAuth: defaultPlatformAuth(), ytdlpMaxHeight: 0, ytdlpExtraArgs: '',
    maxConcurrentTasks: 1, translationTemperature: 0.7, translationMaxNewTokens: 4096,
    translationTopP: 0.8, whisperChunkLengthS: 30, pythonExecutable: '', debugMode: false
  }
}

function pythonExecutable(): string {
  const candidates = [
    join(process.cwd(), '..', '..', 'python', '.venv', 'Scripts', 'python.exe'),
    'C:/Users/Administrator/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe'
  ]
  const executable = candidates.find((candidate) => existsSync(candidate))
  if (!executable) throw new Error('Python fixture executable not found')
  return executable
}

function workerManager(root: string, workerTimeoutMs?: number): TaskManager {
  return new TaskManager({
    getConfig: () => ({ pythonExecutable: pythonExecutable(), ytdlpProxy: '', maxConcurrentTasks: 1 } as KouboxConfig),
    resolveVendor: () => ({ ytdlpExecutable: '', ffmpegExecutable: '', denoExecutable: '' }),
    projectDirectory: root,
    pythonProjectDirectory: join(root, 'python'),
    taskIndexFile: join(root, 'tasks.json'),
    workerTimeoutMs
  })
}

function workerRecord(root: string) {
  return {
    task: { taskId: 'fixture', taskDirectory: root, outputDirectory: root } as never,
    listeners: new Set(),
    processes: new Set(),
    cancelled: false,
    slotReleased: false,
    abortController: new AbortController()
  }
}

function writeWorker(root: string, source: string): void {
  mkdirSync(join(root, 'python', 'src', 'koubox_runtime'), { recursive: true })
  writeFileSync(join(root, 'python', 'src', 'koubox_runtime', '__main__.py'), source, 'utf8')
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows may release a killed child slightly later. */ }
  }
})

describe('req2 hardening', () => {
  it('rejects missing and unsupported media before queueing a task', async () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-req2-api-hardening-'))
    temporaryRoots.push(root)
    const unsupported = join(root, 'notes.txt')
    writeFileSync(unsupported, 'not media', 'utf8')
    const api = await startLocalApi({
      configFile: join(root, 'runtime.json'), defaults: defaults(root), projectDirectory: root, pythonProjectDirectory: root,
      selectDirectory: async () => undefined, selectAudioFile: async () => undefined, selectFile: async () => undefined,
      openPath: async () => undefined, openLoginWindow: async () => undefined,
      getLoginCookieStatus: async () => ({ status: 'unknown' } as never),
      resolveActiveYtdlp: () => ({ executable: join(root, 'yt-dlp.exe') } as never),
      checkYtdlpUpdate: async () => ({ status: 'unknown' } as never), installYtdlpUpdate: async () => ({ status: 'unknown' } as never),
      restoreBundledYtdlp: async () => ({ status: 'unknown' } as never)
    })
    try {
      for (const audioPath of [join(root, 'missing.wav'), unsupported]) {
        const response = await fetch(`${api.baseUrl}/pipelines/req2`, {
          method: 'POST', headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ audioPath })
        })
        expect(response.status).toBe(400)
      }
    } finally {
      await api.close()
    }
  })

  it('preserves protocol worker error codes as taskError', () => {
    expect(createWorkerTaskError('fixture failure', 'PRECISE_SRT_FAILED'))
      .toMatchObject({ code: 'PRECISE_SRT_FAILED', taskError: { code: 'PRECISE_SRT_FAILED', message: 'fixture failure' } })
  })

  it('terminates a hung worker at the configured deadline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-worker-timeout-'))
    temporaryRoots.push(root)
    writeWorker(root, ['import sys, time', 'sys.stdin.readline()', 'time.sleep(5)'].join('\n'))
    const manager = workerManager(root, 50)
    await expect((manager as never as { runWorker: Function }).runWorker(workerRecord(root), 'precise_srt', {}, () => {}))
      .rejects.toMatchObject({ code: 'WORKER_TIMEOUT', taskError: { code: 'WORKER_TIMEOUT' } })
  })

  it('parseWorkerFailure preserves protocol error codes from stdout and stderr', () => {
    const protocolLine = JSON.stringify({ type: 'error', code: 'PRECISE_SRT_FAILED', message: 'fixture failure' })
    expect(parseWorkerFailure('', protocolLine)).toMatchObject({
      code: 'PRECISE_SRT_FAILED',
      message: 'fixture failure'
    })
    expect(parseWorkerFailure(protocolLine, '')).toMatchObject({
      code: 'PRECISE_SRT_FAILED',
      message: 'fixture failure'
    })
    expect(parseWorkerFailure(`noise\n${protocolLine}`, '')).toMatchObject({
      code: 'PRECISE_SRT_FAILED',
      message: 'fixture failure'
    })
  })
})
