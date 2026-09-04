import { useEffect, useRef, useState } from 'react'
import { FilmStrip, Play } from '@phosphor-icons/react'

type VideoPreviewSlotProps = {
  /** 本地文件绝对路径；空则显示占位 */
  videoPath: string
  emptyHint?: string
  emptySubHint?: string
  onError?: (message: string) => void
}

/** 下载完成后的视频预览（两个工具可共用） */
export function VideoPreviewSlot({
  videoPath,
  emptyHint = '下载完成后在此预览',
  emptySubHint = 'YouTube · Facebook · Instagram · TikTok · Bilibili',
  onError
}: VideoPreviewSlotProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [orientation, setOrientation] = useState<'portrait' | 'landscape' | 'unknown'>('unknown')
  const videoSrc = videoPath ? window.koubox.mediaUrl(videoPath) : ''

  useEffect(() => {
    setOrientation('unknown')
    setPlaying(false)
  }, [videoSrc])

  const play = async () => {
    const el = videoRef.current
    if (!el) return
    try {
      await el.play()
      setPlaying(true)
    } catch (err) {
      onError?.(err instanceof Error ? err.message : '视频无法播放')
    }
  }

  return (
    <div className="downloader-preview">
      <div className="viral-slot-label">
        <FilmStrip size={15} />
        <span>视频文件</span>
      </div>
      {videoSrc ? (
        <div className={`viral-media-frame is-${orientation}`}>
          <video
            ref={videoRef}
            className="viral-media-player"
            controls
            preload="metadata"
            src={videoSrc}
            onLoadedMetadata={(e) => {
              const el = e.currentTarget
              setOrientation(el.videoHeight >= el.videoWidth ? 'portrait' : 'landscape')
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
          />
          {!playing && (
            <button type="button" className="viral-media-play" onClick={() => void play()} aria-label="播放视频">
              <Play size={26} weight="fill" />
            </button>
          )}
        </div>
      ) : (
        <div className="viral-phone-placeholder downloader-preview-empty">
          <span>{emptyHint}</span>
          <small>{emptySubHint}</small>
        </div>
      )}
    </div>
  )
}
