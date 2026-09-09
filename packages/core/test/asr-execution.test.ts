import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultPlatformAuth, type KouboxConfig } from '@koubox/shared'
import {
  AsrResourceExhaustedError,
  resolveAsrExecutionPlan,
  runAsrExecutionPlan
} from '../src/asr-execution.js'

function sampleConfig(modelsDirectory: string): KouboxConfig {
  return {
    modelsDirectory,
    outputDirectory: join(modelsDirectory, 'outputs'),
    asrModelDirectory: join(modelsDirectory, 'custom-large-location'),
    asrLightModelDirectory: join(modelsDirectory, 'custom-light-location'),
    defaultAsrModel: 'faster-whisper-large-v3-turbo',
    translationModelDirectory: join(modelsDirectory, 'nllb-200-distilled-600M-multilang-ft-ct2'),
    demucsModelDirectory: join(modelsDirectory, 'demucs'),
    ytdlpDirectory: join(modelsDirectory, 'yt-dlp'),
    ffmpegDirectory: join(modelsDirectory, 'ffmpeg'),
    denoDirectory: join(modelsDirectory, 'deno'),
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
    pythonExecutable: '',
    debugMode: false, lanEnabled: false, lanAlias: 'test', lanPort: 0, lanAutoSave: false, lanSaveDirectory: 'D:/share', lanHistoryEnabled: true
  }
}

const resourceError = () => new Error('CUDA failed with error out of memory')
const isResourceError = (error: unknown) => error instanceof Error && /out of memory/i.test(error.message)

describe('ASR execution plan', () => {
  it('uses model identity instead of custom directory names for compute type', () => {
    const turbo = resolveAsrExecutionPlan(sampleConfig('D:/models'))
    expect(turbo).toMatchObject({
      selectedModel: 'faster-whisper-large-v3-turbo',
      primary: {
        id: 'faster-whisper-large-v3-turbo',
        directory: expect.stringContaining('custom-light-location'),
        computeType: 'int8'
      }
    })

    const largeConfig = sampleConfig('D:/models')
    largeConfig.defaultAsrModel = 'faster-whisper-large-v3'
    const large = resolveAsrExecutionPlan(largeConfig)
    expect(large.primary.computeType).toBe('float16')
  })

  it('captures an immutable model choice when the task is queued', () => {
    const config = sampleConfig('D:/models')
    config.defaultAsrModel = 'faster-whisper-large-v3'
    const plan = resolveAsrExecutionPlan(config)

    config.defaultAsrModel = 'faster-whisper-large-v3-turbo'
    config.asrModelDirectory = 'D:/models/replaced-large'
    config.asrLightModelDirectory = 'D:/models/replaced-turbo'

    expect(plan.selectedModel).toBe('faster-whisper-large-v3')
    expect(plan.primary.directory).toContain('custom-large-location')
  })

  it('does not fall back from a selected model after a resource failure', async () => {
    const config = sampleConfig('D:/models')
    config.defaultAsrModel = 'faster-whisper-large-v3'
    const plan = resolveAsrExecutionPlan(config)
    await expect(runAsrExecutionPlan(plan, {
      runAttempt: async () => { throw resourceError() },
      isResourceError,
    })).rejects.toMatchObject({
      modelId: 'faster-whisper-large-v3'
    })
  })
})
