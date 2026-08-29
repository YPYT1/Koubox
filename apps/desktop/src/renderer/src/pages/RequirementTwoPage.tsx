import { useEffect, useRef, useState } from 'react'
import {
  ArrowsIn,
  ArrowsOut,
  Check,
  Copy,
  Subtitles,
  X
} from '@phosphor-icons/react'
import { type TaskSnapshot } from '@koubox/shared'
import { Button } from '../components/common/Button'
import { FormField, PathPicker } from '../components/common/FormControls'
import { PipelineStatusPanel } from '../components/common/PipelineStatusPanel'
import {
  AudioPreviewSlot,
  LocalSpeechMediaField,
  usePipelineTask
} from '../components/download'

type RequirementTwoPageProps = {
  defaultOutputDirectory: string
  openOutputOnComplete: boolean
  onChooseDirectory: (title: string, defaultPath?: string) => Promise<string | undefined>
  onChooseMediaFile: (title: string, defaultPath?: string) => Promise<string | undefined>
  onShowToast: (message: string, type?: 'success' | 'warning' | 'error' | 'info') => void
  onTaskStatus?: (status: TaskSnapshot['status'] | null) => void
}

type SrtInputMode = 'with-script' | 'asr-only'

const STEPS_WITH_SCRIPT = [
  { stage: 'extract-audio', label: '转换音频', desc: '临时生成高精度 WAV 供识别使用' },
  { stage: 'asr', label: '语音识别', desc: 'Faster-Whisper Large-v3 生成时间锚点' },
  { stage: 'align', label: '贴合原文', desc: '将时间轴精准映射至已知口播文案' },
  { stage: 'export-srt', label: '导出 SRT', desc: '生成剪映可直接导入的字幕文件' }
]

const STEPS_ASR_ONLY = [
  { stage: 'extract-audio', label: '转换音频', desc: '临时生成高精度 WAV 供识别使用' },
  { stage: 'asr', label: '语音识别', desc: 'Faster-Whisper Large-v3 识别并断句' },
  { stage: 'export-srt', label: '导出 SRT', desc: '生成剪映可直接导入的字幕文件' }
]

function formatSegmentTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 1000)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`
}

export function RequirementTwoPage({
  defaultOutputDirectory,
  openOutputOnComplete,
  onChooseDirectory,
  onChooseMediaFile,
  onShowToast,
  onTaskStatus
}: RequirementTwoPageProps) {
  const [inputMode, setInputMode] = useState<SrtInputMode>('with-script')
  const [mediaPath, setMediaPath] = useState('')
  const [sourceText, setSourceText] = useState('')
  const [outputDirectory, setOutputDirectory] = useState(defaultOutputDirectory)
  const [starting, setStarting] = useState(false)
  const [srtExpanded, setSrtExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const openedTaskIds = useRef(new Set<string>())
  const notifiedRef = useRef<string | null>(null)

  const { task, setTask, cancel, isTaskRunning } = usePipelineTask({
    kind: 'req2',
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
    if (task.status === 'complete') onShowToast('SRT 已生成。', 'success')
  }, [task, onShowToast])

  useEffect(() => {
    if (!task || task.status !== 'complete' || !openOutputOnComplete) return
    if (openedTaskIds.current.has(task.taskId)) return
    openedTaskIds.current.add(task.taskId)
    void window.koubox.post('/dialog/open-path', { path: task.outputDirectory }).catch((err) => {
      onShowToast(err instanceof Error ? err.message : '无法打开输出目录', 'error')
    })
  }, [task, openOutputOnComplete, onShowToast])

  const activeMode: SrtInputMode =
    task?.mode === 'align' ? 'with-script' : task?.mode === 'asr-only' ? 'asr-only' : inputMode
  const pipelineSteps = activeMode === 'with-script' ? STEPS_WITH_SCRIPT : STEPS_ASR_ONLY
  const previewAudioPath =
    task?.artifacts.audio ?? (mediaPath.trim() || task?.url || '')
  const segments = task?.transcript?.segments ?? []

  const handleStart = async () => {
    if (!mediaPath.trim()) return onShowToast('请选择本地音频或视频文件', 'warning')
    if (!outputDirectory.trim()) return onShowToast('请选择输出保存目录', 'warning')
    if (inputMode === 'with-script' && !sourceText.trim()) {
      return onShowToast('有文案模式下请填写口播原文稿', 'warning')
    }

    setStarting(true)
    try {
      const created = await window.koubox.post<TaskSnapshot>('/pipelines/req2', {
        audioPath: mediaPath.trim(),
        sourceText: inputMode === 'with-script' ? sourceText.trim() : '',
        outputDirectory: outputDirectory.trim()
      })
      setTask(created)
      onTaskStatus?.(created.status)
      onShowToast('SRT 生成任务已启动…', 'info')
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

  const handleExportFiles = async () => {
    if (!task) return
    const targetDir = await onChooseDirectory('选择另存 SRT 文件的目录', outputDirectory)
    if (!targetDir) return
    try {
      await window.koubox.post(`/tasks/${encodeURIComponent(task.taskId)}/export`, {
        targetDirectory: targetDir
      })
      onShowToast('SRT 文件已另存到目标目录', 'success')
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '另存失败', 'error')
    }
  }

  const handleCopySrt = async () => {
    if (!task?.transcript?.segments.length) return
    const content = task.transcript.segments
      .filter((seg) => seg.text.trim() && seg.end >= seg.start)
      .map((seg, idx) => {
        const formatTime = (seconds: number) => {
          const h = Math.floor(seconds / 3600)
          const m = Math.floor((seconds % 3600) / 60)
          const s = Math.floor(seconds % 60)
          const ms = Math.floor((seconds % 1) * 1000)
          return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
        }
        return `${idx + 1}\n${formatTime(seg.start)} --> ${formatTime(seg.end)}\n${seg.text.trim()}`
      })
      .join('\n\n')
    await navigator.clipboard.writeText(content)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 900)
    onShowToast('SRT 内容已复制', 'success')
  }

  return (
    <div className="page-container viral-page srt-page">
      <div className="page-header-block">
        <h1>精准 SRT 对齐</h1>
        <p>导入录音与口播文案，或纯音频识别，生成可直接导入剪映的标准 SRT 字幕</p>
      </div>

      <div className="viral-top-grid">
        <section className="panel-box viral-input-panel">
          <div className="panel-title">
            <h3>素材输入</h3>
          </div>

          <div className="viral-source-mode srt-source-mode" role="tablist" aria-label="输入模式">
            <button
              type="button"
              role="tab"
              aria-selected={inputMode === 'with-script'}
              className={`viral-source-mode-btn ${inputMode === 'with-script' ? 'is-active' : ''}`}
              disabled={isTaskRunning}
              onClick={() => setInputMode('with-script')}
            >
              有文案对齐
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={inputMode === 'asr-only'}
              className={`viral-source-mode-btn ${inputMode === 'asr-only' ? 'is-active' : ''}`}
              disabled={isTaskRunning}
              onClick={() => setInputMode('asr-only')}
            >
              无文案识别
            </button>
          </div>

          <LocalSpeechMediaField
            value={mediaPath}
            onChange={setMediaPath}
            disabled={isTaskRunning}
            onChooseMediaFile={onChooseMediaFile}
            browseDefaultPath={outputDirectory}
          />

          {inputMode === 'with-script' ? (
            <FormField
              label="口播原文稿（文案）"
              hint="文字 100% 以原稿为准，时间轴由音频精准对齐"
            >
              <textarea
                className="textarea-box srt-script-textarea"
                rows={8}
                value={sourceText}
                onChange={(e) => setSourceText(e.target.value)}
                placeholder="在此粘贴录音对应的口播台词或文案原稿…"
                disabled={isTaskRunning}
              />
            </FormField>
          ) : null}

          <FormField label="SRT 保存目录">
            <PathPicker
              value={outputDirectory}
              onChange={setOutputDirectory}
              onBrowse={async () => {
                const dir = await onChooseDirectory('选择 SRT 保存目录', outputDirectory)
                if (dir) setOutputDirectory(dir)
              }}
              disabled={isTaskRunning}
            />
          </FormField>

          <div className="viral-actions">
            {!isTaskRunning ? (
              <Button
                variant="primary-blue"
                size="lg"
                style={{ flex: 1 }}
                onClick={() => void handleStart()}
                loading={starting}
                icon={<Subtitles size={18} weight="bold" />}
              >
                {starting
                  ? '正在启动…'
                  : inputMode === 'with-script'
                    ? '开始对齐并生成 SRT'
                    : '开始识别并生成 SRT'}
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

        <PipelineStatusPanel task={task} steps={pipelineSteps} title="执行状态" />
      </div>

      <section className="panel-box viral-preview-panel">
        <div className="panel-title">
          <h3>结果预览</h3>
          <span className="viral-preview-hint">上方试听音频，下方按句查看字幕与时间轴</span>
        </div>

        <div className="speech-audio-row">
          <div className="viral-audio-slot speech-audio-slot">
            <AudioPreviewSlot
              audioPath={previewAudioPath}
              onError={(message) => onShowToast(message, 'error')}
            />
          </div>
        </div>

        <div className={`viral-text-card speech-text-card srt-text-card ${srtExpanded ? 'speech-text-expanded' : ''}`}>
          <div className="viral-text-head">
            <h4>
              SRT 字幕
              {task?.transcript?.language ? (
                <span className="panel-title-badge">{task.transcript.language}</span>
              ) : null}
            </h4>
            <div className="viral-text-actions">
              <button
                type="button"
                className="btn-secondary"
                style={{ height: 32 }}
                onClick={() => setSrtExpanded((value) => !value)}
              >
                {srtExpanded ? <ArrowsIn size={14} /> : <ArrowsOut size={14} />}
                {srtExpanded ? '收起' : '展开'}
              </button>
              <button
                type="button"
                className={`btn-secondary ${copied ? 'btn-copy-done' : ''}`}
                style={{ height: 32 }}
                disabled={!segments.length}
                onClick={() => void handleCopySrt()}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? '已复制' : '复制 SRT'}
              </button>
              <button
                type="button"
                className="btn-primary"
                style={{ height: 32, padding: '0 14px', fontSize: 12 }}
                disabled={!task?.artifacts.srt}
                onClick={() => void handleExportFiles()}
              >
                另存 SRT
              </button>
            </div>
          </div>

          {segments.length > 0 ? (
            <div className="segments-table srt-segments-table">
              {segments.map((seg, idx) => (
                <div className="segment-row" key={`${seg.start}-${idx}`}>
                  <span className="segment-index">#{idx + 1}</span>
                  <span className="segment-time">
                    {formatSegmentTime(seg.start)} → {formatSegmentTime(seg.end)}
                  </span>
                  <span className="segment-text">{seg.text}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="viral-line-list speech-text-empty">
              <div className="viral-slot-empty">
                {isTaskRunning
                  ? '正在生成字幕，完成后按句展示时间轴'
                  : '任务完成后，分句字幕与时间轴将显示在此'}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
