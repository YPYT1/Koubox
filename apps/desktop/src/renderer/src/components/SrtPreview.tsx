import { useState, useRef, useEffect } from 'react'
import { Play, Pause, Download, Copy, Eye } from '@phosphor-icons/react'
import { Button } from './common/Button'
import type { Transcript } from '@koubox/shared'

type SrtPreviewProps = {
  transcript: Transcript
  audioPath?: string
  onExport?: () => void
  onCopy?: () => void
}

export function SrtPreview({ transcript, audioPath, onExport, onCopy }: SrtPreviewProps) {
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // 根据当前播放时间找到对应的字幕索引
  const activeIndex = transcript.segments.findIndex(
    (seg) => currentTime >= seg.start && currentTime < seg.end
  )

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const updateTime = () => setCurrentTime(audio.currentTime)
    const handlePlay = () => setIsPlaying(true)
    const handlePause = () => setIsPlaying(false)
    const handleEnded = () => setIsPlaying(false)

    audio.addEventListener('timeupdate', updateTime)
    audio.addEventListener('play', handlePlay)
    audio.addEventListener('pause', handlePause)
    audio.addEventListener('ended', handleEnded)

    return () => {
      audio.removeEventListener('timeupdate', updateTime)
      audio.removeEventListener('play', handlePlay)
      audio.removeEventListener('pause', handlePause)
      audio.removeEventListener('ended', handleEnded)
    }
  }, [])

  // 自动滚动到当前字幕
  useEffect(() => {
    if (activeIndex >= 0 && containerRef.current) {
      const activeElement = containerRef.current.querySelector(
        `[data-index="${activeIndex}"]`
      ) as HTMLElement
      if (activeElement) {
        activeElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }
  }, [activeIndex])

  const togglePlayPause = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause()
      } else {
        void audioRef.current.play()
      }
    }
  }

  const seekToSegment = (index: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = transcript.segments[index].start
      setSelectedIndex(index)
    }
  }

  const formatTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)
    const ms = Math.floor((seconds % 1) * 1000)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
  }

  const getSrtContent = (): string => {
    return transcript.segments
      .filter((seg) => seg.text.trim() && seg.end >= seg.start)
      .map(
        (seg, idx) =>
          `${idx + 1}\n${formatTime(seg.start)} --> ${formatTime(seg.end)}\n${seg.text.trim()}`
      )
      .join('\n\n')
  }

  const handleCopyAll = () => {
    void navigator.clipboard.writeText(getSrtContent())
    onCopy?.()
  }

  return (
    <div className="panel-box">
      <div className="panel-title">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Eye size={20} weight="duotone" />
          <h3>SRT 字幕预览</h3>
          <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
            {transcript.segments.length} 条字幕
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="secondary" size="sm" onClick={handleCopyAll} icon={<Copy size={16} />}>
            复制全部
          </Button>
          {onExport && (
            <Button
              variant="primary-blue"
              size="sm"
              onClick={onExport}
              icon={<Download size={16} />}
            >
              导出 SRT
            </Button>
          )}
        </div>
      </div>

      {/* 音频播放器（如果有音频） */}
      {audioPath && (
        <div
          style={{
            padding: '12px 16px',
            background: 'var(--bg-tertiary)',
            borderRadius: 8,
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 12
          }}
        >
          <audio ref={audioRef} src={`file://${audioPath}`} />
          <Button
            variant="secondary"
            size="sm"
            onClick={togglePlayPause}
            icon={isPlaying ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}
          >
            {isPlaying ? '暂停' : '播放'}
          </Button>
          <div style={{ flex: 1, fontSize: 14, color: 'var(--text-secondary)' }}>
            {formatTime(currentTime)}
            {audioRef.current?.duration && ` / ${formatTime(audioRef.current.duration)}`}
          </div>
        </div>
      )}

      {/* 字幕列表 */}
      <div
        ref={containerRef}
        style={{
          maxHeight: 500,
          overflowY: 'auto',
          border: '1px solid var(--border-primary)',
          borderRadius: 8,
          background: 'var(--bg-primary)'
        }}
      >
        {transcript.segments.map((segment, index) => {
          const isActive = index === activeIndex
          const isSelected = index === selectedIndex

          return (
            <div
              key={index}
              data-index={index}
              onClick={() => seekToSegment(index)}
              style={{
                padding: '12px 16px',
                borderBottom:
                  index < transcript.segments.length - 1
                    ? '1px solid var(--border-primary)'
                    : undefined,
                cursor: audioPath ? 'pointer' : 'default',
                background: isActive
                  ? 'var(--accent-blue-bg)'
                  : isSelected
                    ? 'var(--bg-secondary)'
                    : undefined,
                transition: 'background 0.15s ease'
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 12,
                  marginBottom: 6
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: isActive ? 'var(--accent-blue)' : 'var(--text-tertiary)',
                    minWidth: 32
                  }}
                >
                  #{index + 1}
                </span>
                <span
                  style={{
                    fontSize: 13,
                    fontFamily: 'monospace',
                    color: 'var(--text-secondary)'
                  }}
                >
                  {formatTime(segment.start)} → {formatTime(segment.end)}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                  {((segment.end - segment.start) * 1000).toFixed(0)}ms
                </span>
              </div>
              <div
                style={{
                  fontSize: 15,
                  lineHeight: 1.6,
                  color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                  fontWeight: isActive ? 500 : 400,
                  paddingLeft: 44
                }}
              >
                {segment.text.trim()}
              </div>
            </div>
          )
        })}
      </div>

      {/* 统计信息 */}
      <div
        style={{
          marginTop: 12,
          padding: 12,
          background: 'var(--bg-tertiary)',
          borderRadius: 6,
          fontSize: 13,
          color: 'var(--text-secondary)',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 12
        }}
      >
        <div>
          <strong>总时长：</strong>
          {transcript.segments.length > 0
            ? formatTime(transcript.segments[transcript.segments.length - 1].end)
            : '00:00:00,000'}
        </div>
        <div>
          <strong>平均时长：</strong>
          {transcript.segments.length > 0
            ? `${(
                transcript.segments.reduce((sum, seg) => sum + (seg.end - seg.start), 0) /
                transcript.segments.length
              ).toFixed(2)}s`
            : '0s'}
        </div>
        <div>
          <strong>字幕条数：</strong>
          {transcript.segments.length}
        </div>
      </div>
    </div>
  )
}
