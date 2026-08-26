import { useState, useEffect, useRef } from 'react'
import {
  Subtitles,
  X,
  Export,
  MusicNotes
} from '@phosphor-icons/react'
import { toUserTaskMessage, type TaskEvent, type TaskSnapshot } from '@koubox/shared'
import { ResultPanel } from '../components/ResultPanel'
import { SrtPreview } from '../components/SrtPreview'
import { Button } from '../components/common/Button'
import { FormField, PathPicker } from '../components/common/FormControls'
import { PipelineStepper } from '../components/common/PipelineStepper'
import { Badge } from '../components/common/Badge'

type RequirementTwoPageProps = {
  defaultOutputDirectory: string
  openOutputOnComplete: boolean
  onChooseDirectory: (title: string, defaultPath?: string) => Promise<string | undefined>
  onChooseAudioFile: (title: string, defaultPath?: string) => Promise<string | undefined>
  onShowToast: (message: string, type?: 'success' | 'warning' | 'error' | 'info') => void
  onTaskStatus?: (status: TaskSnapshot['status'] | null) => void
}

export function RequirementTwoPage({
  defaultOutputDirectory,
  openOutputOnComplete,
  onChooseDirectory,
  onChooseAudioFile,
  onShowToast,
  onTaskStatus
}: RequirementTwoPageProps) {
  const [audioPath, setAudioPath] = useState('')
  const [sourceText, setSourceText] = useState('')
  const [outputDirectory, setOutputDirectory] = useState(defaultOutputDirectory)
  const [task, setTask] = useState<TaskSnapshot | null>(null)
  const [starting, setStarting] = useState(false)
  const openedTaskIds = useRef(new Set<string>())
  const onTaskStatusRef = useRef(onTaskStatus)
  onTaskStatusRef.current = onTaskStatus

  useEffect(() => {
    if (!outputDirectory && defaultOutputDirectory) {
      setOutputDirectory(defaultOutputDirectory)
    }
  }, [defaultOutputDirectory, outputDirectory])

  const taskId = task?.taskId
  useEffect(() => {
    let closed = false
    void window.koubox
      .get<TaskSnapshot[]>('/tasks')
      .then((all) => {
        if (closed) return
        const active = all
          .filter((item) => item.kind === 'req2' && (item.status === 'queued' || item.status === 'running'))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]
        if (!active) return
        setTask((current) => current ?? active)
      })
      .catch((err) => {
        onShowToast(err instanceof Error ? err.message : '无法读取进行中的任务', 'error')
      })
    return () => {
      closed = true
    }
  }, [])

  useEffect(() => {
    if (!taskId) return
    return window.koubox.events<TaskEvent>(`/tasks/${encodeURIComponent(taskId)}/events`, (event) => {
      setTask(event.task)
      onTaskStatusRef.current?.(event.task.status)
    })
  }, [taskId])

  useEffect(() => {
    if (!task || task.status !== 'complete' || !openOutputOnComplete) return
    if (openedTaskIds.current.has(task.taskId)) return
    openedTaskIds.current.add(task.taskId)
    void window.koubox.post('/dialog/open-path', { path: task.outputDirectory }).catch((err) => {
      onShowToast(err instanceof Error ? err.message : '无法打开输出目录', 'error')
    })
  }, [task, openOutputOnComplete, onShowToast])

  const hasSourceText = Boolean(sourceText.trim())
  const steps = [
    { stage: 'extract-audio', label: '提取原音频', desc: '保留源采样率与声道，生成高精度 WAV 工作副本' },
    { stage: 'asr', label: 'Faster-Whisper 语音识别', desc: 'Large-v3 直接识别原音频并生成时间锚点' },
    ...(hasSourceText ? [{ stage: 'align', label: '贴合原文案', desc: '将时间戳精准映射并贴合至已知文案' }] : []),
    { stage: 'export-srt', label: '生成剪映标准 SRT', desc: '规范化断句与毫秒级时间轴封装' }
  ]

  const handleStart = async () => {
    if (!audioPath.trim()) {
      return onShowToast('请选择本地音频或视频文件', 'warning')
    }
    if (!outputDirectory.trim()) {
      return onShowToast('请选择输出保存目录', 'warning')
    }

    setStarting(true)
    try {
      const created = await window.koubox.post<TaskSnapshot>('/pipelines/req2', {
        audioPath: audioPath.trim(),
        sourceText: sourceText.trim(),
        outputDirectory: outputDirectory.trim()
      })
      setTask(created)
      onTaskStatus?.(created.status)
      onShowToast('SRT 生成流水线已启动…', 'info')
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '任务启动失败', 'error')
    } finally {
      setStarting(false)
    }
  }

  const handleCancel = async () => {
    if (!task) return
    try {
      const cancelled = await window.koubox.post<TaskSnapshot>(
        `/tasks/${encodeURIComponent(task.taskId)}/cancel`
      )
      setTask(cancelled)
      onTaskStatus?.(cancelled.status)
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
      onShowToast('SRT 与字幕文件已另存到目标目录', 'success')
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '另存失败', 'error')
    }
  }

  const handleCopy = (text: string) => {
    void navigator.clipboard.writeText(text)
  }

  const transcriptText = task?.transcript?.segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join('\n')

  const isTaskRunning = Boolean(task && !['complete', 'error', 'cancelled'].includes(task.status))

  return (
    <div className="page-container">
      {/* 页面顶栏 */}
      <div className="page-header-block">
        <div>
          <h1>精准 SRT 对齐（待完成）</h1>
          <p>（功能暂未实现）导入录音与口播文案，利用 GPU 毫秒级对齐时间轴，一键生成剪映直接导入的专业字幕</p>
        </div>
      </div>

      {/* 左右分栏工作视区 */}
      <div className="workspace-split-layout">
        {/* 左侧表单与输入 */}
        <div className="panel-box">
          <div className="panel-title">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h3>音频与文案输入</h3>
              <Badge variant="blue">
                {hasSourceText ? '模式：已知文案对齐' : '模式：纯音频转字幕'}
              </Badge>
            </div>
          </div>

          <FormField
            label="本地音频或视频文件"
            hint="支持 WAV, MP3, M4A, AAC, FLAC 或 MP4 视频文件提取"
          >
            <PathPicker
              value={audioPath}
              onChange={setAudioPath}
              onBrowse={async () => {
                const picked = await onChooseAudioFile('选择音频文件', audioPath)
                if (picked) setAudioPath(picked)
              }}
              placeholder="选择本地音频或视频文件…"
              buttonLabel="选择文件"
              buttonIcon={<MusicNotes size={16} />}
              disabled={isTaskRunning}
            />
          </FormField>

          <FormField
            label="口播原文稿"
            optional="可选"
            hint="填写后文字 100% 严格以原稿为准，时间轴由音频精准对齐；留空则由 Faster-Whisper Large-v3 纯语音识别转写。"
          >
            <textarea
              className="textarea-box"
              rows={6}
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              placeholder="在此粘贴录音对应的口播台词或文案原稿…"
              disabled={isTaskRunning}
            />
          </FormField>

          <FormField
            label="SRT 输出保存目录"
            hint="生成的标准 .srt 字幕文件将保存到此位置，可直接拖入剪映或 Premiere。"
          >
            <PathPicker
              value={outputDirectory}
              onChange={setOutputDirectory}
              onBrowse={async () => {
                const dir = await onChooseDirectory('选择保存目录', outputDirectory)
                if (dir) setOutputDirectory(dir)
              }}
              disabled={isTaskRunning}
            />
          </FormField>

          <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
            {!isTaskRunning ? (
              <Button
                variant="primary-blue"
                size="lg"
                style={{ flex: 1 }}
                onClick={handleStart}
                loading={starting}
                icon={<Subtitles size={18} weight="bold" />}
              >
                {starting ? '正在启动…' : '开始对齐并生成 SRT'}
              </Button>
            ) : (
              <Button
                variant="danger"
                size="lg"
                style={{ flex: 1 }}
                onClick={handleCancel}
                icon={<X size={18} weight="bold" />}
              >
                取消当前任务
              </Button>
            )}
          </div>
        </div>

        {/* 右侧流水线 Stepper 面板 */}
        <div className="panel-box">
          <div className="panel-title">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h3>流水线对齐进度</h3>
              {task && (
                <Badge
                  variant={
                    task.status === 'complete'
                      ? 'success'
                      : task.status === 'error'
                      ? 'danger'
                      : 'blue'
                  }
                  pulse={isTaskRunning}
                >
                  {task.status === 'complete'
                    ? '对齐完成'
                    : task.status === 'error'
                    ? '执行中断'
                    : task.status === 'cancelled'
                    ? '已取消'
                    : '正在对齐'}
                </Badge>
              )}
            </div>
            {task && <span className="task-percent-tag tag-blue">{task.percent}%</span>}
          </div>

          <PipelineStepper
            steps={steps}
            currentStage={task?.stage}
            status={task?.status}
            percent={task?.percent}
            message={task?.status === 'error' && task.message ? toUserTaskMessage(task.message) : task?.message}
            accentColor="var(--accent-blue)"
          />

          {task?.message && (
            <div className="pipeline-msg-box">
              <Subtitles size={18} color="var(--accent-blue)" />
              <span>{task.status === 'error' ? toUserTaskMessage(task.message) : task.message}</span>
            </div>
          )}
        </div>
      </div>

      {/* 成果交付区：SRT 专业预览与文本面板 */}
      {task?.transcript && transcriptText && (
        <div className="results-stack">
          {/* SRT 可视化预览面板 */}
          <SrtPreview
            transcript={task.transcript}
            audioPath={task.artifacts?.audio}
            onExport={handleExportFiles}
            onCopy={() => onShowToast('SRT 内容已复制到剪贴板', 'success')}
          />

          {/* 原始文本面板（可选展开查看） */}
          <ResultPanel
            title={hasSourceText ? '精准对齐文案 (带毫秒时间戳)' : 'Faster-Whisper 语音识别字幕'}
            transcript={task.transcript}
            rawText={transcriptText}
            onCopy={handleCopy}
            action={handleExportFiles}
            actionLabel="另存为剪映 SRT 文件"
            actionIcon="download"
          />
        </div>
      )}

      {task && task.status === 'complete' && (
        <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <Button
            variant="secondary"
            size="md"
            onClick={handleExportFiles}
            icon={<Export size={16} />}
          >
            导出 SRT 与中间产物
          </Button>
        </div>
      )}
    </div>
  )
}
