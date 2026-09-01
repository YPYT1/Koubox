import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { toUserTaskMessage } from '@koubox/shared'
import type { KouboxConfig } from '@koubox/shared'
import { parseWorkerFailure, TaskManager } from '../src/tasks.js'
import { testModelPaths } from './test-model-paths.js'

const temporaryRoots: string[] = []
const repoRoot = join(process.cwd(), '..', '..')
const ffmpegExecutable = join(repoRoot, 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe')
const pythonExecutable = join(repoRoot, 'python', '.venv', 'Scripts', 'python.exe')

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

describe('ASR worker failure parsing', () => {
  it('prefers OOM lines over transformers deprecation noise in stderr', () => {
    const stderr = [
      "[transformers] 'torch_dtype' is deprecated! Use 'dtype' instead!",
      'CUDA out of memory. Tried to allocate 2.00 GiB'
    ].join('\n')

    expect(parseWorkerFailure(stderr)).toMatchObject({
      message: 'CUDA out of memory. Tried to allocate 2.00 GiB'
    })
  })

  it('maps protocol ASR_OOM errors from stdout', () => {
    const line = JSON.stringify({ type: 'error', code: 'ASR_OOM', message: '显存或内存不足。当前已使用最轻量的语音识别模型 faster-whisper-large-v3-turbo，请关闭其他占用 GPU 的程序后重试，或缩短音频长度。' })
    expect(parseWorkerFailure('', line)).toMatchObject({
      code: 'ASR_OOM',
      message: expect.stringContaining('最轻量')
    })
  })

  it('does not expose or misclassify deprecation-only stderr', () => {
    const warning = "[transformers] 'torch_dtype' is deprecated! Use 'dtype' instead!"
    const progress = JSON.stringify({ type: 'progress', message: '正在加载模型' })

    expect(parseWorkerFailure(warning, progress)).toMatchObject({
      message: '本地模型运行失败，请查看日志。'
    })
    expect(toUserTaskMessage(warning)).toBe('本地模型运行失败，请查看日志。')
  })

  it('finds resource failures in stdout when stderr only contains warnings', () => {
    const warning = "[transformers] 'torch_dtype' is deprecated! Use 'dtype' instead!"
    const resourceFailure = 'CUDA failed with error out of memory'

    expect(parseWorkerFailure(warning, resourceFailure)).toMatchObject({
      message: resourceFailure
    })
    expect(toUserTaskMessage(resourceFailure)).toContain('显存或系统内存不足')
  })

  it('persists a successful large-v3 to turbo fallback across task restore', async () => {
    expect(existsSync(ffmpegExecutable)).toBe(true)
    expect(existsSync(pythonExecutable)).toBe(true)
    const root = mkdtempSync(join(tmpdir(), 'koubox-asr-fallback-task-'))
    temporaryRoots.push(root)
    const inputPath = join(root, 'speech.wav')
    const generated = spawnSync(ffmpegExecutable, [
      '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-ar', '16000', '-ac', '1', inputPath
    ], { encoding: 'utf8' })
    expect(generated.status, generated.stderr || generated.stdout).toBe(0)

    const pythonRoot = join(root, 'python')
    const workerRoot = join(pythonRoot, 'src', 'koubox_runtime')
    mkdirSync(workerRoot, { recursive: true })
    writeFileSync(join(workerRoot, '__init__.py'), '', 'utf8')
    writeFileSync(join(workerRoot, '__main__.py'), [
      'import json, sys',
      'request = json.loads(sys.stdin.readline())',
      'if request["modelDirectory"].endswith("large"):',
      '    print(json.dumps({"type":"error","code":"RUNTIME_ERROR","message":"CUDA failed with error out of memory"}), flush=True)',
      '    raise SystemExit(1)',
      'print(json.dumps({"type":"transcript","language":"en","segments":[{"text":"fallback worked","start":0.0,"end":0.2}]}), flush=True)'
    ].join('\n'), 'utf8')

    const config = {
      maxConcurrentTasks: 1,
      pythonExecutable,
      ytdlpProxy: '',
      asrLanguage: 'auto',
      whisperChunkLengthS: 30
    } as KouboxConfig
    const options = {
      getConfig: () => config,
      resolveVendor: () => ({ ytdlpExecutable: '', ffmpegExecutable, denoExecutable: '' }),
      projectDirectory: root,
      pythonProjectDirectory: pythonRoot,
      taskIndexFile: join(root, 'runtime', 'tasks.json')
    }
    const paths = testModelPaths({
      asrPlan: {
        selectedModel: 'faster-whisper-large-v3',
        primary: { id: 'faster-whisper-large-v3', directory: join(root, 'large'), computeType: 'float16' },
        fallback: { id: 'faster-whisper-large-v3-turbo', directory: join(root, 'turbo'), computeType: 'int8' }
      }
    })
    const manager = new TaskManager(options)
    const queued = manager.startSpeechToText(inputPath, join(root, 'outputs'), paths)

    let completed = manager.get(queued.taskId)
    for (let attempt = 0; attempt < 200 && completed?.status !== 'complete' && completed?.status !== 'error'; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
      completed = manager.get(queued.taskId)
    }
    expect(completed).toMatchObject({
      status: 'complete',
      asrExecution: {
        selectedModel: 'faster-whisper-large-v3',
        effectiveModel: 'faster-whisper-large-v3-turbo',
        fallbackUsed: true,
        fallbackReason: 'resource-exhausted'
      }
    })
    expect(completed?.asrExecution?.notice).toContain('已自动切换到轻量模型')
    expect(readFileSync(completed!.artifacts.transcriptText!, 'utf8')).toContain('fallback worked')

    const restored = new TaskManager(options)
    restored.restore(join(root, 'outputs'))
    expect(restored.get(queued.taskId)?.asrExecution).toEqual(completed?.asrExecution)
  })
})
