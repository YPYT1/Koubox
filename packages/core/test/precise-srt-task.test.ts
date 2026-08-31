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

describe('precise SRT task contract', () => {
  it('persists language and speech-rate strategy for an audio-only task', () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-precise-srt-'))
    temporaryRoots.push(root)
    const options = {
      getConfig: () => ({ maxConcurrentTasks: 1 } as KouboxConfig),
      resolveVendor: () => ({
        ytdlpExecutable: join(root, 'yt-dlp.exe'),
        ffmpegExecutable: join(root, 'ffmpeg.exe'),
        denoExecutable: join(root, 'deno.exe')
      }),
      projectDirectory: root,
      pythonProjectDirectory: root,
      taskIndexFile: join(root, 'runtime', 'tasks.json')
    }
    const manager = new TaskManager(options)

    const task = manager.startRequirementTwo(
      join(root, 'voice.wav'),
      '',
      join(root, 'outputs'),
      { asr: '', translation: '' },
      'ja',
      'force'
    )

    expect(task.mode).toBe('asr-only')
    expect(task.requestedLanguage).toBe('ja')
    expect(task.speechRateMode).toBe('force')
    expect(existsSync(task.taskDirectory)).toBe(true)

    const restoredManager = new TaskManager(options)
    restoredManager.restore(join(root, 'outputs'))
    const restored = restoredManager.list().find((item) => item.taskId === task.taskId)
    expect(restored?.requestedLanguage).toBe('ja')
    expect(restored?.speechRateMode).toBe('force')

    const aligned = manager.startRequirementTwo(
      join(root, 'voice-with-script.wav'),
      '用户文案',
      join(root, 'outputs'),
      { asr: '', translation: '' },
      'zh-Hant',
      'force'
    )
    expect(aligned.mode).toBe('align')
    expect(aligned.requestedLanguage).toBe('zh-Hant')
    expect(aligned.speechRateMode).toBe('off')
  })
})
