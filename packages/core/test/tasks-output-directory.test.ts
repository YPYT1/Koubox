import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { KouboxConfig } from '@koubox/shared'
import { TaskManager } from '../src/tasks.js'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createManager(root: string): TaskManager {
  return new TaskManager({
    getConfig: () => ({ maxConcurrentTasks: 1 } as KouboxConfig),
    resolveVendor: () => ({ ytdlpExecutable: join(root, 'missing-yt-dlp.exe'), ffmpegExecutable: join(root, 'missing-ffmpeg.exe') }),
    projectDirectory: root,
    pythonProjectDirectory: root,
    taskIndexFile: join(root, 'runtime', 'tasks.json')
  })
}

describe('task output directories', () => {
  it('creates a task-id directory below the selected output root for both task kinds', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-task-output-'))
    temporaryRoots.push(root)
    const outputRoot = join(root, 'Koubox Outputs')
    const manager = createManager(root)

    const videoTask = manager.startRequirementOne('https://www.youtube.com/watch?v=example', outputRoot, { asr: '', translation: '' })
    const audioTask = manager.startRequirementTwo(join(root, 'missing.wav'), '', outputRoot, { asr: '', translation: '' })

    for (const task of [videoTask, audioTask]) {
      expect(task.outputDirectory).toBe(join(outputRoot, task.taskId))
      expect(task.taskDirectory).toBe(task.outputDirectory)
      expect(existsSync(task.outputDirectory)).toBe(true)
    }
    expect(videoTask.outputDirectory).not.toBe(audioTask.outputDirectory)
  })
})
