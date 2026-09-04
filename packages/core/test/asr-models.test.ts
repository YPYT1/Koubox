import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ASR_MODEL,
  asrAlignmentFallbackNoticeMessage,
  asrResourceErrorUserMessage,
  defaultPlatformAuth,
  isAsrAlignmentQualityError,
  isAsrResourceError,
  type KouboxConfig
} from '@koubox/shared'
import { resolveAsrExecutionPlan, resolveAsrModelPaths } from '../src/asr-execution.js'

function sampleConfig(modelsDirectory: string): KouboxConfig {
  return {
    modelsDirectory,
    outputDirectory: join(modelsDirectory, 'outputs'),
    asrModelDirectory: join(modelsDirectory, 'faster-whisper-large-v3'),
    asrLightModelDirectory: join(modelsDirectory, 'faster-whisper-large-v3-turbo-int8-ct2'),
    defaultAsrModel: DEFAULT_ASR_MODEL,
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
    debugMode: false
  }
}

describe('ASR model helpers', () => {
  it('uses turbo as primary path when default model is turbo', () => {
    const paths = resolveAsrModelPaths(sampleConfig('D:/models'))
    expect(paths.asrPrimary).toContain('faster-whisper-large-v3-turbo-int8-ct2')
    expect(paths.asrFallback).toContain('faster-whisper-large-v3')
  })

  it('uses large-v3 as primary path when default model is large-v3', () => {
    const config = sampleConfig('D:/models')
    config.defaultAsrModel = 'faster-whisper-large-v3'
    const paths = resolveAsrModelPaths(config)
    expect(paths.asrPrimary).toContain('faster-whisper-large-v3')
    expect(paths.asrFallback).toContain('faster-whisper-large-v3-turbo-int8-ct2')
  })

  it('keeps turbo on INT8 when the user selects an arbitrary custom directory', () => {
    const config = sampleConfig('D:/models')
    config.asrLightModelDirectory = 'D:/custom/my-own-model-folder'
    expect(resolveAsrExecutionPlan(config).primary).toMatchObject({
      directory: 'D:/custom/my-own-model-folder',
      computeType: 'int8'
    })
  })

  it('recognizes resource errors and maps user messages', () => {
    expect(isAsrResourceError('CUDA out of memory')).toBe(true)
    expect(isAsrResourceError("DefaultCPUAllocator: can't allocate memory")).toBe(true)
    expect(asrResourceErrorUserMessage('faster-whisper-large-v3-turbo')).toContain('最轻量')
    expect(asrResourceErrorUserMessage('faster-whisper-large-v3')).toContain('显卡显存或系统内存不足')
  })

  it('recognizes mode-A alignment quality failures', () => {
    expect(isAsrAlignmentQualityError('模式 A 对齐结果未完整保留用户文案。')).toBe(true)
    expect(isAsrAlignmentQualityError('CUDA out of memory')).toBe(false)
    expect(asrAlignmentFallbackNoticeMessage()).toContain('Large v3')
  })
})
