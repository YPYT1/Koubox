import { useState } from 'react'
import { Copy, Table, FileText, Check, DownloadSimple, Translate } from '@phosphor-icons/react'
import type { Transcript } from '@koubox/shared'
import { Button } from './common/Button'
import { cn } from '@/lib/utils'

type ResultPanelProps = {
  title: string
  transcript?: Transcript
  rawText: string
  onCopy: (text: string) => void
  action?: () => void
  actionLabel?: string
  actionIcon?: 'download' | 'translate'
  disabled?: boolean
}

function formatSeconds(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 1000)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`
}

export function ResultPanel({
  title,
  transcript,
  rawText,
  onCopy,
  action,
  actionLabel,
  actionIcon,
  disabled
}: ResultPanelProps) {
  const [viewMode, setViewMode] = useState<'segments' | 'text'>(
    transcript && transcript.segments.length > 0 ? 'segments' : 'text'
  )
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    onCopy(rawText)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const hasSegments = Boolean(transcript && transcript.segments && transcript.segments.length > 0)

  return (
    <div className="result-card">
      <div className="result-header">
        <h3>
          <span>{title}</span>
          {transcript?.language && (
            <span className="panel-title-badge">{transcript.language}</span>
          )}
        </h3>

        <div className="result-actions">
          {hasSegments && (
            <div className="mr-1.5 flex gap-1">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className={cn(viewMode === 'segments' && 'border-primary/40 bg-accent text-accent-foreground')}
                onClick={() => setViewMode('segments')}
                title="分句时间轴视图"
                icon={<Table size={14} />}
              >
                时间轴
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className={cn(viewMode === 'text' && 'border-primary/40 bg-accent text-accent-foreground')}
                onClick={() => setViewMode('text')}
                title="纯文本视图"
                icon={<FileText size={14} />}
              >
                文本
              </Button>
            </div>
          )}

          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleCopy}
            icon={copied ? <Check size={14} color="#10b981" /> : <Copy size={14} />}
          >
            {copied ? '已复制' : '复制全文'}
          </Button>

          {action && actionLabel && (
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={action}
              disabled={disabled}
              icon={actionIcon === 'translate' ? <Translate size={14} /> : <DownloadSimple size={14} />}
            >
              {actionLabel}
            </Button>
          )}
        </div>
      </div>

      {viewMode === 'segments' && hasSegments && transcript ? (
        <div className="segments-table">
          {transcript.segments.map((seg, idx) => (
            <div className="segment-row" key={`${seg.start}-${idx}`}>
              <span className="segment-index">#{idx + 1}</span>
              <span className="segment-time">
                {formatSeconds(seg.start)} → {formatSeconds(seg.end)}
              </span>
              <span className="segment-text">{seg.text}</span>
            </div>
          ))}
        </div>
      ) : (
        <pre className="raw-text-view">{rawText}</pre>
      )}
    </div>
  )
}
