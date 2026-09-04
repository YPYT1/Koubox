import { useState, useEffect, useRef } from 'react'
import {
  X,
  Copy,
  FilmStrip,
  Waveform,
  Play,
  Pause,
  ArrowsOut,
  ArrowsIn,
  Check,
  Translate,
  CircleNotch
} from '@phosphor-icons/react'
import {
  toUserTaskMessage,
  type MaterialsSourceMode,
  type TaskSnapshot,
  type TranslationTargetLanguage
} from '@koubox/shared'
import { Button } from '../components/common/Button'
import { FormField, PathPicker } from '../components/common/FormControls'
import { PipelineStepper } from '../components/common/PipelineStepper'
import { TranslationBusyFrame } from '../components/common/TranslationBusyFrame'
import { formatTaskPercent } from '../utils/progress'
import { Badge } from '../components/common/Badge'
import {
  startMaterialsPipeline,
  cancelDownloadTask,
  usePipelineTask,
  VideoSourceFields,
  videoSourceStartIcon
} from '../components/download'
// import { TARGET_LANGUAGE_OPTIONS } from './SettingsPage'

type RequirementOnePageProps = {
  defaultOutputDirectory: string
  translationTargetLanguage: TranslationTargetLanguage
  openOutputOnComplete: boolean
  onChooseDirectory: (title: string, defaultPath?: string) => Promise<string | undefined>
  onChooseVideoFile: (title: string, defaultPath?: string) => Promise<string | undefined>
  onShowToast: (message: string, type?: 'success' | 'warning' | 'error' | 'info') => void
  onTaskStatus?: (status: TaskSnapshot['status'] | null) => void
}

const SEPARATE_VOCALS_STEP = {
  stage: 'separate-vocals',
  label: '去除背景音乐',
  desc: 'Demucs 分离人声，对完整背景音乐素材效果较好'
}

const STEPS_URL = [
  { stage: 'download', label: '下载视频', desc: '解析链接并拉取视频文件' },
  { stage: 'extract-audio', label: '提取原音频', desc: '保留源采样率与声道，避免为识别额外降质' },
  { stage: 'asr', label: '语音识别', desc: 'Faster-Whisper Large-v3 直接识别原音频' }
  // { stage: 'translation', label: '翻译', desc: '按目标语种生成译文' }
]

const STEPS_LOCAL = [
  { stage: 'download', label: '导入视频', desc: '读取本地视频文件（不写入保存目录）' },
  { stage: 'extract-audio', label: '提取原音频', desc: '保留源采样率与声道，避免为识别额外降质' },
  { stage: 'asr', label: '语音识别', desc: 'Faster-Whisper Large-v3 直接识别原音频' }
  // { stage: 'translation', label: '翻译', desc: '按目标语种生成译文' }
]

function buildPipelineSteps(sourceMode: MaterialsSourceMode, separateVocals: boolean) {
  const base = sourceMode === 'local' ? STEPS_LOCAL : STEPS_URL
  if (!separateVocals) return base
  return [...base.slice(0, 2), SEPARATE_VOCALS_STEP, ...base.slice(2)]
}

