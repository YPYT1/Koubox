export type AsrModelId = 'faster-whisper-large-v3' | 'faster-whisper-large-v3-turbo'

export type AsrComputeType = 'float16' | 'int8'

export type AsrModelCatalogEntry = {
  id: AsrModelId
  label: string
  directoryName: string
  runtimeModelId: 'asr' | 'asr-turbo'
  computeType: AsrComputeType
  formatLabel: string
}

export const ASR_MODEL_CATALOG: Record<AsrModelId, AsrModelCatalogEntry> = {
  'faster-whisper-large-v3': {
    id: 'faster-whisper-large-v3',
    label: 'Faster-Whisper Large v3（FP16）',
    directoryName: 'faster-whisper-large-v3',
    runtimeModelId: 'asr',
    computeType: 'float16',
    formatLabel: 'CTranslate2 · FP16'
  },
  'faster-whisper-large-v3-turbo': {
    id: 'faster-whisper-large-v3-turbo',
    label: 'faster-whisper-large-v3-turbo',
    directoryName: 'faster-whisper-large-v3-turbo-int8-ct2',
    runtimeModelId: 'asr-turbo',
    computeType: 'int8',
    formatLabel: 'CTranslate2 · INT8'
  }
}

export const DEFAULT_ASR_MODEL: AsrModelId = 'faster-whisper-large-v3-turbo'

export const ASR_MODEL_OPTIONS: Array<{ value: AsrModelId; label: string }> = [
  { value: 'faster-whisper-large-v3-turbo', label: ASR_MODEL_CATALOG['faster-whisper-large-v3-turbo'].label },
  { value: 'faster-whisper-large-v3', label: ASR_MODEL_CATALOG['faster-whisper-large-v3'].label }
]

export function asAsrModelId(value: unknown, fallback: AsrModelId = DEFAULT_ASR_MODEL): AsrModelId {
  return value === 'faster-whisper-large-v3' || value === 'faster-whisper-large-v3-turbo' ? value : fallback
}

export function resolveAsrComputeType(modelId: AsrModelId): AsrComputeType {
  return ASR_MODEL_CATALOG[modelId].computeType
}

export function isAsrResourceError(message: string): boolean {
  return /CUDA.*out of memory|out of memory|OutOfMemoryError|CUDA error|显存不足|显存不够|内存不足|MemoryError|DefaultCPUAllocator|can't allocate memory/i.test(message)
}

export function asrResourceErrorUserMessage(modelId: AsrModelId): string {
  if (modelId === 'faster-whisper-large-v3-turbo') {
    return '显存或内存不足。当前已使用最轻量的语音识别模型 faster-whisper-large-v3-turbo，请关闭其他占用 GPU 的程序后重试，或缩短音频长度。'
  }
  return '显卡显存或系统内存不足，请先关闭其他占用 GPU 的程序后重试。'
}

export function asrFallbackNoticeMessage(): string {
  return '显存或内存不足，已自动切换到轻量模型 faster-whisper-large-v3-turbo 继续识别。'
}
