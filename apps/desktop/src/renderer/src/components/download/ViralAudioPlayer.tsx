import { useEffect, useRef, useState } from 'react'
import { Pause, Play } from '@phosphor-icons/react'

function formatAudioTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const m = Math.floor(total / 60)
  const s = String(total % 60).padStart(2, '0')
  return `${m}:${s}`
}

type ViralAudioPlayerProps = {
  audioPath: string
  emptyHint?: string
  onError?: (message: string) => void
}

/** 与语音转文字结果预览一致的全宽自定义音频条 */
export function ViralAudioPlayer({ audioPath, emptyHint, onError }: ViralAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState({ current: 0, duration: 0 })

  useEffect(() => {
    setPlaying(false)
    setProgress({ current: 0, duration: 0 })
  }, [audioPath])

  if (!audioPath) {
    return (
      <div className="viral-slot-empty speech-audio-empty" aria-hidden={!emptyHint}>
        {emptyHint}
      </div>
    )
  }

  const src = window.koubox.mediaUrl(audioPath)

  const play = async () => {
    const el = audioRef.current
    if (!el) return
    try {
      await el.play()
      setPlaying(true)
    } catch (err) {
      onError?.(err instanceof Error ? err.message : '音频无法播放')
    }
  }

  const seek = (ratio: number) => {
    const el = audioRef.current
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return
    el.currentTime = Math.max(0, Math.min(1, ratio)) * el.duration
  }

  return (
    <div className="viral-audio-frame">
      <audio
        ref={audioRef}
        preload="metadata"
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(e) => {
          setProgress({ current: 0, duration: e.currentTarget.duration || 0 })
        }}
        onTimeUpdate={(e) => {
          setProgress({
            current: e.currentTarget.currentTime,
            duration: e.currentTarget.duration || 0
          })
        }}
        onError={() => onError?.('音频无法播放，请检查文件是否已生成。')}
      />
      <button
        type="button"
        className={`viral-audio-play-btn ${playing ? 'playing' : ''}`}
        onClick={() => {
          if (playing) {
            audioRef.current?.pause()
            setPlaying(false)
          } else {
            void play()
          }
        }}
        aria-label={playing ? '暂停音频' : '播放音频'}
      >
        {playing ? <Pause size={20} weight="fill" /> : <Play size={20} weight="fill" />}
      </button>
      <div className="viral-audio-meta">
        <input
          type="range"
          className="viral-audio-seek"
          min={0}
          max={1000}
          value={progress.duration > 0 ? Math.round((progress.current / progress.duration) * 1000) : 0}
          onChange={(e) => seek(Number(e.target.value) / 1000)}
          aria-label="音频进度"
        />
        <div className="viral-audio-time">
          <span>{formatAudioTime(progress.current)}</span>
          <span>{formatAudioTime(progress.duration)}</span>
        </div>
      </div>
    </div>
  )
}
