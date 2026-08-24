import { useState, useEffect, useRef } from 'react'
import {
  DownloadSimple,
  X,
  Copy,
  FilmStrip,
  Waveform,
  Play,
  ArrowRight,
  ArrowsOut,
  ArrowsIn
} from '@phosphor-icons/react'
import { toUserTaskMessage, type TaskEvent, type TaskSnapshot, type TranslationTargetLanguage } from '@koubox/shared'
import { Button } from '../components/common/Button'
import { FormField, PathPicker } from '../components/common/FormControls'
import { PipelineStepper } from '../components/common/PipelineStepper'
import { Badge } from '../components/common/Badge'
import { TARGET_LANGUAGE_OPTIONS } from './SettingsPage'

type RequirementOnePageProps = {
  defaultOutputDirectory: string
  translationTargetLanguage: TranslationTargetLanguage
  openOutputOnComplete: boolean
  onChooseDirectory: (title: string, defaultPath?: string) => Promise<string | undefined>
  onShowToast: (message: string, type?: 'success' | 'warning' | 'error' | 'info') => void
  onTaskStatus?: (status: TaskSnapshot['status'] | null) => void
}

const STEPS = [
  { stage: 'download', label: '下载视频', desc: '解析链接并拉取视频文件' },
  { stage: 'extract-audio', label: '提取原音频', desc: '保留含背景音乐的完整音轨' },
  { stage: 'separate-vocals', label: '分离人声', desc: 'Demucs 去除背景音乐，保留人声' },
  { stage: 'asr', label: '语音识别', desc: '本地 Whisper 断句与时间轴' },
  { stage: 'translation', label: '翻译', desc: '按目标语种生成译文' }
]

