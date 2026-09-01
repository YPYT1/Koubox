import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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
    translationModelDirectory: join(modelsDirectory, 'HYMT21.8B'),
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
    debugMode: false
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
      },
      fallback: {
        id: 'faster-whisper-large-v3',
        directory: expect.stringContaining('custom-large-location'),
        computeType: 'float16'
      }
    })

    const largeConfig = sampleConfig('D:/models')
    largeConfig.defaultAsrModel = 'faster-whisper-large-v3'
    const large = resolveAsrExecutionPlan(largeConfig)
    expect(large.primary.computeType).toBe('float16')
    expect(large.fallback).toMatchObject({
      id: 'faster-whisper-large-v3-turbo',
      computeType: 'int8'
    })
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
    expect(plan.fallback?.directory).toContain('custom-light-location')
  })

  it('falls back from large-v3 to turbo after a resource failure', async () => {
    const config = sampleConfig('D:/models')
    config.defaultAsrModel = 'faster-whisper-large-v3'
    const plan = resolveAsrExecutionPlan(config)
    const onFallback = vi.fn()

    const result = await runAsrExecutionPlan(plan, {
      runAttempt: async (model) => {
        if (model.id === 'faster-whisper-large-v3') throw resourceError()
        return 'turbo-result'
      },
      isResourceError,
      onFallback
    })

    expect(result).toMatchObject({
      value: 'turbo-result',
      effectiveModel: 'faster-whisper-large-v3-turbo',
      fallbackUsed: true
    })
    expect(onFallback).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'faster-whisper-large-v3' }),
      expect.objectContaining({ id: 'faster-whisper-large-v3-turbo' }),
      'resource-exhausted'
    )
  })

  it('falls back from turbo to large-v3 after an alignment quality failure', async () => {
    const plan = resolveAsrExecutionPlan(sampleConfig('D:/models'))
    const onFallback = vi.fn()
    const qualityError = () => new Error('模式 A 对齐结果未完整保留用户文案。')

    const result = await runAsrExecutionPlan(plan, {
      runAttempt: async (model) => {
        if (model.id === 'faster-whisper-large-v3-turbo') throw qualityError()
        return 'large-result'
      },
      isResourceError,
      isAlignmentQualityError: (error) => error instanceof Error && /未完整保留用户文案/.test(error.message),
      onFallback
    })

    expect(result).toMatchObject({
      value: 'large-result',
      effectiveModel: 'faster-whisper-large-v3',
      fallbackUsed: true
    })
    expect(onFallback).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'faster-whisper-large-v3-turbo' }),
      expect.objectContaining({ id: 'faster-whisper-large-v3' }),
      'alignment-quality'
    )
  })

  it('does not fall back from turbo to large-v3 on resource exhaustion', async () => {
    await expect(runAsrExecutionPlan(resolveAsrExecutionPlan(sampleConfig('D:/models')), {
      runAttempt: async () => { throw resourceError() },
      isResourceError,
      isAlignmentQualityError: () => false
    })).rejects.toMatchObject({
      name: AsrResourceExhaustedError.name,
      modelId: 'faster-whisper-large-v3-turbo'
    })
  })

  it('reports turbo as the exhausted model when both attempts run out of memory', async () => {
    const config = sampleConfig('D:/models')
    config.defaultAsrModel = 'faster-whisper-large-v3'

    await expect(runAsrExecutionPlan(resolveAsrExecutionPlan(config), {
      runAttempt: async () => { throw resourceError() },
      isResourceError
    })).rejects.toMatchObject({
      name: AsrResourceExhaustedError.name,
      modelId: 'faster-whisper-large-v3-turbo'
    })
  })

  it('reports turbo as the exhausted model when turbo is selected directly', async () => {
    await expect(runAsrExecutionPlan(resolveAsrExecutionPlan(sampleConfig('D:/models')), {
      runAttempt: async () => { throw resourceError() },
      isResourceError
    })).rejects.toMatchObject({
      modelId: 'faster-whisper-large-v3-turbo'
    })
  })
})
