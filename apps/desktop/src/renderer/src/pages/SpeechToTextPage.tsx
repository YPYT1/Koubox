import { useEffect, useRef, useState } from 'react'

import {

  ArrowsIn,

  ArrowsOut,

  Check,

  Copy,

  MicrophoneStage,

  Play,

  Pause,

  Waveform,

  X

} from '@phosphor-icons/react'

import { LOCAL_AUDIO_EXTENSIONS, LOCAL_VIDEO_EXTENSIONS, type TaskSnapshot } from '@koubox/shared'

import { Button } from '../components/common/Button'

import { FormField, PathPicker } from '../components/common/FormControls'

import { PipelineStatusPanel } from '../components/common/PipelineStatusPanel'

import {

  LocalSpeechMediaField,

  startSpeechToTextPipeline,

  usePipelineTask,

  VideoPreviewSlot

} from '../components/download'



type SpeechToTextPageProps = {

  defaultOutputDirectory: string

  openOutputOnComplete: boolean

  onChooseDirectory: (title: string, defaultPath?: string) => Promise<string | undefined>

  onChooseMediaFile: (title: string, defaultPath?: string) => Promise<string | undefined>

  onShowToast: (message: string, type?: 'success' | 'warning' | 'error' | 'info') => void

  onTaskStatus?: (status: TaskSnapshot['status'] | null) => void

}



const STEPS = [
  { stage: 'download', label: '导入媒体', desc: '读取本地音频或视频（不写入保存目录）' },
  { stage: 'extract-audio', label: '转换音频', desc: '临时生成 Whisper 可识别的高精度 WAV' },
  { stage: 'asr', label: '语音识别', desc: 'Faster-Whisper Large-v3 输出分句与时间轴' },
  { stage: 'complete', label: '完成', desc: '原文字稿已写入保存目录' }
]



function fileExtension(path: string): string {

  return path.split('.').pop()?.toLowerCase() ?? ''

}



function isAudioPath(path: string): boolean {

  return (LOCAL_AUDIO_EXTENSIONS as readonly string[]).includes(fileExtension(path))

}



function isVideoPath(path: string): boolean {

  return (LOCAL_VIDEO_EXTENSIONS as readonly string[]).includes(fileExtension(path))

}



function formatAudioTime(seconds: number) {

  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'

  const total = Math.floor(seconds)

  const m = Math.floor(total / 60)

  const s = String(total % 60).padStart(2, '0')

  return `${m}:${s}`

}



