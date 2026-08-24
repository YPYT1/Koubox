import { useState, useEffect, useRef } from 'react'
import {
  DownloadSimple,
  X,
  Copy,
  FilmStrip,
  Waveform,
  Play,
  Pause,
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
  { stage: 'extract-audio', label: '提取原音频', desc: '保留源采样率与声道，避免为识别额外降质' },
  { stage: 'separate-vocals', label: '分离人声', desc: 'Demucs 去除背景音乐，保留人声' },
  { stage: 'asr', label: '语音识别', desc: 'Faster-Whisper Large-v3 直接识别原音频' },
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
  const [audioProgress, setAudioProgress] = useState({ current: 0, duration: 0 })
  const [vocalsProgress, setVocalsProgress] = useState({ current: 0, duration: 0 })
  const [videoOrientation, setVideoOrientation] = useState<'portrait' | 'landscape' | 'unknown'>('unknown')
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

  const formatAudioTime = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
    const total = Math.floor(seconds)
    const m = Math.floor(total / 60)
    const s = String(total % 60).padStart(2, '0')
    return `${m}:${s}`
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

  const seekAudio = (ratio: number, kind: 'audio' | 'vocals') => {
    const el = kind === 'audio' ? audioRef.current : vocalsRef.current
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return
    el.currentTime = Math.max(0, Math.min(1, ratio)) * el.duration
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
  const translatedLines = task?.translationLines ?? (task?.translation ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const lineCount = Math.max(originalLines.length, translatedLines.length, 1)
  const pairedLines = Array.from({ length: lineCount }, (_, index) => ({
    index,
    original: originalLines[index] ?? '—',
    translated: translatedLines[index] ?? '—'
  }))
  const isTaskRunning = Boolean(task && !['complete', 'error', 'cancelled'].includes(task.status))
  const videoSrc = task?.artifacts.video ? window.koubox.mediaUrl(task.artifacts.video) : ''
  const audioSrc = task?.artifacts.audio ? window.koubox.mediaUrl(task.artifacts.audio) : ''
  const vocalsSrc = task?.artifacts.vocals ? window.koubox.mediaUrl(task.artifacts.vocals) : ''

  useEffect(() => {
    setVideoOrientation('unknown')
    setVideoPlaying(false)
  }, [videoSrc])

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

      <section className="panel-box viral-preview-panel">
        <div className="panel-title">
          <h3>素材预览</h3>
          <span className="viral-preview-hint">短视频默认 9:16 竖屏，横屏会自动适配</span>
        </div>

        <div className={`viral-preview-grid ${videoOrientation === 'landscape' ? 'is-landscape' : 'is-portrait-layout'}`}>
          <div className="viral-video-column">
            <div className="viral-slot-label">
              <FilmStrip size={15} />
              <span>视频</span>
            </div>
            {videoSrc ? (
              <div className={`viral-media-frame is-${videoOrientation}`}>
                <video
                  ref={videoRef}
                  className="viral-media-player"
                  controls
                  preload="metadata"
                  src={videoSrc}
                  onLoadedMetadata={(e) => {
                    const el = e.currentTarget
                    setVideoOrientation(el.videoHeight >= el.videoWidth ? 'portrait' : 'landscape')
                  }}
                  onPlay={() => setVideoPlaying(true)}
                  onPause={() => setVideoPlaying(false)}
                  onEnded={() => setVideoPlaying(false)}
                />
                {!videoPlaying && (
                  <button type="button" className="viral-media-play" onClick={() => void playVideo()} aria-label="播放视频">
                    <Play size={26} weight="fill" />
                  </button>
                )}
              </div>
            ) : (
              <div className="viral-phone-placeholder">
                <span>下载完成后在此预览</span>
                <small>9:16 竖屏</small>
              </div>
            )}
          </div>

          <div className="viral-audio-column">
            <div className="viral-audio-slot">
              <div className="viral-slot-label">
                <Waveform size={15} />
                <span>原音频（含 BGM）</span>
              </div>
              {audioSrc ? (
                <div className="viral-audio-frame">
                  <audio
                    ref={audioRef}
                    preload="metadata"
                    src={audioSrc}
                    onPlay={() => setAudioPlaying(true)}
                    onPause={() => setAudioPlaying(false)}
                    onEnded={() => setAudioPlaying(false)}
                    onLoadedMetadata={(e) => {
                      setAudioProgress({ current: 0, duration: e.currentTarget.duration || 0 })
                    }}
                    onTimeUpdate={(e) => {
                      setAudioProgress({
                        current: e.currentTarget.currentTime,
                        duration: e.currentTarget.duration || 0
                      })
                    }}
                  />
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
                    {audioPlaying ? <Pause size={20} weight="fill" /> : <Play size={20} weight="fill" />}
                  </button>
                  <div className="viral-audio-meta">
                    <input
                      type="range"
                      className="viral-audio-seek"
                      min={0}
                      max={1000}
                      value={audioProgress.duration > 0 ? Math.round((audioProgress.current / audioProgress.duration) * 1000) : 0}
                      onChange={(e) => seekAudio(Number(e.target.value) / 1000, 'audio')}
                      aria-label="原音频进度"
                    />
                    <div className="viral-audio-time">
                      <span>{formatAudioTime(audioProgress.current)}</span>
                      <span>{formatAudioTime(audioProgress.duration)}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="viral-slot-empty">抽音完成后可在此试听原音</div>
              )}
            </div>

            <div className="viral-audio-slot">
              <div className="viral-slot-label">
                <Waveform size={15} />
                <span>人声（去背景音乐）</span>
              </div>
              {vocalsSrc ? (
                <div className="viral-audio-frame">
                  <audio
                    ref={vocalsRef}
                    preload="metadata"
                    src={vocalsSrc}
                    onPlay={() => setVocalsPlaying(true)}
                    onPause={() => setVocalsPlaying(false)}
                    onEnded={() => setVocalsPlaying(false)}
                    onLoadedMetadata={(e) => {
                      setVocalsProgress({ current: 0, duration: e.currentTarget.duration || 0 })
                    }}
                    onTimeUpdate={(e) => {
                      setVocalsProgress({
                        current: e.currentTarget.currentTime,
                        duration: e.currentTarget.duration || 0
                      })
                    }}
                  />
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
                    {vocalsPlaying ? <Pause size={20} weight="fill" /> : <Play size={20} weight="fill" />}
                  </button>
                  <div className="viral-audio-meta">
                    <input
                      type="range"
                      className="viral-audio-seek"
                      min={0}
                      max={1000}
                      value={vocalsProgress.duration > 0 ? Math.round((vocalsProgress.current / vocalsProgress.duration) * 1000) : 0}
                      onChange={(e) => seekAudio(Number(e.target.value) / 1000, 'vocals')}
                      aria-label="人声进度"
                    />
                    <div className="viral-audio-time">
                      <span>{formatAudioTime(vocalsProgress.current)}</span>
                      <span>{formatAudioTime(vocalsProgress.duration)}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="viral-slot-empty">人声分离完成后可在此对比试听</div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className={`panel-box viral-text-panel ${textExpanded ? 'expanded' : ''}`}>
        <div className="panel-title">
          <h3>文案与翻译</h3>
        </div>
        <div className="viral-text-grid">
          <div className="viral-text-card">
            <div className="viral-text-head">
              <h4>原始文案</h4>
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
                <div className="viral-slot-empty">识别完成后按「一行一句」展示</div>
              ) : (
                pairedLines.map(({ index, original }) => (
                  <div className="viral-line-row" key={`o-${index}`}>
                    <span className="viral-line-index">{index + 1}</span>
                    <span className="viral-line-text">{original}</span>
                  </div>
                ))
              )}
            </div>
          </div>

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

          <div className="viral-text-card">
            <div className="viral-text-head">
              <h4>翻译文案</h4>
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
                <div className="viral-slot-empty">点击中间翻译后，与原文逐行对应展示</div>
              ) : (
                pairedLines.map(({ index, translated }) => (
                  <div className="viral-line-row" key={`t-${index}`}>
                    <span className="viral-line-index">{index + 1}</span>
                    <span className="viral-line-text">{translated}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
