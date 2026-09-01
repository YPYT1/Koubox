import type { AsrExecutionPlan } from '../src/asr-execution.js'

export function testModelPaths(overrides: Partial<{
  asr: string
  asrLight: string
  asrPlan: AsrExecutionPlan
  translation: string
}> = {}) {
  const asr = overrides.asr ?? ''
  const asrLight = overrides.asrLight ?? `${asr}-light`
  return {
    asr,
    asrLight,
    asrPlan: overrides.asrPlan ?? {
      selectedModel: 'faster-whisper-large-v3',
      primary: { id: 'faster-whisper-large-v3', directory: asr, computeType: 'float16' },
      fallback: { id: 'faster-whisper-large-v3-turbo', directory: asrLight, computeType: 'int8' }
    },
    translation: overrides.translation ?? ''
  }
}
