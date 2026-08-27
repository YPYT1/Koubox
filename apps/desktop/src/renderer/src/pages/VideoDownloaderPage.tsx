import { useEffect, useRef, useState } from 'react'
import { DownloadSimple, X } from '@phosphor-icons/react'
import { toUserTaskMessage } from '@koubox/shared'
import { Button } from '../components/common/Button'
import { FormField, PathPicker } from '../components/common/FormControls'
import { Badge } from '../components/common/Badge'
import { PipelineStepper } from '../components/common/PipelineStepper'
import { formatTaskPercent } from '../utils/progress'
import { VideoUrlField, VideoPreviewSlot, useVideoDownloadTask } from '../components/download'

type VideoDownloaderPageProps = {
  defaultOutputDirectory: string
  onChooseDirectory: (title: string, defaultPath?: string) => Promise<string | undefined>
  onShowToast: (message: string, type?: 'success' | 'warning' | 'error' | 'info') => void
  onTaskStatus?: (status: 'queued' | 'running' | 'complete' | 'error' | 'cancelled' | null) => void
}

const STEPS = [
  { stage: 'download', label: '解析并下载', desc: '识别平台并拉取公开视频文件' },
  { stage: 'complete', label: '完成', desc: '写入保存目录并可供预览' }
]

export function VideoDownloaderPage({
  defaultOutputDirectory,
  onChooseDirectory,
  onShowToast,
  onTaskStatus
}: VideoDownloaderPageProps) {
  const [url, setUrl] = useState('')
  const [outputDirectory, setOutputDirectory] = useState(defaultOutputDirectory)
  const { starting, task, start, cancel } = useVideoDownloadTask({
    mode: 'download-only',
    onToast: onShowToast,
    onStatus: onTaskStatus
  })
  const notifiedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!outputDirectory && defaultOutputDirectory) setOutputDirectory(defaultOutputDirectory)
  }, [defaultOutputDirectory, outputDirectory])

  useEffect(() => {
    if (!task) return
    if (task.status !== 'complete' && task.status !== 'error') return
    const key = `${task.taskId}:${task.status}:${task.error?.code ?? task.message}`
    if (notifiedRef.current === key) return
    notifiedRef.current = key
    if (task.status === 'complete') onShowToast('视频下载完成：保持原始视频流与音轨。', 'success')
    else onShowToast(toUserTaskMessage(task.message || task.error?.message || '下载失败'), 'error')
  }, [task, onShowToast])

  const isTaskRunning = Boolean(task && (task.status === 'queued' || task.status === 'running'))
  const status = task?.status ?? 'idle'
  const videoPath = task?.artifacts.video ?? ''

  const handleStart = async () => {
    await start(url, outputDirectory)
  }

  return (
    <div className="page-container viral-page downloader-page">
      <div className="page-header-block">
        <h1>视频下载</h1>
        <p>支持 YouTube、Facebook、Instagram、TikTok 公开视频下载到本地</p>
      </div>

      <div className="viral-top-grid">
        <section className="panel-box viral-input-panel">
          <div className="panel-title">
            <h3>下载参数</h3>
          </div>

          <VideoUrlField value={url} onChange={setUrl} disabled={isTaskRunning} />

          <FormField label="保存目录">
            <PathPicker
              value={outputDirectory}
              onChange={setOutputDirectory}
              onBrowse={async () => {
                const dir = await onChooseDirectory('选择视频保存目录', outputDirectory)
                if (dir) setOutputDirectory(dir)
              }}
              disabled={isTaskRunning}
            />
          </FormField>

          <div className="viral-actions">
            {!isTaskRunning ? (
              <Button
                variant="primary"
                size="lg"
                style={{ flex: 1 }}
                onClick={() => void handleStart()}
                loading={starting}
                icon={<DownloadSimple size={18} weight="bold" />}
              >
                {starting ? '正在启动…' : '开始下载'}
              </Button>
            ) : (
              <Button
                variant="danger"
                size="lg"
                style={{ flex: 1 }}
                onClick={() => void cancel()}
                icon={<X size={18} weight="bold" />}
              >
                取消下载
              </Button>
            )}
          </div>
        </section>

        <section className="panel-box viral-status-panel">
          <div className="panel-title">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h3>执行状态</h3>
              {status !== 'idle' && (
                <Badge
                  variant={
                    status === 'complete' ? 'success' : status === 'error' ? 'danger' : 'teal'
                  }
                  pulse={isTaskRunning}
                >
                  {status === 'complete'
                    ? '完成'
                    : status === 'error'
                      ? '失败'
                      : status === 'cancelled'
                        ? '已取消'
                        : '进行中'}
                </Badge>
              )}
            </div>
            {task && (
              <span className={`task-percent-tag ${isTaskRunning ? 'pulsing' : ''}`}>{formatTaskPercent(task.percent)}</span>
            )}
          </div>

          <PipelineStepper
            steps={STEPS}
            currentStage={task?.stage}
            status={task?.status}
            percent={task?.percent}
            message={task?.status === 'error' && task.message ? toUserTaskMessage(task.message) : task?.message}
          />
        </section>
      </div>

      <section className="panel-box viral-preview-panel">
        <div className="panel-title">
          <h3>视频预览</h3>
          <span className="viral-preview-hint">下载完成后可在此直接播放</span>
        </div>
        <VideoPreviewSlot
          videoPath={videoPath}
          onError={(message) => onShowToast(message, 'error')}
        />
      </section>
    </div>
  )
}
