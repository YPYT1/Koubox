import { useEffect, useRef, useState, type ComponentType } from 'react'
import {
  DownloadSimple,
  FilmStrip,
  Play,
  X,
  YoutubeLogo,
  InstagramLogo,
  TiktokLogo,
  FacebookLogo
} from '@phosphor-icons/react'
import { detectPlatform, type KouboxPlatform } from '@koubox/shared'
import { Button } from '../components/common/Button'
import { FormField, PathPicker } from '../components/common/FormControls'
import { Badge } from '../components/common/Badge'
import { PipelineStepper } from '../components/common/PipelineStepper'

type VideoDownloaderPageProps = {
  defaultOutputDirectory: string
  onChooseDirectory: (title: string, defaultPath?: string) => Promise<string | undefined>
  onShowToast: (message: string, type?: 'success' | 'warning' | 'error' | 'info') => void
}

const SUPPORTED_PLATFORMS: KouboxPlatform[] = ['YouTube', 'Facebook', 'Instagram', 'TikTok']

const PLATFORM_META: Array<{
  id: KouboxPlatform
  label: string
  Icon: ComponentType<{ size?: number; weight?: 'bold' | 'fill' | 'regular' }>
}> = [
  { id: 'YouTube', label: 'YouTube', Icon: YoutubeLogo },
  { id: 'Facebook', label: 'Facebook', Icon: FacebookLogo },
  { id: 'Instagram', label: 'Instagram', Icon: InstagramLogo },
  { id: 'TikTok', label: 'TikTok', Icon: TiktokLogo }
]

const STEPS = [
  { stage: 'download', label: '解析并下载', desc: '识别平台并拉取公开视频文件' },
  { stage: 'complete', label: '完成', desc: '写入保存目录并可供预览' }
]

export function VideoDownloaderPage({
  defaultOutputDirectory,
  onChooseDirectory,
  onShowToast
}: VideoDownloaderPageProps) {
  const [url, setUrl] = useState('')
  const [outputDirectory, setOutputDirectory] = useState(defaultOutputDirectory)
  const [starting, setStarting] = useState(false)
  const [videoPlaying, setVideoPlaying] = useState(false)
  const [videoOrientation, setVideoOrientation] = useState<'portrait' | 'landscape' | 'unknown'>('unknown')
  const [videoPath, setVideoPath] = useState('')
  const [status, setStatus] = useState<'idle' | 'running' | 'complete' | 'error' | 'cancelled'>('idle')
  const [stage, setStage] = useState<string | undefined>()
  const [percent, setPercent] = useState(0)
  const [message, setMessage] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (!outputDirectory && defaultOutputDirectory) setOutputDirectory(defaultOutputDirectory)
  }, [defaultOutputDirectory, outputDirectory])

  const platform = url.trim() ? detectPlatform(url.trim()) : undefined
  const platformSupported = platform ? SUPPORTED_PLATFORMS.includes(platform) : false
  const isTaskRunning = status === 'running'
  const videoSrc = videoPath ? window.koubox.mediaUrl(videoPath) : ''

  useEffect(() => {
    setVideoOrientation('unknown')
    setVideoPlaying(false)
  }, [videoSrc])

  const handleStart = async () => {
    const trimmed = url.trim()
    if (!/^https?:\/\//i.test(trimmed)) {
      onShowToast('请输入合法的视频链接', 'warning')
      return
    }
    const detected = detectPlatform(trimmed)
    if (!SUPPORTED_PLATFORMS.includes(detected)) {
      onShowToast('仅支持 YouTube / Facebook / Instagram / TikTok', 'warning')
      return
    }
    if (!outputDirectory.trim()) {
      onShowToast('请选择保存目录', 'warning')
      return
    }

    setStarting(true)
    try {
      onShowToast('下载接口尚未接入，当前仅完成前端布局', 'info')
    } finally {
      setStarting(false)
    }
  }

  const handleCancel = () => {
    setStatus('cancelled')
    setStage(undefined)
    setPercent(0)
    setMessage('已取消')
    onShowToast('任务已取消', 'info')
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

          <FormField label="视频链接" hint="粘贴公开视频 URL">
            <input
              className="input-text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              disabled={isTaskRunning}
            />
          </FormField>

          <div className="downloader-platforms">
            {PLATFORM_META.map(({ id, label, Icon }) => {
              const active = platform === id
              return (
                <span
                  key={id}
                  className={`downloader-platform-chip${active ? ' is-active' : ''}${platform && !platformSupported ? ' is-muted' : ''}`}
                >
                  <Icon size={16} weight={active ? 'fill' : 'regular'} />
                  {label}
                </span>
              )
            })}
          </div>

          {url.trim() && platform && !platformSupported && (
            <div className="downloader-platform-warn">当前链接平台不在支持范围内</div>
          )}

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
                onClick={handleCancel}
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
                    status === 'complete'
                      ? 'success'
                      : status === 'error'
                        ? 'danger'
                        : 'teal'
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
            {status !== 'idle' && (
              <span className={`task-percent-tag ${isTaskRunning ? 'pulsing' : ''}`}>{percent}%</span>
            )}
          </div>

          <PipelineStepper
            steps={STEPS}
            currentStage={stage}
            status={status === 'idle' ? undefined : status}
            percent={percent}
            message={message || undefined}
          />
        </section>
      </div>

      <section className="panel-box viral-preview-panel">
        <div className="panel-title">
          <h3>视频预览</h3>
          <span className="viral-preview-hint">下载完成后可在此直接播放</span>
        </div>

        <div className="downloader-preview">
          <div className="viral-slot-label">
            <FilmStrip size={15} />
            <span>视频文件</span>
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
            <div className="viral-phone-placeholder downloader-preview-empty">
              <span>下载完成后在此预览</span>
              <small>YouTube · Facebook · Instagram · TikTok</small>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
