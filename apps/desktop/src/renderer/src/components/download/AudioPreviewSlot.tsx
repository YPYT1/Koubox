import { useState } from 'react'

type AudioPreviewSlotProps = {
  audioPath: string
  label?: string
  onError?: (message: string) => void
  /** 按音频时长自适应宽度，并居中显示 */
  adaptiveWidth?: boolean
}

const ADAPTIVE_REFERENCE_SECONDS = 90
const ADAPTIVE_MIN_WIDTH_PERCENT = 28

function adaptiveWidthPercent(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 100
  return Math.min(100, Math.max(ADAPTIVE_MIN_WIDTH_PERCENT, (duration / ADAPTIVE_REFERENCE_SECONDS) * 100))
}

/** 任务产物音频预览 */
export function AudioPreviewSlot({ audioPath, label, onError, adaptiveWidth }: AudioPreviewSlotProps) {
  const [duration, setDuration] = useState<number | null>(null)

  if (!audioPath) {
    return <div className="viral-slot-empty speech-audio-empty" aria-hidden="true" />
  }

  const src = window.koubox.mediaUrl(audioPath)
  const widthPercent = adaptiveWidth && duration ? adaptiveWidthPercent(duration) : undefined

  return (
    <div className={`viral-audio-preview${adaptiveWidth ? ' is-adaptive' : ''}`}>
      {label ? <p className="viral-preview-hint">{label}</p> : null}
      <audio
        controls
        preload="metadata"
        src={src}
        style={widthPercent ? { width: `${widthPercent}%` } : undefined}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onError={() => onError?.('音频无法播放，请检查文件是否已生成。')}
      />
    </div>
  )
}
