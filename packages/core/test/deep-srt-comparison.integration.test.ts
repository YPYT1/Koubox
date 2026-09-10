/**
 * 深度测试：对比有文案和无文案模式的 SRT 输出
 * 运行：$env:KOUBOX_REAL_ASR='1'; pnpm --filter @koubox/core exec vitest run test/deep-srt-comparison.integration.test.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { defaultPlatformAuth, type KouboxConfig } from '@koubox/shared'
import { resolveAsrExecutionPlan } from '../src/asr-execution.js'
import { TaskManager } from '../src/tasks.js'

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const ENABLED = process.env.KOUBOX_REAL_ASR === '1'
const OUTPUT_DIR = join(REPO_ROOT, 'test-outputs')

const testCases = [
  {
    name: '文案_02_先端パッケージ_语速1.1',
    audio: 'C:\\Users\\Administrator\\Desktop\\文案\\日语\\文案_02_先端パッケージ（语速1.1-声调2-音量1.3）.wav',
    text: 'C:\\Users\\Administrator\\Desktop\\文案\\日语\\文案_02_先端パッケージ.txt'
  },
  {
    name: '文案_05_高信頼性材料_语速1.4',
    audio: 'C:\\Users\\Administrator\\Desktop\\文案\\日语\\文案_05_高信頼性材料（语速1.4-声调2-音量1.6）.wav',
    text: 'C:\\Users\\Administrator\\Desktop\\文案\\日语\\文案_05_高信頼性材料.txt'
  },
  {
    name: '文案_08_車載センシング_语速1.7',
    audio: 'C:\\Users\\Administrator\\Desktop\\文案\\日语\\文案_08_車載センシング(语速1.7-音调-2-音量1.9).wav',
    text: 'C:\\Users\\Administrator\\Desktop\\文案\\日语\\文案_08_車載センシング.txt'
  }
]

async function waitTask(manager: TaskManager, taskId: string, timeout: number) {
  const start = Date.now()
  while (true) {
    const task = manager.get(taskId)
    if (!task) throw new Error('Task not found')
    if (task.status === 'complete' || task.status === 'error') {
      return { task, elapsedMs: Date.now() - start }
    }
    if (Date.now() - start > timeout) throw new Error('Timeout')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

describe.skipIf(!ENABLED)('Deep SRT Comparison: 有文案 vs 无文案', () => {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true })
  
  let root: string
  let config: KouboxConfig
  let plan: Awaited<ReturnType<typeof resolveAsrExecutionPlan>>

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'koubox-test-'))
    mkdirSync(join(root, 'outputs'), { recursive: true })

    const ffmpegDirectory = join(REPO_ROOT, 'vendor', 'ffmpeg', 'bin')
    config = {
      modelsDirectory: join(REPO_ROOT, 'models'),
      outputDirectory: join(root, 'outputs'),
      asrModelDirectory: join(REPO_ROOT, 'models', 'faster-whisper-large-v3'),
      asrLightModelDirectory: join(REPO_ROOT, 'models', 'faster-whisper-large-v3-turbo-int8-ct2'),
      defaultAsrModel: 'faster-whisper-large-v3-turbo',
      translationModelDirectory: join(REPO_ROOT, 'models', 'nllb-200-distilled-600M-multilang-ft-ct2'),
      demucsModelDirectory: join(REPO_ROOT, 'models', 'demucs'),
      ytdlpDirectory: join(REPO_ROOT, 'vendor', 'yt-dlp'),
      ffmpegDirectory,
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
      pythonExecutable: join(REPO_ROOT, 'python', '.venv', 'Scripts', 'python.exe'),
      debugMode: false
    }
    plan = resolveAsrExecutionPlan(config)
  })

  for (const testCase of testCases) {
    describe(testCase.name, () => {
      it('有文案模式', async () => {
        if (!existsSync(testCase.audio)) {
          console.log(`⚠ 跳过：音频文件不存在 ${testCase.audio}`)
          return
        }

        const sourceText = existsSync(testCase.text)
          ? readFileSync(testCase.text, 'utf-8').trim()
          : ''

        if (!sourceText) {
          console.log(`⚠ 跳过：文案文件不存在 ${testCase.text}`)
          return
        }

        const manager = new TaskManager({
          getConfig: () => config,
          resolveVendor: () => ({
            ytdlpExecutable: join(REPO_ROOT, 'vendor', 'yt-dlp', 'yt-dlp.exe'),
            ffmpegExecutable: join(REPO_ROOT, 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe'),
            denoExecutable: join(REPO_ROOT, 'vendor', 'deno', 'deno.exe')
          }),
          projectDirectory: REPO_ROOT,
          pythonProjectDirectory: join(REPO_ROOT, 'python'),
          taskIndexFile: join(root, 'runtime', 'tasks.json')
        })
        const queued = manager.startRequirementTwo(
          testCase.audio,
          sourceText,
          join(root, 'outputs'),
          { asrPlan: plan, translation: config.translationModelDirectory },
          'ja',
          'off'
        )

        const { task, elapsedMs } = await waitTask(manager, queued.taskId, 10 * 60 * 1000)

        expect(task.status, task.error?.message ?? task.message).toBe('complete')
        expect(task.artifacts?.srt && existsSync(task.artifacts.srt)).toBe(true)

        if (task.artifacts?.srt) {
          const srt = readFileSync(task.artifacts.srt, 'utf-8')
          const outputPath = join(OUTPUT_DIR, `${testCase.name}_有文案.srt`)
          writeFileSync(outputPath, srt, 'utf-8')

          const segments = srt.split(/\n\n/).filter(Boolean).length
          // eslint-disable-next-line no-console
          console.log(JSON.stringify({
            mode: '有文案',
            case: testCase.name,
            output: outputPath,
            segments,
            elapsedMs,
            model: task.asrExecution?.effectiveModel,
            fallbackUsed: task.asrExecution?.fallbackUsed,
            fallbackReason: task.asrExecution?.fallbackReason
          }, null, 2))
        }
      }, 10 * 60 * 1000)

      it('无文案模式', async () => {
        if (!existsSync(testCase.audio)) {
          console.log(`⚠ 跳过：音频文件不存在 ${testCase.audio}`)
          return
        }

        const manager = new TaskManager({
          getConfig: () => config,
          resolveVendor: () => ({
            ytdlpExecutable: join(REPO_ROOT, 'vendor', 'yt-dlp', 'yt-dlp.exe'),
            ffmpegExecutable: join(REPO_ROOT, 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe'),
            denoExecutable: join(REPO_ROOT, 'vendor', 'deno', 'deno.exe')
          }),
          projectDirectory: REPO_ROOT,
          pythonProjectDirectory: join(REPO_ROOT, 'python'),
          taskIndexFile: join(root, 'runtime', 'tasks.json')
        })
        const queued = manager.startRequirementTwo(
          testCase.audio,
          '',
          join(root, 'outputs'),
          { asrPlan: plan, translation: config.translationModelDirectory },
          'ja',
          'off'
        )

        const { task, elapsedMs } = await waitTask(manager, queued.taskId, 10 * 60 * 1000)

        expect(task.status, task.error?.message ?? task.message).toBe('complete')
        expect(task.artifacts?.srt && existsSync(task.artifacts.srt)).toBe(true)

        if (task.artifacts?.srt) {
          const srt = readFileSync(task.artifacts.srt, 'utf-8')
          const outputPath = join(OUTPUT_DIR, `${testCase.name}_无文案.srt`)
          writeFileSync(outputPath, srt, 'utf-8')

          const segments = srt.split(/\n\n/).filter(Boolean).length
          // eslint-disable-next-line no-console
          console.log(JSON.stringify({
            mode: '无文案',
            case: testCase.name,
            output: outputPath,
            segments,
            elapsedMs,
            model: task.asrExecution?.effectiveModel,
            fallbackUsed: task.asrExecution?.fallbackUsed,
            fallbackReason: task.asrExecution?.fallbackReason
          }, null, 2))
        }
      }, 10 * 60 * 1000)
    })
  }
})
