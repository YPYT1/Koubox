import { useEffect, useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { type MaterialsSourceMode, type TaskSnapshot } from '@koubox/shared'
import { Button } from '../components/common/Button'
import { FormField, PathPicker } from '../components/common/FormControls'
import { PipelineStatusPanel } from '../components/common/PipelineStatusPanel'
import {
  AudioPreviewSlot,
  startVideoAudioPipeline,
  usePipelineTask,
  VideoSourceFields,
  videoSourceStartIcon
} from '../components/download'

type VideoAudioPageProps = {
  defaultOutputDirectory: string
  openOutputOnComplete: boolean
  onChooseDirectory: (title: string, defaultPath?: string) => Promise<string | undefined>
  onChooseVideoFile: (title: string, defaultPath?: string) => Promise<string | undefined>
  onShowToast: (message: string, type?: 'success' | 'warning' | 'error' | 'info') => void
  onTaskStatus?: (status: TaskSnapshot['status'] | null) => void
}

const STEPS_URL = [
  { stage: 'download', label: '下载视频', desc: '解析链接并拉取视频文件' },
  { stage: 'extract-audio', label: '提取原音频', desc: '保留源采样率与声道，输出高精度 WAV' },
  { stage: 'complete', label: '完成', desc: '音频已写入保存目录' }
]

const STEPS_LOCAL = [
  { stage: 'download', label: '导入视频', desc: '复制本地视频到任务目录' },
  { stage: 'extract-audio', label: '提取原音频', desc: '保留源采样率与声道，输出高精度 WAV' },
  { stage: 'complete', label: '完成', desc: '音频已写入保存目录' }
]

export function VideoAudioPage({
  defaultOutputDirectory,
  openOutputOnComplete,
  onChooseDirectory,
  onChooseVideoFile,
  onShowToast,
  onTaskStatus
}: VideoAudioPageProps) {
  const [sourceMode, setSourceMode] = useState<MaterialsSourceMode>('url')
  const [url, setUrl] = useState('')
  const [videoPath, setVideoPath] = useState('')
  const [outputDirectory, setOutputDirectory] = useState(defaultOutputDirectory)
  const [starting, setStarting] = useState(false)
  const openedTaskIds = useRef(new Set<string>())
  const notifiedRef = useRef<string | null>(null)

  const { task, setTask, cancel, isTaskRunning } = usePipelineTask({
    kind: 'video-audio',
    onStatus: onTaskStatus,
    onError: (message) => onShowToast(message, 'error')
  })

  useEffect(() => {
    if (!outputDirectory && defaultOutputDirectory) setOutputDirectory(defaultOutputDirectory)
  }, [defaultOutputDirectory, outputDirectory])

  useEffect(() => {
    if (!task) return
    if (task.status !== 'complete' && task.status !== 'error') return
    const key = `${task.taskId}:${task.status}:${task.error?.code ?? task.message}`
    if (notifiedRef.current === key) return
    notifiedRef.current = key
    if (task.status === 'complete') onShowToast('音频提取完成。', 'success')
  }, [task, onShowToast])

  useEffect(() => {
    if (!task || task.status !== 'complete' || !openOutputOnComplete) return
    if (openedTaskIds.current.has(task.taskId)) return
    openedTaskIds.current.add(task.taskId)
    void window.koubox.post('/dialog/open-path', { path: task.outputDirectory }).catch((err) => {
      onShowToast(err instanceof Error ? err.message : '无法打开输出目录', 'error')
    })
  }, [task, openOutputOnComplete, onShowToast])

  const activeSourceMode: MaterialsSourceMode =
    task?.sourceMode ?? (task && !/^https?:\/\//i.test(task.url) ? 'local' : sourceMode)
  const pipelineSteps = activeSourceMode === 'local' ? STEPS_LOCAL : STEPS_URL

  const handleStart = async () => {
    setStarting(true)
    try {
      const created = await startVideoAudioPipeline(
        sourceMode === 'local'
          ? { videoPath, outputDirectory }
          : { url, outputDirectory }
      )
      setTask(created)
      onTaskStatus?.(created.status)
      onShowToast(sourceMode === 'local' ? '本地视频任务已启动…' : '音频提取任务已启动…', 'info')
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '任务启动失败', 'error')
    } finally {
      setStarting(false)
    }
  }

  const handleCancel = async () => {
    try {
      await cancel()
      onShowToast('任务已取消', 'info')
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '取消失败', 'error')
    }
  }

  return (
    <div className="page-container viral-page">
      <div className="page-header-block">
        <h1>视频提取音频</h1>
        <p>支持粘贴平台链接下载，或直接上传本地视频，仅抽取原音频为高精度 WAV</p>
      </div>

      <div className="viral-top-grid">
        <section className="panel-box viral-input-panel">
          <div className="panel-title">
            <h3>视频来源</h3>
          </div>

          <VideoSourceFields
            sourceMode={sourceMode}
            onSourceModeChange={setSourceMode}
            url={url}
            onUrlChange={setUrl}
            videoPath={videoPath}
            onVideoPathChange={setVideoPath}
            disabled={isTaskRunning}
            onChooseVideoFile={onChooseVideoFile}
            browseDefaultPath={outputDirectory}
          />

          <FormField label="保存目录">
            <PathPicker
              value={outputDirectory}
              onChange={setOutputDirectory}
              onBrowse={async () => {
                const dir = await onChooseDirectory('选择音频保存目录', outputDirectory)
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
                icon={videoSourceStartIcon(sourceMode)}
              >
                {starting ? '正在启动…' : sourceMode === 'local' ? '开始提取（本地）' : '开始提取'}
              </Button>
            ) : (
              <Button
                variant="danger"
                size="lg"
                style={{ flex: 1 }}
                onClick={() => void handleCancel()}
                icon={<X size={18} weight="bold" />}
              >
                取消任务
              </Button>
            )}
          </div>

          {task && (
            <div className="viral-task-id">
              任务 ID：<code>{task.taskId}</code>
            </div>
          )}
        </section>

        <PipelineStatusPanel task={task} steps={pipelineSteps} />
      </div>

      <section className="panel-box viral-preview-panel">
        <div className="panel-title">
          <h3>音频预览</h3>
        </div>
        <AudioPreviewSlot
          audioPath={task?.artifacts.audio ?? ''}
          onError={(message) => onShowToast(message, 'error')}
        />
      </section>
    </div>
  )
}
