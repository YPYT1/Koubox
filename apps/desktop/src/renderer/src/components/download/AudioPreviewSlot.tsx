import { Waveform } from '@phosphor-icons/react'

type AudioPreviewSlotProps = {
  audioPath: string
  label?: string
  onError?: (message: string) => void
}

/** 任务产物音频预览 */
export function AudioPreviewSlot({ audioPath, label = '音频预览', onError }: AudioPreviewSlotProps) {
  if (!audioPath) {
    return (
      <div className="viral-preview-empty">
        <Waveform size={32} weight="duotone" />
        <p>任务完成后可在此播放音频</p>
      </div>
    )
  }

  const src = window.koubox.mediaUrl(audioPath)

  return (
    <div className="viral-audio-preview">
      <p className="viral-preview-hint">{label}</p>
      <audio
        controls
        preload="metadata"
        src={src}
        onError={() => onError?.('音频无法播放，请检查文件是否已生成。')}
      />
    </div>
  )
}
