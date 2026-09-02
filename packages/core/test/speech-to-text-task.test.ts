import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { assertLocalSpeechMediaPath } from '@koubox/shared'
import type { KouboxConfig } from '@koubox/shared'
import { TaskManager } from '../src/tasks.js'
import { testModelPaths } from './test-model-paths.js'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createManager(root: string): TaskManager {
  return new TaskManager({
    getConfig: () => ({ maxConcurrentTasks: 1 } as KouboxConfig),
    resolveVendor: () => ({
      ytdlpExecutable: join(root, 'missing-yt-dlp.exe'),
      ffmpegExecutable: join(root, 'missing-ffmpeg.exe'),
      denoExecutable: join(root, 'missing-deno.exe')
    }),
    projectDirectory: root,
    pythonProjectDirectory: root,
    taskIndexFile: join(root, 'runtime', 'tasks.json')
  })
}

describe('assertLocalSpeechMediaPath', () => {
  it('accepts common audio and video extensions', () => {
    expect(assertLocalSpeechMediaPath('D:/media/voice.wav')).toBe('D:/media/voice.wav')
    expect(assertLocalSpeechMediaPath('D:/media/clip.mp4')).toBe('D:/media/clip.mp4')
  })

  it('rejects unsupported extensions', () => {
    expect(() => assertLocalSpeechMediaPath('D:/media/readme.txt')).toThrow(/仅支持/)
  })
})

describe('speech-to-text task', () => {
  it('creates a task directory below the selected output root', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-speech-to-text-'))
    temporaryRoots.push(root)
    const outputRoot = join(root, 'Koubox Outputs')
    const manager = createManager(root)

    const task = manager.startSpeechToText(join(root, 'sample.wav'), outputRoot, testModelPaths())

    expect(task.kind).toBe('speech-to-text')
    expect(task.outputDirectory).toBe(join(outputRoot, task.taskId))
    expect(task.taskDirectory).toBe(task.outputDirectory)
    expect(existsSync(task.outputDirectory)).toBe(true)
    expect(task.taskId.startsWith('Audio_')).toBe(true)
  })
})
