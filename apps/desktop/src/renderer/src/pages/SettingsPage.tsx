import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import {
  Question,
  X,
  CheckCircle,
  Warning,
  CaretDown,
  TerminalWindow,
  Globe,
  ArrowsClockwise,
  FloppyDiskBack,
  ClipboardText,
  Trash
} from '@phosphor-icons/react'
import type {
  AsrLanguage,
  AsrModelId,
  KouboxConfig,
  PlatformAuthMode,
  RuntimeStatus,
  TranslationTargetLanguage,
  VendorToolCheck,
  YtdlpCookiePlatformId,
  YtdlpCookieStatus,
  YtdlpMaxHeight
} from '@koubox/shared'
import { type LicenseSnapshot } from '@koubox/license-client/types'
import { ASR_MODEL_OPTIONS, defaultPlatformAuth } from '@koubox/shared'
import { Button } from '../components/common/Button'
import { FormField, PathPicker } from '../components/common/FormControls'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

type GuideKind = 'ytdlp' | 'ffmpeg'

type FileFilter = { name: string; extensions: string[] }

type SettingsPageProps = {
  config: KouboxConfig
  runtime: RuntimeStatus | null
  onChange: (config: KouboxConfig) => void
  onSave: (e: FormEvent<HTMLFormElement>) => void
  onChooseDirectory: (title: string, defaultPath?: string) => Promise<string | undefined>
  onChooseFile: (
    title: string,
    defaultPath?: string,
    filters?: FileFilter[]
  ) => Promise<string | undefined>
  onShowToast: (message: string, type?: 'success' | 'warning' | 'error' | 'info') => void
  onRefresh: () => void
  license: LicenseSnapshot | null
  onOpenLicenseEditor: () => void
}

const TARGET_LANGUAGE_OPTIONS: Array<{ value: TranslationTargetLanguage; label: string }> = [
  { value: 'zh-Hans', label: '简体中文' },
  { value: 'zh-Hant', label: '繁体中文' },
  { value: 'en', label: '英文' },
  { value: 'ja', label: '日文' },
  { value: 'ko', label: '韩文' }
]

const ASR_LANGUAGE_OPTIONS: Array<{ value: AsrLanguage; label: string }> = [
  { value: 'auto', label: '自动检测' },
  ...TARGET_LANGUAGE_OPTIONS
]

const HEIGHT_OPTIONS: Array<{ value: YtdlpMaxHeight; label: string }> = [
  { value: 0, label: '最清晰（原画）' },
  { value: 1080, label: '最高 1080p' },
  { value: 720, label: '最高 720p' },
  { value: 480, label: '最高 480p' }
]

const PLATFORM_AUTH_OPTIONS: Array<{
  id: YtdlpCookiePlatformId
  label: string
  requiredHint: string
}> = [
  { id: 'youtube', label: 'YouTube', requiredHint: 'SID / HSID / SSID / APISID / SAPISID' },
  { id: 'tiktok', label: 'TikTok', requiredHint: 'sessionid / sid_tt' },
  { id: 'instagram', label: 'Instagram', requiredHint: 'sessionid / ds_user_id' },
  { id: 'facebook', label: 'Facebook', requiredHint: 'c_user / xs' }
]

type AppDataRoots = {
  mode: 'development' | 'packaged'
  userData: string
  logs: string
}
type LanStatus = { enabled: boolean; port?: number; alias?: string; fingerprint?: string; error?: string; dataRoot: string }

type ClearAppCacheResult = {
  cancelled: boolean
  cleared: string[]
  failed: Array<{ path: string; error: string }>
  roots: AppDataRoots
  config?: KouboxConfig
}


const guides: Record<GuideKind, {
  title: string
  role: string
  download: string
  downloadUrl: string
  layout: string
  files: string[]
}> = {
  ytdlp: {
    title: 'yt-dlp 使用说明',
    role: '负责按视频链接下载各大平台素材（视频文件）。爆款素材获取工具依赖它。',
    download: '口播匣内置经过验证的 nightly，也可自行下载替换。',
    downloadUrl: 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases',
    layout: '选择的目录内直接放置 yt-dlp.exe（不要再套一层子文件夹）。',
    files: ['yt-dlp.exe']
  },
  ffmpeg: {
    title: 'FFmpeg 使用说明',
    role: '负责从视频抽取音频、统一采样率。下载后抽音、以及部分音视频处理都依赖它。',
    download: '下载 Windows shared 构建（含 exe 与 dll），解压后指向 bin 目录。',
    downloadUrl: 'https://www.gyan.dev/ffmpeg/builds/',
    layout: '选择的目录应是包含 ffmpeg.exe 与配套 dll 的 bin 文件夹。',
    files: [
      'ffmpeg.exe',
      'ffprobe.exe',
      'ffplay.exe',
      'avcodec-62.dll',
      'avdevice-62.dll',
      'avfilter-11.dll',
      'avformat-62.dll',
      'avutil-60.dll',
      'swresample-6.dll',
      'swscale-9.dll'
    ]
  }
}

