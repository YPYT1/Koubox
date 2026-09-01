import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { KouboxConfig } from '@koubox/shared'
import { TaskManager } from '../src/tasks.js'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createManager(root: string, downloadTikTokPublic: () => Promise<string>): TaskManager {
  return new TaskManager({
    getConfig: () => ({
      maxConcurrentTasks: 1,
      ytdlpProxy: '',
      ytdlpMaxHeight: 1080,
      ytdlpExtraArgs: '',
      modelsDirectory: root,
      demucsModelDirectory: '',
      pythonExecutable: '',
      outputDirectory: root,
      translationTargetLanguage: 'zh-Hans',
      ytdlpPlatformAuth: {}
    } as KouboxConfig),
    resolveVendor: () => ({
      ytdlpExecutable: join(root, 'missing-yt-dlp.exe'),
      ffmpegExecutable: join(root, 'missing-ffmpeg.exe'),
      denoExecutable: join(root, 'missing-deno.exe')
    }),
    projectDirectory: root,
    pythonProjectDirectory: root,
    taskIndexFile: join(root, 'runtime', 'tasks.json'),
    downloadTikTokPublic
  })
}

describe('task cancel queue', () => {
  it('releases the running slot immediately so the next queued task can start', async () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-task-cancel-'))
    temporaryRoots.push(root)
    const outputRoot = join(root, 'outputs')
    let releaseFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const manager = createManager(root, async () => {
      await firstBlocked
      throw new Error('first task should have been cancelled')
    })

    const first = manager.startRequirementOne(
      'https://www.tiktok.com/@example/video/7673765267775687956',
      outputRoot,
      { asr: '', translation: '' }
    )
    const second = manager.startRequirementOne(
      'https://www.tiktok.com/@example/video/7652209936830582030',
      outputRoot,
      { asr: '', translation: '' }
    )

    await expect.poll(() => manager.get(first.taskId)?.status, { timeout: 3_000 }).toBe('running')
    expect(manager.get(second.taskId)?.status).toBe('queued')

    manager.cancel(first.taskId)
    expect(manager.get(first.taskId)?.status).toBe('cancelled')

    await expect.poll(() => manager.get(second.taskId)?.status, { timeout: 1_000 }).toBe('running')
    releaseFirst?.()
  })
})
