import { useState, useEffect, useRef } from 'react'
import { ClipboardText, Clock, FileText, FolderOpen, Trash, X, Copy, Check } from '@phosphor-icons/react'
import { detectPlatform, req1UsesSeparateVocals, toUserTaskMessage, type TaskArtifacts, type TaskKind, type TaskSnapshot } from '@koubox/shared'
import { Button } from '../components/common/Button'

type TaskHistoryPageProps = {
  kind: TaskKind
  outputDirectory: string
  onShowToast: (message: string) => void
}

type PreviewType = 'video' | 'audio' | 'text'

type ArtifactPreview = {
  type: PreviewType
  title: string
  path: string
}

const ARTIFACT_LABEL: Partial<Record<keyof TaskArtifacts, string>> = {
  video: '视频',
  audio: '原音频',
  vocals: '人声',
  sourceAudio: '源音频',
  transcriptText: '原文案',
  translationText: '翻译文案',
  srt: 'SRT'
}

const HIDDEN_ARTIFACT_KEYS = new Set(['transcript', 'translation'])
const DELETE_FILES_STORAGE_KEY = 'koubox.task-center.delete-files'

function readDeleteFilesPreference(): boolean {
  try {
    return localStorage.getItem(DELETE_FILES_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeDeleteFilesPreference(enabled: boolean): void {
  try {
    localStorage.setItem(DELETE_FILES_STORAGE_KEY, enabled ? '1' : '0')
  } catch { /* ignore */ }
}

function deleteTaskPath(taskId: string, deleteFiles: boolean): string {
  return `/tasks/${encodeURIComponent(taskId)}${deleteFiles ? '?deleteFiles=1' : ''}`
}

function isDeletable(task: TaskSnapshot): boolean {
  return task.status !== 'running' && task.status !== 'queued'
}

type PlatformBadge = { label: string; className: string }

function detectPlatformBadge(url: string, kind: TaskKind): PlatformBadge {
  if (kind === 'req2' || kind === 'vocal-separation' || kind === 'speech-to-text') {
    return { label: '本地媒体', className: 'platform-local' }
  }
  if (kind === 'video-audio' && !/^https?:\/\//i.test(url)) return { label: '本地视频', className: 'platform-local' }
  const platform = detectPlatform(url)
  if (platform === 'YouTube') return { label: platform, className: 'platform-youtube' }
  if (platform === 'TikTok') return { label: platform, className: 'platform-tiktok' }
  if (platform === 'Instagram') return { label: platform, className: 'platform-instagram' }
  if (platform === 'Facebook') return { label: platform, className: 'platform-facebook' }
  return { label: platform === 'Audio' ? '本地音频' : platform, className: 'platform-local' }
}

export function TaskHistoryPage({ kind, outputDirectory, onShowToast }: TaskHistoryPageProps) {
  const lastLoadedKindRef = useRef<TaskKind | null>(null)
  const [tasks, setTasks] = useState<TaskSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())
  const [clearing, setClearing] = useState(false)
  const [preview, setPreview] = useState<ArtifactPreview | null>(null)
  const [previewText, setPreviewText] = useState('')
  const [previewTextLoading, setPreviewTextLoading] = useState(false)
  const [activeChipKey, setActiveChipKey] = useState<string | null>(null)
  const [previewCopied, setPreviewCopied] = useState(false)
  const [deleteFilesOnRemove, setDeleteFilesOnRemove] = useState(readDeleteFilesPreference)

  const loadTasks = () => {
    setLoading(true)
    return window.koubox
      .get<TaskSnapshot[]>('/tasks')
      .then((all) => {
        setTasks(all.filter((t) => t.kind === kind))
      })
      .catch(() => setTasks([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (lastLoadedKindRef.current === kind) return
    lastLoadedKindRef.current = kind
    void loadTasks()
  }, [kind])

  const deletableTasks = tasks.filter(isDeletable)
  const title = '任务中心'
  const subtitle = '按任务 ID 管理状态、产物与保存目录'

  const handleOpenPreview = async (taskId: string, key: keyof TaskArtifacts, path: string) => {
    const chipKey = `${taskId}:${key}`
    setActiveChipKey(chipKey)
    window.setTimeout(() => {
      setActiveChipKey((current) => (current === chipKey ? null : current))
    }, 260)
    const title = ARTIFACT_LABEL[key] ?? key
    if (key === 'video') {
      setPreview({ type: 'video', title, path })
      setPreviewText('')
      setPreviewTextLoading(false)
      return
    }
    if (key === 'audio' || key === 'sourceAudio' || key === 'vocals') {
      setPreview({ type: 'audio', title, path })
      setPreviewText('')
      setPreviewTextLoading(false)
      return
    }
    if (key === 'transcriptText' || key === 'translationText' || key === 'srt') {
      setPreview({ type: 'text', title, path })
      setPreviewText('')
      setPreviewTextLoading(true)
      setPreviewCopied(false)
      try {
        const response = await fetch(window.koubox.mediaUrl(path))
        if (!response.ok) throw new Error(`读取失败（${response.status}）`)
        const text = await response.text()
        setPreviewText(text)
      } catch (err) {
        setPreviewText('')
        onShowToast(err instanceof Error ? err.message : '无法读取预览内容')
      } finally {
        setPreviewTextLoading(false)
      }
      return
    }
    void navigator.clipboard.writeText(path)
    onShowToast('路径已复制')
  }

  const handleCopyPreviewText = async () => {
    if (!previewText.trim()) return
    await navigator.clipboard.writeText(previewText)
    setPreviewCopied(true)
    window.setTimeout(() => setPreviewCopied(false), 900)
  }

  const handleOpenDir = async (path: string) => {
    try {
      await window.koubox.post('/dialog/open-path', { path })
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '无法打开目录')
    }
  }

  const handleDeleteFilesToggle = () => {
    setDeleteFilesOnRemove((current) => {
      const next = !current
      writeDeleteFilesPreference(next)
      return next
    })
  }

  const handleDelete = async (taskId: string) => {
    if (deletingIds.has(taskId)) return
    setDeletingIds((current) => new Set(current).add(taskId))
    try {
      await window.koubox.del(deleteTaskPath(taskId, deleteFilesOnRemove))
      setTasks((current) => current.filter((item) => item.taskId !== taskId))
      onShowToast(deleteFilesOnRemove ? '记录与任务文件已删除' : '记录已删除')
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '删除失败')
    } finally {
      setDeletingIds((current) => {
        const next = new Set(current)
        next.delete(taskId)
        return next
      })
    }
  }

  const handleClearAll = async () => {
    if (deletableTasks.length === 0 || clearing) return
    setClearing(true)
    let deleted = 0
    const deletedIds = new Set<string>()
    for (const item of deletableTasks) {
      try {
        await window.koubox.del(deleteTaskPath(item.taskId, deleteFilesOnRemove))
        deletedIds.add(item.taskId)
        deleted += 1
      } catch (err) {
        onShowToast(err instanceof Error ? err.message : '删除失败')
        break
      }
    }
    if (deleted > 0) {
      setTasks((current) => current.filter((item) => !deletedIds.has(item.taskId)))
      onShowToast(deleteFilesOnRemove ? `已删除 ${deleted} 条记录及对应文件` : `已删除 ${deleted} 条记录`)
    }
    setClearing(false)
  }

  return (
    <div className="page-container">
      <div className="page-header-block history-page-header">
        <div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        <div className="history-page-actions">
          <span className="history-delete-files-label">删除时同时删除文件</span>
          <button
            type="button"
            role="switch"
            aria-checked={deleteFilesOnRemove}
            aria-label="删除时同时删除文件"
            className={`ui-switch ${deleteFilesOnRemove ? 'on' : ''}`}
            onClick={handleDeleteFilesToggle}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                handleDeleteFilesToggle()
              }
            }}
          >
            <span className="ui-switch-thumb" />
          </button>
          {outputDirectory && (
            <Button
              variant="secondary"
              size="sm"
              icon={<FolderOpen size={14} />}
              onClick={() => void handleOpenDir(outputDirectory)}
            >
              打开输出根目录
            </Button>
          )}
          {!loading && deletableTasks.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Trash size={14} />}
              loading={clearing}
              onClick={() => void handleClearAll()}
            >
              清空记录
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="empty-sessions-hint" style={{ padding: 48 }}>正在读取…</div>
      ) : tasks.length === 0 ? (
        <div className="panel-box" style={{ alignItems: 'center', textAlign: 'center', padding: '60px 24px' }}>
          <ClipboardText size={28} color="var(--text-tertiary)" />
          <h3 style={{ fontSize: 16, fontWeight: 700, marginTop: 12 }}>暂无任务记录</h3>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>在「开始处理」中运行任务后会出现在这里。</p>
        </div>
      ) : (
        <div className="history-list">
          {tasks.map((item) => {
            const isComplete = item.status === 'complete'
            const isError = item.status === 'error'
            const canDelete = isDeletable(item)
            const deleting = deletingIds.has(item.taskId)
            const platform = detectPlatformBadge(item.url, item.kind)
            const artifactsList = Object.entries(item.artifacts).filter(
              ([key, path]) =>
                Boolean(path) &&
                !HIDDEN_ARTIFACT_KEYS.has(key) &&
                !(key === 'vocals' && item.kind === 'req1' && !req1UsesSeparateVocals(item))
            ) as Array<[keyof TaskArtifacts, string]>

            return (
              <article className="history-card" key={item.taskId}>
                <header className="history-card-head">
                  <div className="history-card-title">
                    <span className={`platform-badge ${platform.className}`}>{platform.label}</span>
                    <span
                      className="panel-title-badge"
                      style={{
                        color: isComplete ? '#10b981' : isError ? '#ef4444' : '#0f766e',
                        background: isComplete ? '#ecfdf5' : isError ? '#fef2f2' : '#ecfdf5'
                      }}
                    >
                      {isComplete ? '已完成' : isError ? '失败' : item.status === 'cancelled' ? '已取消' : '运行中'}
                    </span>
                    <strong>{item.taskId}</strong>
                  </div>
                  <div className="history-card-meta">
                    <Clock size={14} />
                    <span>{new Date(item.createdAt).toLocaleString('zh-CN')}</span>
                  </div>
                </header>

                <p className="history-source" title={item.url}>
                  来源：{item.url}
                </p>

                {artifactsList.length > 0 && (
                  <div className="history-files">
                    {artifactsList.map(([key, filePath]) => (
                      <button
                        type="button"
                        key={key}
                        className={`history-file-chip ${activeChipKey === `${item.taskId}:${key}` ? 'is-active' : ''}`}
                        onClick={() => void handleOpenPreview(item.taskId, key, filePath)}
                        title={filePath}
                      >
                        <FileText size={13} />
                        <span>{ARTIFACT_LABEL[key] ?? key}</span>
                        <code>{filePath.split(/[/\\]/).pop()}</code>
                      </button>
                    ))}
                  </div>
                )}

                {isError && item.message ? (
                  <p className="history-error">{toUserTaskMessage(item.message)}</p>
                ) : null}

                <footer className="history-card-foot">
                  {!isError && item.message ? (
                    <span className="history-message" title={item.message}>{item.message}</span>
                  ) : null}
                  <div className="history-card-actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<FolderOpen size={14} />}
                      onClick={() => void handleOpenDir(item.outputDirectory)}
                    >
                      打开目录
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="history-delete-btn"
                      icon={<Trash size={14} />}
                      disabled={!canDelete}
                      loading={deleting}
                      title={canDelete
                        ? deleteFilesOnRemove
                          ? '删除记录并删除任务文件'
                          : '仅删除这条记录'
                        : '任务进行中，无法删除'}
                      onClick={() => void handleDelete(item.taskId)}
                    >
                      删除
                    </Button>
                  </div>
                </footer>
              </article>
            )
          })}
        </div>
      )}
      {preview && (
        <div className="history-preview-overlay" onClick={() => setPreview(null)}>
          <div className="history-preview-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="history-preview-head">
              <h3>{preview.title}</h3>
              <div className="history-preview-actions">
                {preview.type === 'text' && (
                  <button
                    type="button"
                    className={`btn-secondary history-preview-copy ${previewCopied ? 'is-copied' : ''}`}
                    style={{ height: 30, padding: '0 10px', fontSize: 12 }}
                    onClick={() => void handleCopyPreviewText()}
                    disabled={previewTextLoading || !previewText.trim()}
                  >
                    {previewCopied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
                    <span>{previewCopied ? '已复制' : '复制全文'}</span>
                  </button>
                )}
                <button type="button" className="history-preview-close" onClick={() => setPreview(null)} aria-label="关闭预览">
                  <X size={16} weight="bold" />
                </button>
              </div>
            </div>
            <div className="history-preview-body">
              {preview.type === 'video' && (
                <video className="history-preview-video" controls preload="metadata" src={window.koubox.mediaUrl(preview.path)} />
              )}
              {preview.type === 'audio' && (
                <audio className="history-preview-audio" controls preload="metadata" src={window.koubox.mediaUrl(preview.path)} />
              )}
              {preview.type === 'text' && (
                previewTextLoading
                  ? <div className="history-preview-loading">正在读取内容…</div>
                  : <pre className="history-preview-text">{previewText || '内容为空。'}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