function formatSegmentTime(seconds: number): string {

  const mins = Math.floor(seconds / 60)

  const secs = Math.floor(seconds % 60)

  const ms = Math.floor((seconds % 1) * 1000)

  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`

}



export function SpeechToTextPage({

  defaultOutputDirectory,

  openOutputOnComplete,

  onChooseDirectory,

  onChooseMediaFile,

  onShowToast,

  onTaskStatus

}: SpeechToTextPageProps) {

  const [mediaPath, setMediaPath] = useState('')

  const [outputDirectory, setOutputDirectory] = useState(defaultOutputDirectory)

  const [starting, setStarting] = useState(false)

  const [textExpanded, setTextExpanded] = useState(false)

  const [copied, setCopied] = useState(false)

  const [audioPlaying, setAudioPlaying] = useState(false)

  const [audioProgress, setAudioProgress] = useState({ current: 0, duration: 0 })

  const openedTaskIds = useRef(new Set<string>())

  const notifiedRef = useRef<string | null>(null)

  const audioRef = useRef<HTMLAudioElement>(null)



  const { task, setTask, cancel, isTaskRunning } = usePipelineTask({

    kind: 'speech-to-text',

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

    if (task.status === 'complete') onShowToast('语音转文字完成。', 'success')

  }, [task, onShowToast])



  useEffect(() => {

    if (!task || task.status !== 'complete' || !openOutputOnComplete) return

    if (openedTaskIds.current.has(task.taskId)) return

    openedTaskIds.current.add(task.taskId)

    void window.koubox.post('/dialog/open-path', { path: task.outputDirectory }).catch((err) => {

      onShowToast(err instanceof Error ? err.message : '无法打开输出目录', 'error')

    })

  }, [task, openOutputOnComplete, onShowToast])



  useEffect(() => {

    setAudioPlaying(false)

    setAudioProgress({ current: 0, duration: 0 })

  }, [mediaPath, task?.url])

  const sourcePath = mediaPath.trim() || task?.url || ''
  const previewAudioPath = sourcePath && isAudioPath(sourcePath) ? sourcePath : ''
  const previewVideoPath = sourcePath && isVideoPath(sourcePath) ? sourcePath : ''

  const audioSrc = previewAudioPath ? window.koubox.mediaUrl(previewAudioPath) : ''

  const segments = task?.transcript?.segments ?? []

  const transcriptText = segments

    .map((segment) => segment.text.trim())

    .filter(Boolean)

    .join('\n')



  const handleStart = async () => {

    if (!mediaPath.trim()) return onShowToast('请选择本地音频或视频文件', 'warning')

    setStarting(true)

    try {

      const created = await startSpeechToTextPipeline(mediaPath, outputDirectory)

      setTask(created)

      onTaskStatus?.(created.status)

      onShowToast('语音转文字任务已启动…', 'info')

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



  const playAudio = async () => {

    const el = audioRef.current

    if (!el) return

    try {

      await el.play()

      setAudioPlaying(true)

    } catch (err) {

      onShowToast(err instanceof Error ? err.message : '音频无法播放', 'error')

    }

  }



  const seekAudio = (ratio: number) => {

    const el = audioRef.current

    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return

    el.currentTime = Math.max(0, Math.min(1, ratio)) * el.duration

  }



  const handleCopy = async () => {

    if (!transcriptText) return

    await navigator.clipboard.writeText(transcriptText)

    setCopied(true)

    window.setTimeout(() => setCopied(false), 900)

    onShowToast('原文已复制到剪贴板', 'success')

  }



  return (

    <div className="page-container viral-page">

      <div className="page-header-block">

        <h1>语音转文字</h1>

        <p>上传本地音频、视频或人声轨，识别原文并输出带时间轴的分句结果</p>

      </div>



      <div className="viral-top-grid">

        <section className="panel-box viral-input-panel">

          <div className="panel-title">

            <h3>媒体来源</h3>

          </div>



          <LocalSpeechMediaField

            value={mediaPath}

            onChange={setMediaPath}

            disabled={isTaskRunning}

            onChooseMediaFile={onChooseMediaFile}

            browseDefaultPath={outputDirectory}

          />



          <FormField label="保存目录">

            <PathPicker

              value={outputDirectory}

              onChange={setOutputDirectory}

              onBrowse={async () => {

                const dir = await onChooseDirectory('选择识别结果保存目录', outputDirectory)

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

                icon={<MicrophoneStage size={18} weight="bold" />}

              >

                {starting ? '正在启动…' : '开始识别'}

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
          <h3>结果预览</h3>
          <span className="viral-preview-hint">上方试听音频，下方查看分句原文与时间轴</span>
        </div>

        <div className="speech-audio-row">
          {previewVideoPath ? (
            <div className="speech-video-slot">
              <VideoPreviewSlot
                videoPath={previewVideoPath}
                emptyHint="选择视频后在此预览"
                emptySubHint="识别开始后会同步展示提取的音频"
                onError={(message) => onShowToast(message, 'error')}
              />
            </div>
          ) : null}

          <div className="viral-audio-slot speech-audio-slot">
            <div className="viral-slot-label">
              <Waveform size={15} />
              <span>音频试听</span>
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
                  aria-label={audioPlaying ? '暂停音频' : '播放音频'}
                >
                  {audioPlaying ? <Pause size={20} weight="fill" /> : <Play size={20} weight="fill" />}
                </button>
                <div className="viral-audio-meta">
                  <input
                    type="range"
                    className="viral-audio-seek"
                    min={0}
                    max={1000}
                    value={
                      audioProgress.duration > 0
                        ? Math.round((audioProgress.current / audioProgress.duration) * 1000)
                        : 0
                    }
                    onChange={(e) => seekAudio(Number(e.target.value) / 1000)}
                    aria-label="音频进度"
                  />
                  <div className="viral-audio-time">
                    <span>{formatAudioTime(audioProgress.current)}</span>
                    <span>{formatAudioTime(audioProgress.duration)}</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="viral-slot-empty speech-audio-empty">
                {previewVideoPath
                  ? '视频导入并抽音完成后，可在此播放识别用音频'
                  : '选择音频文件后可先试听；任务完成后展示识别用音频'}
              </div>
            )}
          </div>
        </div>

        <div className={`viral-text-card speech-text-card ${textExpanded ? 'speech-text-expanded' : ''}`}>
          <div className="viral-text-head">
            <h4>
              识别文本
              {task?.transcript?.language ? (
                <span className="panel-title-badge">{task.transcript.language}</span>
              ) : null}
            </h4>
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
                className={`btn-secondary ${copied ? 'btn-copy-done' : ''}`}
                style={{ height: 32 }}
                disabled={!transcriptText}
                onClick={() => void handleCopy()}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? '已复制' : '复制全文'}
              </button>
            </div>
          </div>

          {segments.length > 0 ? (
            <div className="segments-table speech-segments-table">
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
                  ? '正在识别，完成后按句展示原文与时间轴'
                  : '识别完成后，分句原文与时间轴将显示在此'}
              </div>
            </div>
          )}
        </div>
      </section>

    </div>

  )

}