export function RequirementOnePage({
  defaultOutputDirectory,
  translationTargetLanguage: _translationTargetLanguage,
  openOutputOnComplete,
  onChooseDirectory,
  onChooseVideoFile,
  onShowToast,
  onTaskStatus
}: RequirementOnePageProps) {
  const [sourceMode, setSourceMode] = useState<MaterialsSourceMode>('url')
  const [separateVocals, setSeparateVocals] = useState(false)
  const [url, setUrl] = useState('')
  const [videoPath, setVideoPath] = useState('')
  const [outputDirectory, setOutputDirectory] = useState(defaultOutputDirectory)
  const [starting, setStarting] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [textExpanded, setTextExpanded] = useState(false)
  const [copiedSection, setCopiedSection] = useState<'original' | 'translation' | null>(null)
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

  const { task, setTask, isTaskRunning } = usePipelineTask({
    kind: 'req1',
    onStatus: onTaskStatus,
    onError: (message) => onShowToast(message, 'error')
  })

  useEffect(() => {
    if (!outputDirectory && defaultOutputDirectory) setOutputDirectory(defaultOutputDirectory)
  }, [defaultOutputDirectory, outputDirectory])

  // useEffect for target language removed — target fixed to zh-Hans

  useEffect(() => {
    if (!task || task.status !== 'complete' || !openOutputOnComplete) return
    if (openedTaskIds.current.has(task.taskId)) return
    openedTaskIds.current.add(task.taskId)
    void window.koubox.post('/dialog/open-path', { path: task.outputDirectory }).catch((err) => {
      onShowToast(err instanceof Error ? err.message : '无法打开输出目录', 'error')
    })
  }, [task, openOutputOnComplete, onShowToast])

  const handleStart = async () => {
    setStarting(true)
    try {
      const createdTask = await startMaterialsPipeline(
        sourceMode === 'local'
          ? { videoPath, outputDirectory, separateVocals }
          : { url, outputDirectory, separateVocals }
      )
      setTask(createdTask)
      onTaskStatus?.(createdTask.status)
      onShowToast(sourceMode === 'local' ? '本地视频任务已启动…' : '任务已启动…', 'info')
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '任务启动失败', 'error')
    } finally {
      setStarting(false)
    }
  }

  const handleCancel = async () => {
    if (!task) return
    try {
      const cancelled = await cancelDownloadTask(task.taskId)
      setTask(cancelled)
      onTaskStatus?.(cancelled.status)
      onShowToast('任务已取消', 'info')
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '取消失败', 'error')
    }
  }

  const handleSeparateVocalsToggle = () => {
    const next = !separateVocals
    setSeparateVocals(next)
    if (task && !isTaskRunning && task.separateVocals !== next) {
      onShowToast('去除背景音乐设置已更新，将在下次开始提取时生效', 'info')
    }
  }

  const handleCopy = async (text: string, section: 'original' | 'translation') => {
    await navigator.clipboard.writeText(text)
    setCopiedSection(section)
    window.setTimeout(() => {
      setCopiedSection((current) => (current === section ? null : current))
    }, 900)
  }

  const handleTranslate = async () => {
    if (!task?.taskId || !task.transcript) return
    setTranslating(true)
    try {
      const updated = await window.koubox.post<TaskSnapshot>(
        `/tasks/${encodeURIComponent(task.taskId)}/translate`,
        { targetLanguage: 'zh-Hans' }
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

  const syncScrollFromOriginal = () => {
    const source = originalListRef.current
    const target = translatedListRef.current
    if (!source || !target || scrollSyncLock.current) return
    scrollSyncLock.current = true
    const sourceMax = Math.max(0, source.scrollHeight - source.clientHeight)
    const targetMax = Math.max(0, target.scrollHeight - target.clientHeight)
    target.scrollTop = sourceMax > 0 ? (source.scrollTop / sourceMax) * targetMax : 0
    requestAnimationFrame(() => {
      scrollSyncLock.current = false
    })
  }

  const syncScrollFromTranslated = () => {
    const source = translatedListRef.current
    const target = originalListRef.current
    if (!source || !target || scrollSyncLock.current) return
    scrollSyncLock.current = true
    const sourceMax = Math.max(0, source.scrollHeight - source.clientHeight)
    const targetMax = Math.max(0, target.scrollHeight - target.clientHeight)
    target.scrollTop = sourceMax > 0 ? (source.scrollTop / sourceMax) * targetMax : 0
    requestAnimationFrame(() => {
      scrollSyncLock.current = false
    })
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

  const originalLines = task?.transcript?.segments.map((s) => s.text.trim()) ?? []
  const translatedLines = task?.translationLines ?? []
  const hasTranscript = originalLines.some((line) => Boolean(line))
  const hasTranslation = translatedLines.some((line) => Boolean(line))
  const pairedLines = hasTranscript
    ? Array.from({ length: Math.max(originalLines.length, 1) }, (_, index) => ({
        index,
        original: originalLines[index] ?? '',
        translated: translatedLines[index] ?? ''
      }))
    : []
  const translationBusy = translating || (isTaskRunning && task?.stage === 'translation')
  const canTranslate =
    Boolean(task?.taskId && hasTranscript && !isTaskRunning && !translating && task.status !== 'cancelled')
  const activeSourceMode: MaterialsSourceMode =
    task?.sourceMode ?? (task && !/^https?:\/\//i.test(task.url) ? 'local' : sourceMode)
  const videoPreviewPath =
    activeSourceMode === 'local'
      ? (videoPath.trim() || task?.url || '')
      : (task?.artifacts.video ?? '')
  const videoSrc = videoPreviewPath ? window.koubox.mediaUrl(videoPreviewPath) : ''
  const audioSrc = task?.artifacts.audio ? window.koubox.mediaUrl(task.artifacts.audio) : ''
  const separateVocalsEnabled = task ? task.separateVocals === true : separateVocals
  const separateVocalsPendingNextTask =
    Boolean(task && !isTaskRunning && task.separateVocals !== separateVocals)
  const vocalsSrc =
    separateVocalsEnabled && task?.artifacts.vocals
      ? window.koubox.mediaUrl(task.artifacts.vocals)
      : ''
  const pipelineSteps = buildPipelineSteps(activeSourceMode, separateVocalsEnabled)
  const stepperStage =
    !separateVocalsEnabled && task?.stage === 'separate-vocals' ? 'asr' : task?.stage

  useEffect(() => {
    setVideoOrientation('unknown')
    setVideoPlaying(false)
  }, [videoSrc])

  return (
    <div className="page-container viral-page">
      <div className="page-header-block">
        <h1>爆款素材获取</h1>
        <p>支持粘贴平台链接下载，或直接上传本地视频；识别完成后可手动翻译为简体中文</p>
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
                const dir = await onChooseDirectory('选择素材保存目录', outputDirectory)
                if (dir) setOutputDirectory(dir)
              }}
              disabled={isTaskRunning}
            />
          </FormField>

          <div className="form-group">
            <div className={`viral-separate-vocals-row ${isTaskRunning ? 'is-disabled' : ''}`}>
              <span className="viral-separate-vocals-label">去除背景音乐</span>
              <button
                type="button"
                role="switch"
                aria-checked={separateVocals}
                aria-label="去除背景音乐"
                className={`ui-switch ${separateVocals ? 'on' : ''}`}
                disabled={isTaskRunning}
                onClick={handleSeparateVocalsToggle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleSeparateVocalsToggle()
                  }
                }}
              >
                <span className="ui-switch-thumb" />
              </button>
              <span className="viral-separate-vocals-desc">去除背景音乐（保留人声）</span>
            </div>
            {separateVocalsPendingNextTask ? (
              <small className="field-hint viral-separate-vocals-pending">将在下次开始提取时生效，本次任务结果不变</small>
            ) : null}
          </div>

          {/* <FormField label="翻译目标语言">
            <select
              className="input-text"
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value as TranslationTargetLanguage)}
              disabled={isTaskRunning}
            >
              {TARGET_LANGUAGE_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </FormField> */}

          <div className="viral-actions">
            {!isTaskRunning ? (
              <Button
                variant="primary"
                size="lg"
                style={{ flex: 1 }}
                onClick={handleStart}
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
              <span className={`task-percent-tag ${isTaskRunning ? 'pulsing' : ''}`}>{formatTaskPercent(task.percent)}</span>
            )}
          </div>

          <PipelineStepper
            steps={pipelineSteps}
            currentStage={stepperStage}
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
                <span>{activeSourceMode === 'local' ? '选择视频后可在此预览' : '下载完成后在此预览'}</span>
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

            {separateVocalsEnabled ? (
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
                <div className="viral-slot-empty">去除背景音乐完成后可在此对比试听</div>
              )}
            </div>
            ) : null}
          </div>
        </div>
      </section>

      <TranslationBusyFrame active={translationBusy} expanded={textExpanded}>
        <div className="panel-title">
          <h3>识别文案</h3>
          <span className="viral-preview-hint">左侧原文、右侧译文按句对齐；翻译需手动触发</span>
          <div className="viral-text-actions" style={{ marginLeft: 'auto' }}>
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
              disabled={!canTranslate}
              onClick={() => void handleTranslate()}
            >
              {translationBusy ? <CircleNotch size={14} className="spin" /> : <Translate size={14} />}
              {translationBusy ? '翻译中…' : '翻译成中文'}
            </button>
          </div>
        </div>
        <div className="viral-text-grid">
          <div className="viral-text-card">
            <div className="viral-text-head">
              <h4>原始文案</h4>
              <div className="viral-text-actions">
                <button
                  type="button"
                  className={`btn-secondary ${copiedSection === 'original' ? 'btn-copy-done' : ''}`}
                  style={{ height: 32 }}
                  disabled={!hasTranscript}
                  onClick={() => void handleCopy(originalLines.filter(Boolean).join('\n'), 'original')}
                >
                  {copiedSection === 'original' ? <Check size={14} /> : <Copy size={14} />}
                  {copiedSection === 'original' ? '已复制' : '复制原文'}
                </button>
              </div>
            </div>
            <div className="viral-line-list" ref={originalListRef} onScroll={syncScrollFromOriginal}>
              {pairedLines.length === 0 ? (
                <div className="viral-slot-empty">识别完成后按「一行一句」展示原文</div>
              ) : (
                pairedLines.map((row) => (
                  <div className="viral-line-row" key={`o-${row.index}`} data-sync-row={row.index}>
                    <span className="viral-line-index">{row.index + 1}</span>
                    <span className="viral-line-text">{row.original || '—'}</span>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="viral-text-card">
            <div className="viral-text-head">
              <h4>翻译文案</h4>
              <div className="viral-text-actions">
                <button
                  type="button"
                  className={`btn-secondary ${copiedSection === 'translation' ? 'btn-copy-done' : ''}`}
                  style={{ height: 32 }}
                  disabled={!hasTranslation}
                  onClick={() => void handleCopy(translatedLines.filter(Boolean).join('\n'), 'translation')}
                >
                  {copiedSection === 'translation' ? <Check size={14} /> : <Copy size={14} />}
                  {copiedSection === 'translation' ? '已复制' : '复制译文'}
                </button>
              </div>
            </div>
            <div className="viral-line-list" ref={translatedListRef} onScroll={syncScrollFromTranslated}>
              {pairedLines.length === 0 ? (
                <div className="viral-slot-empty">识别完成后可点击「翻译成中文」</div>
              ) : !hasTranslation && !translationBusy ? (
                <div className="viral-slot-empty">点击上方「翻译成中文」生成简体译文</div>
              ) : (
                pairedLines.map((row) => (
                  <div className="viral-line-row" key={`t-${row.index}`} data-sync-row={row.index}>
                    <span className="viral-line-index">{row.index + 1}</span>
                    <span className="viral-line-text">
                      {row.translated || (translationBusy ? '…' : '—')}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </TranslationBusyFrame>
    </div>
  )
}
