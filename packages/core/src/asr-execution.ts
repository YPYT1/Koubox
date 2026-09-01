import { basename, join } from 'node:path'
import {
  ASR_MODEL_CATALOG,
  asAsrModelId,
  resolveAsrComputeType,
  type AsrComputeType,
  type AsrModelId,
  type KouboxConfig
} from '@koubox/shared'

const LEGACY_ASR_DIRECTORY = 'whisperlargev3turbo'

export type ResolvedAsrModel = {
  id: AsrModelId
  directory: string
  computeType: AsrComputeType
}

export type AsrExecutionPlan = {
  selectedModel: AsrModelId
  primary: ResolvedAsrModel
  fallback?: ResolvedAsrModel
}

export type AsrExecutionResult<T> = {
  value: T
  effectiveModel: AsrModelId
  fallbackUsed: boolean
}

export class AsrResourceExhaustedError extends Error {
  readonly modelId: AsrModelId

  constructor(modelId: AsrModelId, options?: ErrorOptions) {
    super(`ASR resources exhausted while using ${modelId}`, options)
    this.name = 'AsrResourceExhaustedError'
    this.modelId = modelId
  }
}

export function migrateLegacyAsrModelDirectory(directory: string, modelsDirectory: string): string {
  if (!directory) return join(modelsDirectory, ASR_MODEL_CATALOG['faster-whisper-large-v3'].directoryName)
  if (basename(directory).toLowerCase() === LEGACY_ASR_DIRECTORY) {
    return join(modelsDirectory, ASR_MODEL_CATALOG['faster-whisper-large-v3'].directoryName)
  }
  return directory
}

export function resolveAsrModelDirectory(config: KouboxConfig, modelId: AsrModelId): string {
  if (modelId === 'faster-whisper-large-v3-turbo') {
    return config.asrLightModelDirectory
      || join(config.modelsDirectory, ASR_MODEL_CATALOG['faster-whisper-large-v3-turbo'].directoryName)
  }
  return config.asrModelDirectory
    || join(config.modelsDirectory, ASR_MODEL_CATALOG['faster-whisper-large-v3'].directoryName)
}

function resolvedModel(config: KouboxConfig, modelId: AsrModelId): ResolvedAsrModel {
  return {
    id: modelId,
    directory: resolveAsrModelDirectory(config, modelId),
    computeType: resolveAsrComputeType(modelId)
  }
}

export function resolveAsrExecutionPlan(config: KouboxConfig): AsrExecutionPlan {
  const selectedModel = asAsrModelId(config.defaultAsrModel)
  const primary = resolvedModel(config, selectedModel)
  const fallbackId = selectedModel === 'faster-whisper-large-v3'
    ? 'faster-whisper-large-v3-turbo'
    : 'faster-whisper-large-v3'
  return {
    selectedModel,
    primary,
    fallback: resolvedModel(config, fallbackId)
  }
}

export function resolveAsrModelPaths(config: KouboxConfig): {
  asr: string
  asrLight: string
  asrPrimary: string
  asrFallback?: string
  defaultAsrModel: AsrModelId
} {
  const plan = resolveAsrExecutionPlan(config)
  return {
    asr: resolveAsrModelDirectory(config, 'faster-whisper-large-v3'),
    asrLight: resolveAsrModelDirectory(config, 'faster-whisper-large-v3-turbo'),
    asrPrimary: plan.primary.directory,
    asrFallback: plan.fallback?.directory,
    defaultAsrModel: plan.selectedModel
  }
}

export type AsrFallbackReason = 'resource-exhausted' | 'alignment-quality'

export function shouldFallbackAsrAttempt(
  error: unknown,
  primary: ResolvedAsrModel,
  fallback: ResolvedAsrModel,
  options: {
    isResourceError(error: unknown): boolean
    isAlignmentQualityError(error: unknown): boolean
  }
): AsrFallbackReason | undefined {
  const fallingToLighter = primary.id === 'faster-whisper-large-v3'
    && fallback.id === 'faster-whisper-large-v3-turbo'
  const fallingToHeavier = primary.id === 'faster-whisper-large-v3-turbo'
    && fallback.id === 'faster-whisper-large-v3'
  if (options.isResourceError(error) && fallingToLighter) return 'resource-exhausted'
  if (options.isAlignmentQualityError(error) && fallingToHeavier) return 'alignment-quality'
  return undefined
}

export async function runAsrExecutionPlan<T>(
  plan: AsrExecutionPlan,
  options: {
    runAttempt(model: ResolvedAsrModel, isFallback: boolean): Promise<T>
    isResourceError(error: unknown): boolean
    isAlignmentQualityError?(error: unknown): boolean
    onFallback?(from: ResolvedAsrModel, to: ResolvedAsrModel, reason: AsrFallbackReason): Promise<void> | void
  }
): Promise<AsrExecutionResult<T>> {
  const isAlignmentQualityError = options.isAlignmentQualityError ?? (() => false)
  try {
    return {
      value: await options.runAttempt(plan.primary, false),
      effectiveModel: plan.primary.id,
      fallbackUsed: false
    }
  } catch (error) {
    if (!plan.fallback) {
      if (options.isResourceError(error)) throw new AsrResourceExhaustedError(plan.primary.id, { cause: error })
      throw error
    }
    const reason = shouldFallbackAsrAttempt(error, plan.primary, plan.fallback, {
      isResourceError: options.isResourceError,
      isAlignmentQualityError
    })
    if (!reason) {
      if (options.isResourceError(error)) throw new AsrResourceExhaustedError(plan.primary.id, { cause: error })
      throw error
    }

    await options.onFallback?.(plan.primary, plan.fallback, reason)
    try {
      return {
        value: await options.runAttempt(plan.fallback, true),
        effectiveModel: plan.fallback.id,
        fallbackUsed: true
      }
    } catch (fallbackError) {
      if (options.isResourceError(fallbackError)) {
        throw new AsrResourceExhaustedError(plan.fallback.id, { cause: fallbackError })
      }
      throw fallbackError
    }
  }
}
