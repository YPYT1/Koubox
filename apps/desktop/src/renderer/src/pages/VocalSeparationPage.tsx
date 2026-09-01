import { useEffect, useRef, useState } from 'react'
import { Microphone, X } from '@phosphor-icons/react'
import { type TaskSnapshot } from '@koubox/shared'
import { Button } from '../components/common/Button'
import { FormField, PathPicker } from '../components/common/FormControls'
import { PipelineStatusPanel } from '../components/common/PipelineStatusPanel'
import {
  LocalAudioField,
  startVocalSeparationPipeline,
  usePipelineTask,
  ViralAudioPlayer
} from '../components/download'

type VocalSeparationPageProps = {
  defaultOutputDirectory: string
  openOutputOnComplete: boolean
  onChooseDirectory: (title: string, defaultPath?: string) => Promise<string | undefined>
  onChooseAudioFile: (title: string, defaultPath?: string) => Promise<string | undefined>
  onShowToast: (message: string, type?: 'success' | 'warning' | 'error' | 'info') => void
  onTaskStatus?: (status: TaskSnapshot['status'] | null) => void
}

const STEPS = [
  { stage: 'download', label: '导入音频', desc: '读取本地音频文件（不写入保存目录）' },
  { stage: 'extract-audio', label: '转换音频', desc: '临时生成 Demucs 可处理的高精度 WAV' },
  { stage: 'separate-vocals', label: '去除背景音乐', desc: '对完整背景音乐素材分离效果更好' },
  { stage: 'complete', label: '完成', desc: '人声文件已写入保存目录' }
]

export function VocalSeparationPage({
  defaultOutputDirectory,
  openOutputOnComplete,
  onChooseDirectory,
  onChooseAudioFile,
  onShowToast,
  onTaskStatus
}: VocalSeparationPageProps) {
  const [audioPath, setAudioPath] = useState('')
  const [outputDirectory, setOutputDirectory] = useState(defaultOutputDirectory)
  const [starting, setStarting] = useState(false)
  const openedTaskIds = useRef(new Set<string>())
  const notifiedRef = useRef<string | null>(null)

  const { task, setTask, cancel, isTaskRunning } = usePipelineTask({
    kind: 'vocal-separation',
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
    if (task.status === 'complete') onShowToast('去除背景音乐完成。', 'success')
  }, [task, onShowToast])

  useEffect(() => {
    if (!task || task.status !== 'complete' || !openOutputOnComplete) return
    if (openedTaskIds.current.has(task.taskId)) return
    openedTaskIds.current.add(task.taskId)
    void window.koubox.post('/dialog/open-path', { path: task.outputDirectory }).catch((err) => {
      onShowToast(err instanceof Error ? err.message : '无法打开输出目录', 'error')
    })
  }, [task, openOutputOnComplete, onShowToast])

  const handleStart = async () => {
    if (!audioPath.trim()) return onShowToast('请选择本地音频文件', 'warning')
    setStarting(true)
    try {
      const created = await startVocalSeparationPipeline(audioPath, outputDirectory)
      setTask(created)
      onTaskStatus?.(created.status)
      onShowToast('去除背景音乐任务已启动…', 'info')
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

  const originalPreviewPath = audioPath.trim() || task?.url || ''
  const vocalsPreviewPath = task?.artifacts.vocals ?? ''

  return (
    <div className="page-container viral-page">
      <div className="page-header-block">
        <h1>去除背景音乐</h1>
        <p>上传本地音频，用 Demucs 去除背景音乐并保留人声；对带有完整背景音乐的素材效果较好</p>
      </div>

      <div className="viral-top-grid">
        <section className="panel-box viral-input-panel">
          <div className="panel-title">
            <h3>音频来源</h3>
          </div>

          <LocalAudioField
            value={audioPath}
            onChange={setAudioPath}
            disabled={isTaskRunning}
            onChooseAudioFile={onChooseAudioFile}
            browseDefaultPath={outputDirectory}
          />

          <FormField label="保存目录">
            <PathPicker
              value={outputDirectory}
              onChange={setOutputDirectory}
              onBrowse={async () => {
                const dir = await onChooseDirectory('选择人声保存目录', outputDirectory)
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
                icon={<Microphone size={18} weight="bold" />}
              >
                {starting ? '正在启动…' : '开始分离'}
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

        <PipelineStatusPanel task={task} steps={STEPS} />
      </div>

      <section className="panel-box viral-preview-panel">
        <div className="panel-title">
          <h3>音频预览</h3>
        </div>
        <div className="vocal-preview-stack">
          <div className="viral-audio-slot speech-audio-slot">
            <div className="viral-slot-label">
              <span>原始音频</span>
            </div>
            <ViralAudioPlayer
              audioPath={originalPreviewPath}
              emptyHint="选择音频后可在此试听"
              onError={(message) => onShowToast(message, 'error')}
            />
          </div>
          <div className="viral-audio-slot speech-audio-slot">
            <div className="viral-slot-label">
              <span>人声音频</span>
            </div>
            <ViralAudioPlayer
              audioPath={vocalsPreviewPath}
              emptyHint="分离完成后可在此试听人声"
              onError={(message) => onShowToast(message, 'error')}
            />
          </div>
        </div>
      </section>
    </div>
  )
}
