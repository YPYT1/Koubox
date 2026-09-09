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
}

export type AsrExecutionResult<T> = {
  value: T
  effectiveModel: AsrModelId
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
  return { selectedModel, primary }
}

export function resolveAsrModelPaths(config: KouboxConfig): {
  asr: string
  asrLight: string
  asrPrimary: string
  defaultAsrModel: AsrModelId
} {
  const plan = resolveAsrExecutionPlan(config)
  return {
    asr: resolveAsrModelDirectory(config, 'faster-whisper-large-v3'),
    asrLight: resolveAsrModelDirectory(config, 'faster-whisper-large-v3-turbo'),
    asrPrimary: plan.primary.directory,
    defaultAsrModel: plan.selectedModel
  }
}

export async function runAsrExecutionPlan<T>(
  plan: AsrExecutionPlan,
  options: {
    runAttempt(model: ResolvedAsrModel): Promise<T>
    isResourceError(error: unknown): boolean
  }
): Promise<AsrExecutionResult<T>> {
  try {
    return {
      value: await options.runAttempt(plan.primary),
      effectiveModel: plan.primary.id
    }
  } catch (error) {
    if (options.isResourceError(error)) throw new AsrResourceExhaustedError(plan.primary.id, { cause: error })
    throw error
  }
}