function VendorIntegrity({ check }: { check: VendorToolCheck | undefined }) {
  if (!check) return null
  const passed = check.missingFiles.length === 0 && check.ready
  return (
    <div className={`vendor-integrity ${passed ? 'ok' : 'warn'}`}>
      <div className="vendor-integrity-head">
        <span>
          {check.ready ? '可执行检测通过' : '可执行检测未通过'}
          {' · '}
          文件 {check.foundFiles.length} / {check.expectedFiles.length}
        </span>
      </div>
      {check.missingFiles.length > 0 && (
        <div className="vendor-integrity-missing">
          <span>缺少：</span>
          {check.missingFiles.map((file) => (
            <code key={file}>{file}</code>
          ))}
        </div>
      )}
      {passed && (
        <div className="vendor-integrity-ok">
          清单完整，运行时可用
          {check.ejsVersion ? ` · EJS ${check.ejsVersion}` : ''}
          {check.jsRuntimeVersion ? ` · Deno ${check.jsRuntimeVersion}` : ''}
        </div>
      )}
    </div>
  )
}

export function SettingsPage({
  config,
  runtime,
  onChange,
  onSave,
  onChooseDirectory,
  onChooseFile,
  onShowToast,
  onRefresh,
  license,
  onOpenLicenseEditor
}: SettingsPageProps) {
  const initialRefreshStartedRef = useRef(false)
  const [guide, setGuide] = useState<GuideKind | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [openingLogin, setOpeningLogin] = useState<YtdlpCookiePlatformId | null>(null)
  const [checkingCookies, setCheckingCookies] = useState(false)
  const [cookieCheckCompleted, setCookieCheckCompleted] = useState(false)
  const cookieCheckDoneTimerRef = useRef<number | null>(null)
  const [cookieStatus, setCookieStatus] = useState<YtdlpCookieStatus | null>(null)
  const [platformPanelOpen, setPlatformPanelOpen] = useState<Record<YtdlpCookiePlatformId, boolean>>({
    youtube: false,
    tiktok: false,
    instagram: false,
    facebook: false
  })

  const togglePlatformPanel = (id: YtdlpCookiePlatformId) => {
    setPlatformPanelOpen((prev) => {
      const opening = !prev[id]
      if (!opening) return { ...prev, [id]: false }
      return { youtube: false, tiktok: false, instagram: false, facebook: false, [id]: true }
    })
  }
  const [savingPlatformAuth, setSavingPlatformAuth] = useState(false)
  const [savingPlatformId, setSavingPlatformId] = useState<YtdlpCookiePlatformId | null>(null)
  const [checkingPlatformId, setCheckingPlatformId] = useState<YtdlpCookiePlatformId | null>(null)
  const [readingClipboard, setReadingClipboard] = useState<YtdlpCookiePlatformId | null>(null)
  const [appDataRoots, setAppDataRoots] = useState<AppDataRoots | null>(null)
  const [lanStatus, setLanStatus] = useState<LanStatus | null>(null)
  const [clearingCache, setClearingCache] = useState(false)
  const [secretClickCount, setSecretClickCount] = useState(0)
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number }>>([])
  const secretClickTimerRef = useRef<number | null>(null)
  const activeGuide = guide ? guides[guide] : null
  const platformAuth = config.ytdlpPlatformAuth ?? defaultPlatformAuth()

  const patchPlatformAuth = (id: YtdlpCookiePlatformId, patch: { mode?: PlatformAuthMode; cookies?: string }) => {
    onChange({
      ...config,
      ytdlpPlatformAuth: {
        ...platformAuth,
        [id]: {
          ...platformAuth[id],
          ...patch
        }
      }
    })
  }

  const handleSecretClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const rippleId = Date.now()
    
    setRipples(prev => [...prev, { id: rippleId, x, y }])
    setTimeout(() => {
      setRipples(prev => prev.filter(r => r.id !== rippleId))
    }, 600)

    const newCount = secretClickCount + 1
    setSecretClickCount(newCount)

    if (secretClickTimerRef.current) {
      window.clearTimeout(secretClickTimerRef.current)
    }

    if (newCount >= 10) {
      setSecretClickCount(0)
      onOpenLicenseEditor()
    } else {
      secretClickTimerRef.current = window.setTimeout(() => {
        setSecretClickCount(0)
      }, 2000)
    }
  }

  const refreshCookieStatus = async () => {
    const start = performance.now()
    setCookieCheckCompleted(false)
    if (cookieCheckDoneTimerRef.current) {
      window.clearTimeout(cookieCheckDoneTimerRef.current)
      cookieCheckDoneTimerRef.current = null
    }
    setCheckingCookies(true)
    let success = false
    try {
      const status = await window.koubox.get<YtdlpCookieStatus>('/browser/cookie-status')
      setCookieStatus(status)
      success = true
      return status
    } catch (error) {
      success = false
      setCookieCheckCompleted(false)
      onShowToast(error instanceof Error ? error.message : '检测登录状态失败', 'error')
      return null
    } finally {
      const elapsed = performance.now() - start
      const minDurationMs = 900
      if (elapsed < minDurationMs) {
        await new Promise((resolve) => window.setTimeout(resolve, minDurationMs - elapsed))
      }
      setCheckingCookies(false)
      if (success) {
        cookieCheckDoneTimerRef.current = window.setTimeout(() => setCookieCheckCompleted(false), 1200)
      }
    }
  }

  useEffect(() => {
    if (initialRefreshStartedRef.current) return
    initialRefreshStartedRef.current = true
    void refreshCookieStatus()
    void window.koubox.get<AppDataRoots>('/system/data-roots')
      .then((roots) => setAppDataRoots(roots))
      .catch(() => setAppDataRoots(null))
    void window.koubox.get<LanStatus>('/lan/status')
      .then((status) => setLanStatus(status))
      .catch(() => setLanStatus(null))
  }, [])

  const handleClearCache = async () => {
    setClearingCache(true)
    try {
      const result = await window.koubox.post<ClearAppCacheResult>('/system/clear-cache')
      if (result.cancelled) {
        onShowToast('已取消清理。', 'warning')
        return
      }
      setAppDataRoots(result.roots)
      setCookieStatus(null)
      if (result.config) onChange(result.config)
      if (result.failed.length > 0) {
        onShowToast(`清理完成，但有 ${result.failed.length} 项失败（可能仍被占用）。`, 'warning')
        return
      }
      onShowToast('已清理缓存、登录状态与任务记录。', 'success')
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '清理缓存失败', 'error')
    } finally {
      setClearingCache(false)
    }
  }

  const handleSelectPath = async (key: keyof KouboxConfig, title: string) => {
    const current = config[key]
    const picked = await onChooseDirectory(title, typeof current === 'string' ? current : undefined)
    if (picked) onChange({ ...config, [key]: picked })
  }

  const handleSelectFile = async (
    key: 'pythonExecutable',
    title: string,
    filters?: FileFilter[]
  ) => {
    const picked = await onChooseFile(title, config[key] || undefined, filters)
    if (picked) onChange({ ...config, [key]: picked })
  }

  const handleSavePlatformAuth = async (platformId: YtdlpCookiePlatformId) => {
    setSavingPlatformId(platformId)
    setSavingPlatformAuth(true)
    try {
      const saved = await window.koubox.put<KouboxConfig>(`/config/platform-auth/${platformId}`, platformAuth[platformId])
      onChange(saved)
      const label = PLATFORM_AUTH_OPTIONS.find((item) => item.id === platformId)?.label ?? platformId
      onShowToast(`${label} 登录配置已保存。`, 'success')
      await handleCheckPlatformLogin(platformId, saved.ytdlpPlatformAuth[platformId])
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '保存平台登录配置失败', 'error')
    } finally {
      setSavingPlatformAuth(false)
      setSavingPlatformId(null)
    }
  }

  const handleCheckPlatformLogin = async (platformId: YtdlpCookiePlatformId, auth = platformAuth[platformId]) => {
    setCheckingPlatformId(platformId)
    try {
      const status = await window.koubox.post<YtdlpCookieStatus>('/browser/cookie-status', { platformId, auth })
      const platformStatus = status.platforms[0]
      setCookieStatus((previous) => ({
        exported: false,
        cookieCount: status.cookieCount,
        platforms: PLATFORM_AUTH_OPTIONS.map((item) =>
          item.id === platformId
            ? platformStatus
            : previous?.platforms.find((existing) => existing.id === item.id) ?? {
                id: item.id,
                label: item.label,
                loggedIn: false,
                detail: '尚未检测'
              })
      }))
      const label = PLATFORM_AUTH_OPTIONS.find((item) => item.id === platformId)?.label ?? platformId
      onShowToast(platformStatus?.loggedIn ? `${label} 登录检测通过。` : (platformStatus?.detail ?? `${label} 登录未就绪。`), platformStatus?.loggedIn ? 'success' : 'warning')
      return status
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '检测平台登录失败', 'error')
      return null
    } finally {
      setCheckingPlatformId(null)
    }
  }

  const handleOpenLoginWindow = async (platformId: YtdlpCookiePlatformId) => {
    setOpeningLogin(platformId)
    try {
      const saved = await window.koubox.put<KouboxConfig>('/config', config)
      onChange(saved)
      await window.koubox.post<{ ok: boolean }>('/browser/open-login', { platformId })
      const label = PLATFORM_AUTH_OPTIONS.find((item) => item.id === platformId)?.label ?? platformId
      onShowToast(`已打开 ${label} 应用内登录窗口，登录状态会自动保存。`, 'success')
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '打开登录窗口失败', 'error')
    } finally {
      setOpeningLogin(null)
    }
  }

  const handleReadClipboard = async (platformId: YtdlpCookiePlatformId) => {
    setReadingClipboard(platformId)
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) throw new Error('剪贴板为空，请先在 Cookie 扩展中复制全文。')
      patchPlatformAuth(platformId, { cookies: text })
      onShowToast('已从剪贴板读取 Cookie；请点击“保存平台登录配置”。', 'success')
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '读取剪贴板失败', 'error')
    } finally {
      setReadingClipboard(null)
    }
  }

  const handleSectionJump = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    const link = event.currentTarget
    const page = link.closest('.settings-page')
    const viewport = page?.closest<HTMLElement>('.workspace-viewport')
    const navigation = link.closest('nav')
    const section = page?.querySelector<HTMLDetailsElement>(link.hash)
    if (!viewport || !navigation || !section) return

    section.open = true
    const navigationStyle = window.getComputedStyle(navigation)
    const offset = navigationStyle.position === 'sticky'
      ? (Number.parseFloat(navigationStyle.top) || 0) + navigation.offsetHeight + 12
      : 12
    viewport.scrollTo({
      top: viewport.scrollTop + section.getBoundingClientRect().top - viewport.getBoundingClientRect().top - viewport.clientTop - offset,
      behavior: 'instant'
    })
    section.querySelector('summary')?.focus({ preventScroll: true })
  }

  const handleDetect = async () => {
    setDetecting(true)
    try {
      await window.koubox.post<RuntimeStatus>('/runtime/refresh')
      onRefresh()
      onShowToast('硬件及本地模型状态已刷新', 'success')
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '刷新检测失败', 'error')
    } finally {
      setDetecting(false)
    }
  }

  return (
    <div className="page-container settings-page">
      <div className="page-header-block models-page-header">
        <div>
          <h1>全局设置</h1>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="md"
          loading={detecting}
          icon={<ArrowsClockwise size={16} />}
          onClick={() => void handleDetect()}
        >
          {detecting ? '检测中…' : '重新检测环境'}
        </Button>
      </div>


      <nav className="settings-jump-nav" aria-label="设置分区">
        <a href="#settings-storage" onClick={handleSectionJump}>文件与存储</a>
        <a href="#settings-defaults" onClick={handleSectionJump}>任务默认</a>
        <a href="#settings-download" onClick={handleSectionJump}>下载与登录</a>
        <a href="#settings-sharing" onClick={handleSectionJump}>局域网分享</a>
        <a href="#settings-advanced" onClick={handleSectionJump}>高级选项</a>
      </nav>
      <form className="settings-form-stack" onSubmit={onSave}>
        <details id="settings-storage" className="panel-box settings-collapsible" open>
          <summary className="panel-title settings-section-summary">
            <span className="settings-summary-copy"><h3>文件与存储路径</h3></span>
            <CaretDown size={16} weight="bold" />
          </summary>

          <div className="settings-storage-grid">
          <FormField
            label="默认成果输出目录"
          >
            <PathPicker
              value={config.outputDirectory}
              onChange={(val) => onChange({ ...config, outputDirectory: val })}
              onBrowse={() => handleSelectPath('outputDirectory', '选择默认输出保存目录')}
              placeholder="例如 D:/KouboxOutputs"
            />
          </FormField>

          <FormField
            label="清理缓存"
          >
            <Button
              type="button"
              variant="danger"
              size="md"
              className="btn-clear-cache"
              loading={clearingCache}
              icon={<Trash size={16} weight="bold" />}
              onClick={() => void handleClearCache()}
            >
              {clearingCache ? '清理中…' : '清理缓存与临时数据'}
            </Button>
          </FormField>

          </div>
          <div className="settings-runtime-grid">
          <FormField
            label="yt-dlp 目录"
            labelAction={(
              <button type="button" className="field-help-btn" onClick={() => setGuide('ytdlp')} title="查看说明">
                <Question size={15} weight="bold" />
                说明
              </button>
            )}
          >
            <PathPicker
              value={config.ytdlpDirectory}
              onChange={(val) => onChange({ ...config, ytdlpDirectory: val })}
              onBrowse={() => handleSelectPath('ytdlpDirectory', '选择 yt-dlp 目录')}
              placeholder="例如 D:/Project/Koubox/vendor/yt-dlp"
            />
            <VendorIntegrity check={runtime?.vendor.ytdlp} />
          </FormField>

          <FormField label="Deno 目录">
            <PathPicker
              value={config.denoDirectory}
              onChange={(val) => onChange({ ...config, denoDirectory: val })}
              onBrowse={() => handleSelectPath('denoDirectory', '选择 Deno 目录')}
              placeholder="例如 D:/Project/Koubox/vendor/deno"
            />
            <VendorIntegrity check={runtime?.vendor.deno} />
          </FormField>

          <FormField
            label="FFmpeg 目录"
            labelAction={(
              <button type="button" className="field-help-btn" onClick={() => setGuide('ffmpeg')} title="查看说明">
                <Question size={15} weight="bold" />
                说明
              </button>
            )}
          >
            <PathPicker
              value={config.ffmpegDirectory}
              onChange={(val) => onChange({ ...config, ffmpegDirectory: val })}
              onBrowse={() => handleSelectPath('ffmpegDirectory', '选择 FFmpeg bin 目录')}
              placeholder="例如 D:/Project/Koubox/vendor/ffmpeg/bin"
            />
            <VendorIntegrity check={runtime?.vendor.ffmpeg} />
          </FormField>
          </div>
        </details>

        <details id="settings-defaults" className="panel-box settings-collapsible" open>
          <summary className="panel-title settings-section-summary">
            <span className="settings-summary-copy"><h3>任务默认</h3></span>
            <CaretDown size={16} weight="bold" />
          </summary>

          <FormField label="翻译目标语言">
            <Input value="简体中文（固定）" disabled readOnly />
          </FormField>

          <FormField label="ASR 语种" hint="Whisper 识别语种。繁体与简体在识别阶段均映射为中文。">
            <select
              className="input-text"
              value={config.asrLanguage}
              onChange={(e) => onChange({ ...config, asrLanguage: e.target.value as AsrLanguage })}
            >
              {ASR_LANGUAGE_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </FormField>

          <FormField label="默认识别模型">
            <select
              className="input-text"
              value={config.defaultAsrModel}
              onChange={(e) => onChange({ ...config, defaultAsrModel: e.target.value as AsrModelId })}
            >
              {ASR_MODEL_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </FormField>

          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={config.openOutputOnComplete}
              onChange={(e) => onChange({ ...config, openOutputOnComplete: e.target.checked })}
            />
            <span>任务完成后自动打开输出文件夹</span>
          </label>
        </details>

        <details id="settings-download" className="panel-box settings-collapsible" open>
          <summary className="panel-title settings-section-summary">
            <span className="settings-summary-copy"><h3>下载与平台登录</h3></span>
            <CaretDown size={16} weight="bold" />
          </summary>

          <FormField label="代理地址" hint="例如 http://127.0.0.1:7897；公开解析、应用内登录验证和 yt-dlp 下载共用此代理。">
            <div className="flex gap-2">
              <Input
                value={config.ytdlpProxy}
                onChange={(e) => onChange({ ...config, ytdlpProxy: e.target.value })}
                placeholder="http://127.0.0.1:7897"
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                variant="secondary"
                size="md"
                loading={checkingCookies}
                icon={cookieCheckCompleted ? <CheckCircle size={16} weight="fill" /> : <ArrowsClockwise size={16} weight="bold" />}
                onClick={() => void refreshCookieStatus()}
              >
                {cookieCheckCompleted ? '检测完成' : checkingCookies ? '检测中…' : '检测四平台登录配置'}
              </Button>
            </div>
          </FormField>

          {cookieStatus && (
                <div className="cookie-status-panel">
                  <div className="cookie-status-head">
                    <span>应用内会话共 {cookieStatus.cookieCount} 个 Cookie；各平台按当前选择的方式检测</span>
                  </div>
                  <div className="cookie-status-grid">
                    {cookieStatus!.platforms.map((platform) => (
                      <div
                        key={platform.id}
                        className={`cookie-status-item ${platform.loggedIn ? 'ok' : 'warn'}`}
                      >
                        {platform.loggedIn
                          ? <CheckCircle size={15} weight="fill" />
                          : <Warning size={15} weight="fill" />}
                        <div>
                          <strong>{platform.label}</strong>
                          <span>{platform.detail}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
          )}

          <div className="platform-auth-list">
                {PLATFORM_AUTH_OPTIONS.map((platform) => {
                  const entry = platformAuth[platform.id]
                  const open = platformPanelOpen[platform.id]
                  const status = cookieStatus?.platforms.find((item) => item.id === platform.id)
                  return (
                    <div key={platform.id} className={`platform-auth-panel ${open ? 'open' : ''}`}>
                      <button
                        type="button"
                        className="platform-auth-toggle"
                        onClick={() => togglePlatformPanel(platform.id)}
                        aria-expanded={open}
                      >
                        <span>
                          <strong>{platform.label}</strong>
                          <small>
                            {entry.mode === 'paste'
                              ? (entry.cookies.trim() ? '粘贴 Cookie · 已填写' : '粘贴 Cookie · 待粘贴')
                              : '应用内登录'}
                            {status ? ` · ${status.loggedIn ? '就绪' : '未就绪'}` : ''}
                          </small>
                        </span>
                        <CaretDown size={16} weight="bold" className={open ? 'rotated' : ''} />
                      </button>
                      {open && (
                        <div className="platform-auth-body">
                          <div className="platform-auth-modes" role="radiogroup" aria-label={`${platform.label} 登录方式`}>
                            <label className={`platform-auth-mode ${entry.mode === 'builtin' ? 'active' : ''}`}>
                              <input
                                type="radio"
                                name={`auth-mode-${platform.id}`}
                                checked={entry.mode === 'builtin'}
                                onChange={() => patchPlatformAuth(platform.id, { mode: 'builtin' })}
                              />
                              <span>应用内登录</span>
                            </label>
                            <label className={`platform-auth-mode ${entry.mode === 'paste' ? 'active' : ''}`}>
                              <input
                                type="radio"
                                name={`auth-mode-${platform.id}`}
                                checked={entry.mode === 'paste'}
                                onChange={() => patchPlatformAuth(platform.id, { mode: 'paste' })}
                              />
                              <span>粘贴 Cookie</span>
                            </label>
                          </div>
                          {entry.mode === 'paste' ? (
                            <>
                              <p className="field-hint">
                                用「口播匣 Cookie 导出」插件导出 {platform.label} 后全文粘贴。需含：{platform.requiredHint}
                              </p>
                              <div className="platform-auth-toolbar">
                                <Button
                                  type="button"
                                  variant="secondary"
                                  size="sm"
                                  loading={readingClipboard === platform.id}
                                  icon={<ClipboardText size={15} weight="bold" />}
                                  onClick={() => void handleReadClipboard(platform.id)}
                                >
                                  从剪贴板读取
                                </Button>
                              </div>
                              <textarea
                                className="textarea-box platform-auth-text"
                                rows={7}
                                value={entry.cookies}
                                onChange={(e) => patchPlatformAuth(platform.id, { cookies: e.target.value })}
                                placeholder={'# Netscape HTTP Cookie File\n...'}
                                spellCheck={false}
                              />
                            </>
                          ) : (
                            <>
                              <p className="field-hint">下载 {platform.label} 时使用口播匣独立登录会话，登录成功后 Cookie 会自动持久化。</p>
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                loading={openingLogin === platform.id}
                                icon={<Globe size={15} weight="bold" />}
                                onClick={() => void handleOpenLoginWindow(platform.id)}
                              >
                                打开 {platform.label} 登录
                              </Button>
                            </>
                          )}
                          <div className="platform-auth-toolbar">
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              loading={checkingPlatformId === platform.id}
                              icon={<CheckCircle size={15} weight="bold" />}
                              onClick={() => void handleCheckPlatformLogin(platform.id)}
                            >
                              检测 {platform.label} 登录
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              loading={savingPlatformAuth && savingPlatformId === platform.id}
                              icon={<FloppyDiskBack size={15} weight="bold" />}
                              onClick={() => void handleSavePlatformAuth(platform.id)}
                            >
                              保存 {platform.label}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
          </div>

          <FormField label="清晰度上限" hint="默认最清晰。限制高度会放弃更高分辨率。">
            <select
              className="input-text"
              value={config.ytdlpMaxHeight}
              onChange={(e) =>
                onChange({ ...config, ytdlpMaxHeight: Number(e.target.value) as YtdlpMaxHeight })
              }
            >
              {HEIGHT_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </FormField>

          <FormField label="附加参数" hint="按空格拆分为命令行参数，例如 --geo-bypass --sleep-interval 2">
            <Input
              value={config.ytdlpExtraArgs}
              onChange={(e) => onChange({ ...config, ytdlpExtraArgs: e.target.value })}
              placeholder="--geo-bypass"
            />
          </FormField>
        </details>

        <details id="settings-sharing" className="panel-box settings-collapsible lan-settings-panel" open>
          <summary className="panel-title settings-section-summary">
            <span className="settings-summary-copy"><h3>局域网文案分享</h3></span>
            <CaretDown size={16} weight="bold" />
          </summary>
          <FormField label="启用局域网分享"><div className="switch-field"><span className="switch-field-label">{config.lanEnabled ? '已启用' : '已关闭'}</span><Switch checked={config.lanEnabled} onCheckedChange={(checked) => onChange({ ...config, lanEnabled: checked })} /></div></FormField>
          <div className="settings-inline-grid"><FormField label="广播别名"><Input value={config.lanAlias} onChange={(e) => onChange({ ...config, lanAlias: e.target.value })} /></FormField><FormField label="服务端口"><Input type="number" min={1} max={65535} value={config.lanPort} onChange={(e) => onChange({ ...config, lanPort: Math.max(1, Number(e.target.value) || 53318) })} /></FormField></div>
          <FormField label="自动保存接收内容"><div className="switch-field"><span className="switch-field-label">{config.lanAutoSave ? '收到后直接保存' : '收到后询问'}</span><Switch checked={config.lanAutoSave} onCheckedChange={(checked) => onChange({ ...config, lanAutoSave: checked })} /></div></FormField>
          <FormField label="保存目录"><div className="settings-path-row"><Input value={config.lanSaveDirectory} onChange={(e) => onChange({ ...config, lanSaveDirectory: e.target.value })} /><Button type="button" variant="secondary" size="sm" onClick={() => void handleSelectPath('lanSaveDirectory', '选择分享保存目录')}>选择</Button></div></FormField>
          <FormField label="保存分享历史"><div className="switch-field"><span className="switch-field-label">{config.lanHistoryEnabled ? '已记录' : '不记录'}</span><Switch checked={config.lanHistoryEnabled} onCheckedChange={(checked) => onChange({ ...config, lanHistoryEnabled: checked })} /></div></FormField>
          <div className="lan-status-panel">
            <span className={lanStatus?.error ? 'lan-status-error' : ''}>服务状态：{lanStatus?.error ? `异常 · ${lanStatus.error}` : lanStatus?.enabled ? `运行中 · 端口 ${lanStatus.port}` : '未启用'}{lanStatus?.alias ? ` · ${lanStatus.alias}` : ''}</span>
            <span>设备指纹：{lanStatus?.fingerprint ?? '读取中…'}</span>
            <span>数据根目录：{appDataRoots?.userData ?? '读取中…'}</span>
          </div>
        </details>

        <details id="settings-advanced" className="panel-box settings-collapsible advanced-panel">
          <summary className="panel-title settings-section-summary">
            <span className="settings-summary-copy"><h3>高级</h3></span>
            <CaretDown size={16} weight="bold" />
          </summary>
          <div className="advanced-body">
              <div className="debug-mode-row">
                <div
                  className="switch-field"
                  onClick={() => onChange({ ...config, debugMode: !config.debugMode })}
                >
                  <span className="switch-field-label">调试模式</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(config.debugMode)}
                    className={`ui-switch ${config.debugMode ? 'on' : ''}`}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onChange({ ...config, debugMode: !config.debugMode })
                      }
                    }}
                  >
                    <span className="ui-switch-thumb" />
                  </button>
                </div>

                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  icon={<TerminalWindow size={16} weight="bold" />}
                  onClick={() => {
                    void window.koubox.openDevTools().then((opened) => {
                      if (!opened) {
                        window.alert('请先开启「调试模式」并点击「保存配置更改」，然后再打开开发者工具。')
                      }
                    })
                  }}
                >
                  打开开发者工具
                </Button>
              </div>

              <FormField label="最大并发任务数" hint="同时运行的流水线数量，受显存限制，建议从 1 开始。">
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={config.maxConcurrentTasks}
                  onChange={(e) =>
                    onChange({ ...config, maxConcurrentTasks: Math.max(1, Number(e.target.value) || 1) })
                  }
                />
              </FormField>

              {/* 翻译采样参数 — 功能暂时下架，保留配置字段
              <div className="settings-inline-grid">
                <FormField label="翻译 temperature">
                  <input
                    className="input-text"
                    type="number"
                    min={0}
                    max={2}
                    step={0.05}
                    value={config.translationTemperature}
                    onChange={(e) =>
                      onChange({ ...config, translationTemperature: Number(e.target.value) })
                    }
                  />
                </FormField>
                <FormField label="翻译 top_p">
                  <input
                    className="input-text"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={config.translationTopP}
                    onChange={(e) =>
                      onChange({ ...config, translationTopP: Number(e.target.value) })
                    }
                  />
                </FormField>
                <FormField label="翻译 max_new_tokens">
                  <input
                    className="input-text"
                    type="number"
                    min={1}
                    step={1}
                    value={config.translationMaxNewTokens}
                    onChange={(e) =>
                      onChange({
                        ...config,
                        translationMaxNewTokens: Math.max(1, Number(e.target.value) || 1)
                      })
                    }
                  />
                </FormField>
              </div>
              */}

              <FormField label="Whisper chunk_length_s" hint="长音频可适当增大；显存不足时可减小。">
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={config.whisperChunkLengthS}
                  onChange={(e) =>
                    onChange({
                      ...config,
                      whisperChunkLengthS: Math.max(1, Number(e.target.value) || 1)
                    })
                  }
                />
              </FormField>

              <FormField label="Python 运行环境" hint="固定使用 D:\\Project\\Koubox 主分支的 python/.venv，不支持切换或回退。">
                <div className="fixed-runtime-path" title={config.pythonExecutable}>
                  <span>{config.pythonExecutable}</span>
                  <small>主分支固定环境</small>
                </div>
              </FormField>

              {/* 隐藏的授权入口按钮 */}
              <div style={{ marginTop: '24px', display: 'flex', justifyContent: 'center' }}>
                <button
                  type="button"
                  className="secret-license-btn"
                  onClick={handleSecretClick}
                  aria-label="授权管理"
                >
                  {ripples.map(ripple => (
                    <span
                      key={ripple.id}
                      className="ripple"
                      style={{
                        left: ripple.x,
                        top: ripple.y
                      }}
                    />
                  ))}
                </button>
              </div>
          </div>
        </details>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            variant="primary"
            size="lg"
            type="submit"
          >
            保存配置更改
          </Button>
        </div>
      </form>

      {activeGuide && (
        <div className="guide-overlay" onClick={() => setGuide(null)}>
          <div
            className="guide-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="vendor-guide-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="guide-panel-head">
              <h3 id="vendor-guide-title">{activeGuide.title}</h3>
              <button type="button" className="guide-close-btn" onClick={() => setGuide(null)} aria-label="关闭说明">
                <X size={16} weight="bold" />
              </button>
            </div>
            <div className="guide-panel-body">
              <section>
                <h4>作用</h4>
                <p>{activeGuide.role}</p>
              </section>
              <section>
                <h4>去哪里下载</h4>
                <p>{activeGuide.download}</p>
                <a className="guide-link" href={activeGuide.downloadUrl} target="_blank" rel="noreferrer">
                  {activeGuide.downloadUrl}
                </a>
              </section>
              <section>
                <h4>下载后怎么放</h4>
                <p>{activeGuide.layout}</p>
              </section>
              <section>
                <h4>需要包含的文件</h4>
                <ul className="guide-file-list">
                  {activeGuide.files.map((file) => (
                    <li key={file}><code>{file}</code></li>
                  ))}
                </ul>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export { TARGET_LANGUAGE_OPTIONS }