export function RequirementOnePage({
  defaultOutputDirectory,
  translationTargetLanguage,
  openOutputOnComplete,
  onChooseDirectory,
  onShowToast,
  onTaskStatus
}: RequirementOnePageProps) {
  const [url, setUrl] = useState('')
  const [outputDirectory, setOutputDirectory] = useState(defaultOutputDirectory)
  const [targetLanguage, setTargetLanguage] = useState<TranslationTargetLanguage>(translationTargetLanguage)
  const [task, setTask] = useState<TaskSnapshot | null>(null)
  const [starting, setStarting] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [textExpanded, setTextExpanded] = useState(false)
  const [videoPlaying, setVideoPlaying] = useState(false)
  const [audioPlaying, setAudioPlaying] = useState(false)
  const [vocalsPlaying, setVocalsPlaying] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const vocalsRef = useRef<HTMLAudioElement>(null)
  const originalListRef = useRef<HTMLDivElement>(null)
  const translatedListRef = useRef<HTMLDivElement>(null)
  const scrollSyncLock = useRef(false)
  const openedTaskIds = useRef(new Set<string>())
  const shownErrorRef = useRef<string | null>(null)
  const onTaskStatusRef = useRef(onTaskStatus)
  onTaskStatusRef.current = onTaskStatus

  useEffect(() => {
    if (!outputDirectory && defaultOutputDirectory) setOutputDirectory(defaultOutputDirectory)
  }, [defaultOutputDirectory, outputDirectory])

  useEffect(() => {
    setTargetLanguage(translationTargetLanguage)
  }, [translationTargetLanguage])

  const taskId = task?.taskId
  useEffect(() => {
    let closed = false
    void window.koubox
      .get<TaskSnapshot[]>('/tasks')
      .then((all) => {
        if (closed) return
        const active = all
          .filter((item) => item.kind === 'req1' && (item.status === 'queued' || item.status === 'running'))
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
    if (!task || task.status !== 'error') return
    const key = `${task.taskId}:${task.error?.code ?? task.message}`
    if (shownErrorRef.current === key) return
    shownErrorRef.current = key
    onShowToast(toUserTaskMessage(task.message || task.error?.message || '任务失败'), 'error')
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
    if (!/^https?:\/\//i.test(url.trim())) {
      return onShowToast('请输入合法的视频链接（如 YouTube / TikTok / Instagram 等）', 'warning')
    }
    if (!outputDirectory.trim()) {
      return onShowToast('请选择输出保存目录', 'warning')
    }

    setStarting(true)
    try {
      const createdTask = await window.koubox.post<TaskSnapshot>('/pipelines/req1', {
        url: url.trim(),
        outputDirectory: outputDirectory.trim()
      })
      setTask(createdTask)
      onTaskStatus?.(createdTask.status)
      onShowToast('任务已启动…', 'info')
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '任务启动失败', 'error')
    } finally {
      setStarting(false)
    }
  }

  const handleTranslate = async () => {
    if (!task) return
    setTranslating(true)
    try {
      const updated = await window.koubox.post<TaskSnapshot>(
        `/tasks/${encodeURIComponent(task.taskId)}/translate`,
        { targetLanguage }
      )
      setTask(updated)
      onTaskStatus?.(updated.status)
      onShowToast('翻译完成', 'success')
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '翻译失败', 'error')
    } finally {
      setTranslating(false)
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

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text)
    onShowToast('已复制到剪贴板', 'success')
  }

  const playVideo = async () => {
    const el = videoRef.current
    if (!el) return
    try {
      await el.play()
      setVideoPlaying(true)
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '视频无法播放', 'error')
    }
  }

  const playAudio = async () => {
    const el = audioRef.current
    if (!el) return
    try {
      vocalsRef.current?.pause()
      setVocalsPlaying(false)
      await el.play()
      setAudioPlaying(true)
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '音频无法播放', 'error')
    }
  }

  const playVocals = async () => {
    const el = vocalsRef.current
    if (!el) return
    try {
      audioRef.current?.pause()
      setAudioPlaying(false)
      await el.play()
      setVocalsPlaying(true)
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '人声音频无法播放', 'error')
    }
  }

  const syncScrollFromOriginal = () => {
    const source = originalListRef.current
    const target = translatedListRef.current
    if (!source || !target || scrollSyncLock.current) return
    scrollSyncLock.current = true
    target.scrollTop = source.scrollTop
    requestAnimationFrame(() => {
      scrollSyncLock.current = false
    })
  }

  const syncScrollFromTranslated = () => {
    const source = translatedListRef.current
    const target = originalListRef.current
    if (!source || !target || scrollSyncLock.current) return
    scrollSyncLock.current = true
    target.scrollTop = source.scrollTop
    requestAnimationFrame(() => {
      scrollSyncLock.current = false
    })
  }

  const originalLines = task?.transcript?.segments.map((s) => s.text.trim()).filter(Boolean) ?? []
  const translatedLines = (task?.translation ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const lineCount = Math.max(originalLines.length, translatedLines.length, 1)
  const isTaskRunning = Boolean(task && !['complete', 'error', 'cancelled'].includes(task.status))
  const videoSrc = task?.artifacts.video ? window.koubox.mediaUrl(task.artifacts.video) : ''
  const audioSrc = task?.artifacts.audio ? window.koubox.mediaUrl(task.artifacts.audio) : ''
  const vocalsSrc = task?.artifacts.vocals ? window.koubox.mediaUrl(task.artifacts.vocals) : ''

  return (
    <div className="page-container viral-page">
      <div className="page-header-block">
        <h1>爆款素材获取</h1>
      </div>

      <div className="viral-top-grid">
        <section className="panel-box viral-input-panel">
          <div className="panel-title">
            <h3>视频链接</h3>
          </div>

          <FormField label="短视频 URL" hint="支持YouTube TikTok Instagram Facebook">
            <input
              className="input-text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              disabled={isTaskRunning}
            />
          </FormField>

          <FormField label="保存目录">
            <PathPicker
              value={outputDirectory}
              onChange={setOutputDirectory}
              onBrowse={async () => {
                const dir = await onChooseDirectory('选择素材保存目录', outputDirectory)
                if (dir) setOutputDirectory(dir)
              }}
              disabled={isTaskRunning}
            />
          </FormField>

          <FormField label="翻译目标语言">
            <select
              className="input-text"
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value as TranslationTargetLanguage)}
              disabled={isTaskRunning || translating}
            >
              {TARGET_LANGUAGE_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </FormField>

          <div className="viral-actions">
            {!isTaskRunning ? (
              <Button
                variant="primary"
                size="lg"
                style={{ flex: 1 }}
                onClick={handleStart}
                loading={starting}
                icon={<DownloadSimple size={18} weight="bold" />}
              >
                {starting ? '正在启动…' : '开始提取'}
              </Button>
            ) : (
              <Button
                variant="danger"
                size="lg"
                style={{ flex: 1 }}
                onClick={handleCancel}
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

        <section className="panel-box viral-status-panel">
          <div className="panel-title">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h3>执行状态</h3>
              {task && (
                <Badge
                  variant={
                    task.status === 'complete'
                      ? 'success'
                      : task.status === 'error'
                        ? 'danger'
                        : 'teal'
                  }
                  pulse={isTaskRunning}
                >
                  {task.status === 'complete'
                    ? '完成'
                    : task.status === 'error'
                      ? '失败'
                      : task.status === 'cancelled'
                        ? '已取消'
                        : '进行中'}
                </Badge>
              )}
            </div>
            {task && (
              <span className={`task-percent-tag ${isTaskRunning ? 'pulsing' : ''}`}>{task.percent}%</span>
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

      <div className="viral-media-grid">
        <section className="panel-box viral-media-card viral-media-video">
          <div className="panel-title">
            <h3><FilmStrip size={16} /> 下载好的视频</h3>
          </div>
          {videoSrc ? (
            <div className="viral-media-frame">
              <video
                ref={videoRef}
                className="viral-media-player"
                controls
                preload="metadata"
                src={videoSrc}
                onPlay={() => setVideoPlaying(true)}
                onPause={() => setVideoPlaying(false)}
                onEnded={() => setVideoPlaying(false)}
              />
              {!videoPlaying && (
                <button type="button" className="viral-media-play" onClick={() => void playVideo()} aria-label="播放视频">
                  <Play size={28} weight="fill" />
                </button>
              )}
            </div>
          ) : (
            <div className="viral-media-empty">下载完成后可在此预览播放</div>
          )}
        </section>
        <section className="panel-box viral-media-card">
          <div className="panel-title">
            <h3><Waveform size={16} /> 原音频（含 BGM）</h3>
          </div>
          {audioSrc ? (
            <div className="viral-audio-frame">
              <button
                type="button"
                className={`viral-audio-play-btn ${audioPlaying ? 'playing' : ''}`}
                onClick={() => {
                  if (audioPlaying) {
                    audioRef.current?.pause()
                    setAudioPlaying(false)
                  } else {
                    void playAudio()
                  }
                }}
                aria-label={audioPlaying ? '暂停原音频' : '播放原音频'}
              >
                <Play size={22} weight="fill" />
              </button>
              <audio
                ref={audioRef}
                className="viral-audio-player"
                controls
                preload="metadata"
                src={audioSrc}
                onPlay={() => setAudioPlaying(true)}
                onPause={() => setAudioPlaying(false)}
                onEnded={() => setAudioPlaying(false)}
              />
            </div>
          ) : (
            <div className="viral-media-empty">抽音完成后可在此试听原音</div>
          )}
        </section>
        <section className="panel-box viral-media-card">
          <div className="panel-title">
            <h3><Waveform size={16} /> 人声（去背景音乐）</h3>
          </div>
          {vocalsSrc ? (
            <div className="viral-audio-frame">
              <button
                type="button"
                className={`viral-audio-play-btn ${vocalsPlaying ? 'playing' : ''}`}
                onClick={() => {
                  if (vocalsPlaying) {
                    vocalsRef.current?.pause()
                    setVocalsPlaying(false)
                  } else {
                    void playVocals()
                  }
                }}
                aria-label={vocalsPlaying ? '暂停人声' : '播放人声'}
              >
                <Play size={22} weight="fill" />
              </button>
              <audio
                ref={vocalsRef}
                className="viral-audio-player"
                controls
                preload="metadata"
                src={vocalsSrc}
                onPlay={() => setVocalsPlaying(true)}
                onPause={() => setVocalsPlaying(false)}
                onEnded={() => setVocalsPlaying(false)}
              />
            </div>
          ) : (
            <div className="viral-media-empty">人声分离完成后可在此对比试听</div>
          )}
        </section>
      </div>

      <div className={`viral-text-grid ${textExpanded ? 'expanded' : ''}`}>
        <section className="panel-box viral-text-card">
          <div className="panel-title">
            <h3>原始文案</h3>
            <div className="viral-text-actions">
              <button
                type="button"
                className="btn-secondary"
                style={{ height: 32 }}
                onClick={() => setTextExpanded((value) => !value)}
              >
                {textExpanded ? <ArrowsIn size={14} /> : <ArrowsOut size={14} />}
                {textExpanded ? '收起' : '展开'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                style={{ height: 32 }}
                disabled={originalLines.length === 0}
                onClick={() => void handleCopy(originalLines.join('\n'))}
              >
                <Copy size={14} /> 复制
              </button>
            </div>
          </div>
          <div
            className="viral-line-list"
            ref={originalListRef}
            onScroll={syncScrollFromOriginal}
          >
            {originalLines.length === 0 ? (
              <div className="viral-media-empty">识别完成后按「一行一句」展示</div>
            ) : (
              originalLines.map((line, index) => (
                <div className="viral-line-row" key={`o-${index}`}>
                  <span className="viral-line-index">{index + 1}</span>
                  <span className="viral-line-text">{line}</span>
                </div>
              ))
            )}
          </div>
        </section>

        <div className="viral-translate-bridge">
          <button
            type="button"
            className="viral-translate-arrow"
            onClick={handleTranslate}
            disabled={!task?.transcript || translating || isTaskRunning}
            title="翻译"
          >
            <span>{translating ? '…' : '翻译'}</span>
            <ArrowRight size={18} weight="bold" />
          </button>
        </div>

        <section className="panel-box viral-text-card">
          <div className="panel-title">
            <h3>翻译文案</h3>
            <div className="viral-text-actions">
              <button
                type="button"
                className="btn-secondary"
                style={{ height: 32 }}
                onClick={() => setTextExpanded((value) => !value)}
              >
                {textExpanded ? <ArrowsIn size={14} /> : <ArrowsOut size={14} />}
                {textExpanded ? '收起' : '展开'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                style={{ height: 32 }}
                disabled={translatedLines.length === 0}
                onClick={() => void handleCopy(translatedLines.join('\n'))}
              >
                <Copy size={14} /> 复制
              </button>
            </div>
          </div>
          <div
            className="viral-line-list"
            ref={translatedListRef}
            onScroll={syncScrollFromTranslated}
          >
            {translatedLines.length === 0 ? (
              <div className="viral-media-empty">点击中间翻译后，与原文逐行对应展示</div>
            ) : (
              Array.from({ length: lineCount }, (_, index) => (
                <div className="viral-line-row" key={`t-${index}`}>
                  <span className="viral-line-index">{index + 1}</span>
                  <span className="viral-line-text">{translatedLines[index] || '—'}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
