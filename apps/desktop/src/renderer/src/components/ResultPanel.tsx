import { useState } from 'react'
import { Copy, Table, FileText, Check, DownloadSimple, Translate } from '@phosphor-icons/react'
import type { Transcript } from '@koubox/shared'

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
            <div style={{ display: 'flex', gap: 4, marginRight: 6 }}>
              <button
                className={`btn-secondary ${viewMode === 'segments' ? 'active' : ''}`}
                style={{ height: 32, padding: '0 10px', fontSize: 12 }}
                onClick={() => setViewMode('segments')}
                title="分句时间轴视图"
              >
                <Table size={14} />
                <span>时间轴</span>
              </button>
              <button
                className={`btn-secondary ${viewMode === 'text' ? 'active' : ''}`}
                style={{ height: 32, padding: '0 10px', fontSize: 12 }}
                onClick={() => setViewMode('text')}
                title="纯文本视图"
              >
                <FileText size={14} />
                <span>文本</span>
              </button>
            </div>
          )}

          <button
            className="btn-secondary"
            style={{ height: 32, padding: '0 12px', fontSize: 12 }}
            onClick={handleCopy}
          >
            {copied ? <Check size={14} color="#10b981" /> : <Copy size={14} />}
            <span>{copied ? '已复制' : '复制全文'}</span>
          </button>

          {action && actionLabel && (
            <button
              className="btn-primary"
              style={{ height: 32, padding: '0 14px', fontSize: 12 }}
              onClick={action}
              disabled={disabled}
            >
              {actionIcon === 'translate' ? (
                <Translate size={14} />
              ) : (
                <DownloadSimple size={14} />
              )}
              <span>{actionLabel}</span>
            </button>
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
