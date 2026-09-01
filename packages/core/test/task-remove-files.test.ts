import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    resolveVendor: () => ({
      ytdlpExecutable: join(root, 'yt-dlp.exe'),
      ffmpegExecutable: join(root, 'ffmpeg.exe'),
      denoExecutable: join(root, 'deno.exe')
    }),
    projectDirectory: root,
    pythonProjectDirectory: root,
    taskIndexFile: join(root, 'runtime', 'tasks.json')
  })
}

describe('task remove files', () => {
  it('keeps task directory when deleteFiles is false', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-task-remove-'))
    temporaryRoots.push(root)
    const manager = createManager(root)
    const taskDir = join(root, 'outputs', 'Audio_20260831_001')
    mkdirSync(taskDir, { recursive: true })
    writeFileSync(join(taskDir, 'Audio_20260831_001.srt'), 'srt', 'utf8')
    manager['records'].set('Audio_20260831_001', {
      task: {
        taskId: 'Audio_20260831_001',
        kind: 'req2',
        status: 'complete',
        stage: 'complete',
        percent: 100,
        message: 'done',
        url: join(root, 'voice.wav'),
        outputDirectory: taskDir,
        taskDirectory: taskDir,
        artifacts: { srt: join(taskDir, 'Audio_20260831_001.srt') },
        createdAt: '2026-08-31T00:00:00.000Z',
        updatedAt: '2026-08-31T00:00:00.000Z'
      },
      listeners: new Set(),
      processes: new Set(),
      cancelled: false,
      slotReleased: true,
      abortController: new AbortController()
    })

    manager.remove('Audio_20260831_001')

    expect(existsSync(taskDir)).toBe(true)
    expect(manager.list()).toHaveLength(0)
  })

  it('deletes task directory when deleteFiles is true', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-task-remove-'))
    temporaryRoots.push(root)
    const manager = createManager(root)
    const taskDir = join(root, 'outputs', 'Audio_20260831_002')
    mkdirSync(taskDir, { recursive: true })
    writeFileSync(join(taskDir, 'Audio_20260831_002.srt'), 'srt', 'utf8')
    manager['records'].set('Audio_20260831_002', {
      task: {
        taskId: 'Audio_20260831_002',
        kind: 'req2',
        status: 'complete',
        stage: 'complete',
        percent: 100,
        message: 'done',
        url: join(root, 'voice.wav'),
        outputDirectory: taskDir,
        taskDirectory: taskDir,
        artifacts: { srt: join(taskDir, 'Audio_20260831_002.srt') },
        createdAt: '2026-08-31T00:00:00.000Z',
        updatedAt: '2026-08-31T00:00:00.000Z'
      },
      listeners: new Set(),
      processes: new Set(),
      cancelled: false,
      slotReleased: true,
      abortController: new AbortController()
    })

    manager.remove('Audio_20260831_002', { deleteFiles: true })

    expect(existsSync(taskDir)).toBe(false)
    expect(manager.list()).toHaveLength(0)
  })
})
