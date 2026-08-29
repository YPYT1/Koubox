type AudioPreviewSlotProps = {
  audioPath: string
  label?: string
  onError?: (message: string) => void
}

/** 任务产物音频预览 */
export function AudioPreviewSlot({ audioPath, label, onError }: AudioPreviewSlotProps) {
  if (!audioPath) {
    return <div className="viral-slot-empty speech-audio-empty" aria-hidden="true" />
  }

  const src = window.koubox.mediaUrl(audioPath)

  return (
    <div className="viral-audio-preview">
      {label ? <p className="viral-preview-hint">{label}</p> : null}
      <audio
        controls
        preload="metadata"
        src={src}
        onError={() => onError?.('音频无法播放，请检查文件是否已生成。')}
      />
    </div>
  )
}
