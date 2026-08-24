import { useState, useEffect } from 'react'
import { ClipboardText, Clock, FileText, FolderOpen, Trash } from '@phosphor-icons/react'
import { toUserTaskMessage, type TaskArtifacts, type TaskKind, type TaskSnapshot } from '@koubox/shared'
import { Button } from '../components/common/Button'

type TaskHistoryPageProps = {
  kind: TaskKind
  outputDirectory: string
  onShowToast: (message: string) => void
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

function isDeletable(task: TaskSnapshot): boolean {
  return task.status !== 'running' && task.status !== 'queued'
}

export function TaskHistoryPage({ kind, outputDirectory, onShowToast }: TaskHistoryPageProps) {
  const [tasks, setTasks] = useState<TaskSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())
  const [clearing, setClearing] = useState(false)

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
    void loadTasks()
  }, [kind])

  const deletableTasks = tasks.filter(isDeletable)
  const title = '任务中心'
  const subtitle = '按任务 ID 管理状态、产物与保存目录'

  const handleCopyPath = (path: string) => {
    void navigator.clipboard.writeText(path)
    onShowToast('路径已复制')
  }

  const handleOpenDir = async (path: string) => {
    try {
      await window.koubox.post('/dialog/open-path', { path })
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '无法打开目录')
    }
  }

  const handleDelete = async (taskId: string) => {
    if (deletingIds.has(taskId)) return
    setDeletingIds((current) => new Set(current).add(taskId))
    try {
      await window.koubox.del(`/tasks/${encodeURIComponent(taskId)}`)
      setTasks((current) => current.filter((item) => item.taskId !== taskId))
      onShowToast('记录已删除')
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
    if (!window.confirm(`确定清空 ${deletableTasks.length} 条任务记录？已下载的文件不会被删除。`)) return
    setClearing(true)
    let deleted = 0
    const deletedIds = new Set<string>()
    for (const item of deletableTasks) {
      try {
        await window.koubox.del(`/tasks/${encodeURIComponent(item.taskId)}`)
        deletedIds.add(item.taskId)
        deleted += 1
      } catch (err) {
        onShowToast(err instanceof Error ? err.message : '删除失败')
        break
      }
    }
    if (deleted > 0) {
      setTasks((current) => current.filter((item) => !deletedIds.has(item.taskId)))
      onShowToast(`已删除 ${deleted} 条记录`)
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
        <div style={{ display: 'flex', gap: 8 }}>
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
            const artifactsList = Object.entries(item.artifacts).filter(
              ([key, path]) => Boolean(path) && !HIDDEN_ARTIFACT_KEYS.has(key)
            ) as Array<[keyof TaskArtifacts, string]>

            return (
              <article className="history-card" key={item.taskId}>
                <header className="history-card-head">
                  <div className="history-card-title">
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
                        className="history-file-chip"
                        onClick={() => handleCopyPath(filePath)}
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
                      title={canDelete ? '删除这条记录' : '任务进行中，无法删除'}
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
    </div>
  )
}
