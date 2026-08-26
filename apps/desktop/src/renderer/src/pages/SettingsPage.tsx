import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  FloppyDisk,
  Question,
  X,
  CheckCircle,
  Warning,
  CaretDown,
  TerminalWindow,
  Globe,
  ArrowsClockwise,
  FloppyDiskBack,
  MagnifyingGlass,
  Trash
} from '@phosphor-icons/react'
import type {
  AsrLanguage,
  BrowserProfile,
  ChromeProfileLoginProbe,
  KouboxConfig,
  PlatformAuthMode,
  RuntimeStatus,
  TranslationTargetLanguage,
  VendorToolCheck,
  YtdlpCookiePlatformId,
  YtdlpCookieSource,
  YtdlpCookieStatus,
  YtdlpMaxHeight
} from '@koubox/shared'
import { defaultPlatformAuth, normalizeBrowserProfile } from '@koubox/shared'
import { Button } from '../components/common/Button'
import { FormField, PathPicker } from '../components/common/FormControls'

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

const COOKIE_SOURCE_OPTIONS: Array<{ value: YtdlpCookieSource; label: string }> = [
  { value: 'none', label: '公开解析（默认，无需账号）' },
  { value: 'builtin', label: '公开解析失败后按平台登录兜底' },
  { value: 'file', label: '统一 Cookies 文件（高级）' }
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

type LoginProbeUi = {
  state: 'idle' | 'probing' | 'logged-in' | 'logged-out' | 'error'
  detail: string
}

type AppDataRoots = {
  mode: 'development' | 'packaged'
  userData: string
  logs: string
}

type ClearAppCacheResult = {
  cancelled: boolean
  cleared: string[]
  failed: Array<{ path: string; error: string }>
  roots: AppDataRoots
  config?: KouboxConfig
}

function idleProbe(): LoginProbeUi {
  return { state: 'idle', detail: '' }
}

/** HTML <option value> cannot reliably hold U+0000; use a Windows-illegal separator. */
function browserProfileKey(profile: Pick<BrowserProfile, 'browser' | 'userDataDirectory' | 'profileDirectory' | 'bitBrowserId'>): string {
  const bitId = profile.bitBrowserId?.trim() || ''
  return `${profile.browser}|${profile.userDataDirectory}|${profile.profileDirectory}|${bitId}`
}

function normalizeCookieSource(source: YtdlpCookieSource | 'chrome' | 'edge'): YtdlpCookieSource {
  if (source === 'builtin' || source === 'none' || source === 'file') return source
  return 'builtin'
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
    download: '前往 GitHub Releases 下载 Windows 可执行文件 yt-dlp.exe。',
    downloadUrl: 'https://github.com/yt-dlp/yt-dlp/releases',
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
  const complete = check.missingFiles.length === 0
  return (
    <div className={`vendor-integrity ${complete && check.ready ? 'ok' : 'warn'}`}>
      <div className="vendor-integrity-head">
        {complete && check.ready ? <CheckCircle size={15} weight="fill" /> : <Warning size={15} weight="fill" />}
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
      {check.missingFiles.length === 0 && check.ready && (
        <div className="vendor-integrity-ok">清单完整，运行时可用</div>
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
  onShowToast
}: SettingsPageProps) {
  const [guide, setGuide] = useState<GuideKind | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [openingLogin, setOpeningLogin] = useState(false)
  const [savingCookies, setSavingCookies] = useState(false)
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
  const [browserProfiles, setBrowserProfiles] = useState<BrowserProfile[]>([])
  const [scanningBrowserProfiles, setScanningBrowserProfiles] = useState(false)
  const [loginProbes, setLoginProbes] = useState<Partial<Record<YtdlpCookiePlatformId, LoginProbeUi>>>({})
  const [probingPlatformId, setProbingPlatformId] = useState<YtdlpCookiePlatformId | null>(null)
  const [probingAllProfiles, setProbingAllProfiles] = useState(false)
  const [appDataRoots, setAppDataRoots] = useState<AppDataRoots | null>(null)
  const [clearingCache, setClearingCache] = useState(false)
  const activeGuide = guide ? guides[guide] : null
  const cookieSource = normalizeCookieSource(config.ytdlpCookieSource as YtdlpCookieSource | 'chrome' | 'edge')
  const platformAuth = config.ytdlpPlatformAuth ?? defaultPlatformAuth()
  const usePlatformAuth = cookieSource === 'builtin'
  const anyBuiltinPlatform = PLATFORM_AUTH_OPTIONS.some((item) => platformAuth[item.id].mode === 'builtin')
  const platformBrowserProfiles = config.platformBrowserProfiles ?? {}

  const probeFor = (id: YtdlpCookiePlatformId): LoginProbeUi => loginProbes[id] ?? idleProbe()

  const scanBrowserProfiles = async () => {
    setScanningBrowserProfiles(true)
    try {
      const profiles = await window.koubox.get<BrowserProfile[]>('/browser/profiles')
      setBrowserProfiles(profiles)
      onShowToast(profiles.length ? `已发现 ${profiles.length} 个浏览器配置（Chrome / 比特）。` : '未发现可用的 Chrome / 比特浏览器配置。', profiles.length ? 'success' : 'warning')
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '扫描浏览器配置失败', 'error')
    } finally {
      setScanningBrowserProfiles(false)
    }
  }

  const selectBrowserProfile = (id: YtdlpCookiePlatformId, profileKey: string) => {
    const selected = browserProfiles.find((item) => browserProfileKey(item) === profileKey)
    const next = { ...platformBrowserProfiles }
    if (selected) next[id] = normalizeBrowserProfile(selected)
    else delete next[id]
    onChange({ ...config, platformBrowserProfiles: next })
    setLoginProbes((prev) => ({ ...prev, [id]: idleProbe() }))
  }

  const probePlatformLogin = async (id: YtdlpCookiePlatformId, options?: { silentToast?: boolean }): Promise<boolean> => {
    const profile = platformBrowserProfiles[id]
    if (!profile) {
      setLoginProbes((prev) => ({
        ...prev,
        [id]: { state: 'error', detail: '请先为该平台选择 Chrome 配置文件。' }
      }))
      if (!options?.silentToast) {
        onShowToast(`请先选择 ${PLATFORM_AUTH_OPTIONS.find((item) => item.id === id)?.label ?? id} 的配置文件。`, 'warning')
      }
      return false
    }
    setProbingPlatformId(id)
    setLoginProbes((prev) => ({
      ...prev,
      [id]: { state: 'probing', detail: `正在打开 ${PLATFORM_AUTH_OPTIONS.find((item) => item.id === id)?.label ?? id} 首页检测登录…` }
    }))
    try {
      const result = await Promise.race([
        window.koubox.post<ChromeProfileLoginProbe>('/browser/profiles/probe-login', {
          platformId: id,
          profile,
          proxy: config.ytdlpProxy
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('登录检测超时（20 秒）。请关闭占用该配置的浏览器，检查代理后重试。')), 20_000)
        })
      ])
      setLoginProbes((prev) => ({
        ...prev,
        [id]: {
          state: result.loggedIn ? 'logged-in' : 'logged-out',
          detail: result.detail
        }
      }))
      if (!options?.silentToast) onShowToast(result.detail, result.loggedIn ? 'success' : 'warning')
      return result.loggedIn
    } catch (error) {
      const detail = error instanceof Error ? error.message : '登录检测失败'
      setLoginProbes((prev) => ({ ...prev, [id]: { state: 'error', detail } }))
      if (!options?.silentToast) onShowToast(detail, 'error')
      return false
    } finally {
      setProbingPlatformId(null)
    }
  }

  const probeAllSelectedLogins = async () => {
    const selectedIds = PLATFORM_AUTH_OPTIONS.map((item) => item.id).filter((id) => platformBrowserProfiles[id])
    if (selectedIds.length === 0) {
      onShowToast('请先为至少一个平台选择 Chrome 配置文件。', 'warning')
      return
    }
    setProbingAllProfiles(true)
    try {
      let loggedInCount = 0
      for (const id of selectedIds) {
        if (await probePlatformLogin(id, { silentToast: true })) loggedInCount += 1
      }
      onShowToast(`检测完成：${loggedInCount}/${selectedIds.length} 个平台已登录。`, loggedInCount === selectedIds.length ? 'success' : 'warning')
    } finally {
      setProbingAllProfiles(false)
    }
  }

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
      const saved = await window.koubox.put<KouboxConfig>('/config', config)
      onChange(saved)
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
    if (!usePlatformAuth) {
      setCookieStatus(null)
      return
    }
    void refreshCookieStatus()
  }, [usePlatformAuth])

  useEffect(() => {
    void window.koubox.get<AppDataRoots>('/system/data-roots')
      .then((roots) => setAppDataRoots(roots))
      .catch(() => setAppDataRoots(null))
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
      setBrowserProfiles([])
      setLoginProbes({})
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
    key: 'ytdlpCookiesPath' | 'pythonExecutable',
    title: string,
    filters?: FileFilter[]
  ) => {
    const picked = await onChooseFile(title, config[key] || undefined, filters)
    if (picked) onChange({ ...config, [key]: picked })
  }

  const handleSavePlatformAuth = async () => {
    setSavingPlatformAuth(true)
    try {
      const saved = await window.koubox.put<KouboxConfig>('/config', config)
      onChange(saved)
      onShowToast('平台登录配置已保存。', 'success')
      if (usePlatformAuth) await refreshCookieStatus()
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '保存平台登录配置失败', 'error')
    } finally {
      setSavingPlatformAuth(false)
    }
  }

  const handleOpenLoginWindow = async () => {
    setOpeningLogin(true)
    try {
      const nextConfig: KouboxConfig = {
        ...config,
        ytdlpCookieSource: 'none',
        ytdlpCookiesPath: ''
      }
      onChange(nextConfig)
      const saved = await window.koubox.put<KouboxConfig>('/config', nextConfig)
      onChange(saved)
      await window.koubox.post<{ ok: boolean }>('/browser/open-login')
      onShowToast('已打开登录窗口。请依次登录各平台，完成后点「保存登录状态」。', 'success')
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '打开登录窗口失败', 'error')
    } finally {
      setOpeningLogin(false)
    }
  }

  const handleSaveLoginCookies = async () => {
    setSavingCookies(true)
    try {
      const status = await window.koubox.post<YtdlpCookieStatus>('/browser/export-cookies')
      setCookieStatus(status)
      onShowToast('登录状态已保存，可直接开始下载。', 'success')
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '保存登录状态失败', 'error')
    } finally {
      setSavingCookies(false)
    }
  }

  return (
    <div className="page-container" style={{ maxWidth: 840 }}>
      <div className="page-header-block">
        <h1>全局设置</h1>
        <p>配置输出目录、语种默认值、下载参数，以及高级运行选项</p>
      </div>

      <form className="settings-form-stack" onSubmit={onSave}>
        <div className="panel-box">
          <div className="panel-title">
            <h3>文件与存储路径</h3>
            <span className="panel-title-badge">本地配置</span>
          </div>

          <FormField
            label="默认成果输出目录"
            hint="下载的素材、提取的音频以及生成的 SRT 默认归档到此目录。ASR 与翻译模型路径在「模型与环境」中单独设置。"
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
            hint={
              appDataRoots
                ? `${appDataRoots.mode === 'packaged' ? '打包模式' : '开发模式'}：日志在 ${appDataRoots.logs}；用户数据在 ${appDataRoots.userData}。会清理登录状态与任务记录；磁盘 Cache 下次启动清干净。不会删除模型、工具与输出视频。`
                : '清理缓存、登录状态与任务记录。不会删除模型、工具与输出视频。'
            }
          >
            <Button
              type="button"
              variant="secondary"
              size="md"
              className="btn-clear-cache"
              loading={clearingCache}
              icon={<Trash size={16} weight="bold" />}
              onClick={() => void handleClearCache()}
            >
              {clearingCache ? '清理中…' : '清理缓存与临时数据'}
            </Button>
          </FormField>

          <FormField
            label="yt-dlp 目录"
            labelAction={(
              <button type="button" className="field-help-btn" onClick={() => setGuide('ytdlp')} title="查看说明">
                <Question size={15} weight="bold" />
                说明
              </button>
            )}
            hint="目录内需包含 yt-dlp.exe。"
          >
            <PathPicker
              value={config.ytdlpDirectory}
              onChange={(val) => onChange({ ...config, ytdlpDirectory: val })}
              onBrowse={() => handleSelectPath('ytdlpDirectory', '选择 yt-dlp 所在目录')}
              placeholder="例如 D:/Project/Koubox/vendor/yt-dlp"
            />
            <VendorIntegrity check={runtime?.vendor.ytdlp} />
          </FormField>

          <FormField
            label="FFmpeg 目录"
            labelAction={(
              <button type="button" className="field-help-btn" onClick={() => setGuide('ffmpeg')} title="查看说明">
                <Question size={15} weight="bold" />
                说明
              </button>
            )}
            hint="通常选择 ffmpeg 解压后的 bin 目录。"
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

        <div className="panel-box">
          <div className="panel-title">
            <h3>任务默认</h3>
            <span className="panel-title-badge">语种与行为</span>
          </div>

          <FormField label="翻译目标语言" hint="需求 1 翻译时的默认目标语种，任务页可临时覆盖。">
            <select
              className="input-text"
              value={config.translationTargetLanguage}
              onChange={(e) =>
                onChange({
                  ...config,
                  translationTargetLanguage: e.target.value as TranslationTargetLanguage
                })
              }
            >
              {TARGET_LANGUAGE_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </FormField>

          <FormField label="ASR 语种" hint="Whisper 识别语种。繁体/简体在识别阶段均映射为中文，翻译阶段再区分。">
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

          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={config.openOutputOnComplete}
              onChange={(e) => onChange({ ...config, openOutputOnComplete: e.target.checked })}
            />
            <span>任务完成后自动打开输出文件夹</span>
          </label>
        </div>

        <div className="panel-box">
          <div className="panel-title">
            <h3>下载与浏览器账号</h3>
            <span className="panel-title-badge">直连优先</span>
          </div>

          <FormField label="代理地址" hint="例如 http://127.0.0.1:7897；Facebook 的页面解析、Chrome 配置文件解析和媒体下载共用此代理。">
            <input
              className="input-text"
              value={config.ytdlpProxy}
              onChange={(e) => onChange({ ...config, ytdlpProxy: e.target.value })}
              placeholder="http://127.0.0.1:7897"
            />
          </FormField>

          <FormField
            label="Chrome 浏览器账号"
            hint="扫描本机 Chrome 与比特浏览器配置后按平台选择；点「检测登录」会打开对应首页核对会话。应用只保存路径。比特需保持客户端运行（本地 API）。"
          >
            <div className="chrome-account-panel">
              <div className="chrome-account-toolbar">
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  loading={scanningBrowserProfiles}
                  icon={<ArrowsClockwise size={16} weight="bold" />}
                  onClick={() => void scanBrowserProfiles()}
                >
                  {scanningBrowserProfiles ? '扫描中…' : '扫描配置文件'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  loading={probingAllProfiles}
                  disabled={scanningBrowserProfiles || probingPlatformId !== null}
                  icon={<MagnifyingGlass size={16} weight="bold" />}
                  onClick={() => void probeAllSelectedLogins()}
                >
                  {probingAllProfiles ? '检测中…' : '检测已选平台'}
                </Button>
                <span className="chrome-account-scan-meta">
                  {browserProfiles.length > 0 ? `已发现 ${browserProfiles.length} 个配置` : '尚未扫描'}
                </span>
              </div>

              <div className="chrome-account-list">
                {PLATFORM_AUTH_OPTIONS.map((platform) => {
                  const selected = platformBrowserProfiles[platform.id]
                  const selectedKey = selected ? browserProfileKey(selected) : ''
                  const probe = probeFor(platform.id)
                  const busy = probingPlatformId === platform.id || probingAllProfiles
                  return (
                    <div key={platform.id} className={`chrome-account-row chrome-account-row--${probe.state}`}>
                      <strong className="chrome-account-platform">{platform.label}</strong>
                      <select
                        className="input-text"
                        value={selectedKey}
                        disabled={busy}
                        onChange={(event) => selectBrowserProfile(platform.id, event.target.value)}
                        aria-label={`${platform.label} 浏览器配置文件`}
                      >
                        <option value="">未选择配置文件</option>
                        {browserProfiles.map((profile) => {
                          const key = browserProfileKey(profile)
                          return <option key={key} value={key}>{profile.label}</option>
                        })}
                        {selected && !browserProfiles.some((profile) => browserProfileKey(profile) === selectedKey) && (
                          <option value={selectedKey}>{selected.label}（已保存，待重新扫描）</option>
                        )}
                      </select>
                      <Button
                        type="button"
                        variant="secondary"
                        size="md"
                        loading={probingPlatformId === platform.id}
                        disabled={busy && probingPlatformId !== platform.id}
                        icon={<MagnifyingGlass size={16} weight="bold" />}
                        onClick={() => void probePlatformLogin(platform.id)}
                      >
                        检测登录
                      </Button>
                      <span className={`chrome-account-badge chrome-account-badge--${probe.state}`}>
                        {probe.state === 'idle' && '未检测'}
                        {probe.state === 'probing' && '检测中'}
                        {probe.state === 'logged-in' && '已登录'}
                        {probe.state === 'logged-out' && '未登录'}
                        {probe.state === 'error' && '检测失败'}
                      </span>
                      {probe.detail ? (
                        <p className="chrome-account-row-detail">{probe.detail}</p>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
          </FormField>

          <FormField
            label="Facebook 下载策略"
            hint="固定为：公开页面直连 → 已选 Chrome 配置文件 → FFmpeg stream copy。Facebook 不调用 yt-dlp，不重编码视频或音频。"
          >
            <div className="vendor-integrity-ok">已启用 Facebook 原画直连链路</div>
          </FormField>

          {false && usePlatformAuth && (
            <>
              {anyBuiltinPlatform && (
                <div className="platform-auth-toolbar">
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    loading={openingLogin}
                    icon={<Globe size={16} weight="bold" />}
                    onClick={() => void handleOpenLoginWindow()}
                  >
                    打开登录窗口
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    loading={savingCookies}
                    icon={<FloppyDiskBack size={16} weight="bold" />}
                    onClick={() => void handleSaveLoginCookies()}
                  >
                    保存应用内登录
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    loading={checkingCookies}
                    icon={cookieCheckCompleted ? <CheckCircle size={16} weight="fill" /> : <ArrowsClockwise size={16} weight="bold" />}
                    onClick={() => void refreshCookieStatus()}
                  >
                    {cookieCheckCompleted
                      ? '检测完成'
                      : checkingCookies
                        ? '检测中…'
                        : '检测登录状态'}
                  </Button>
                </div>
              )}

              {!anyBuiltinPlatform && (
                <div className="platform-auth-toolbar">
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    loading={checkingCookies}
                    icon={cookieCheckCompleted ? <CheckCircle size={16} weight="fill" /> : <ArrowsClockwise size={16} weight="bold" />}
                    onClick={() => void refreshCookieStatus()}
                  >
                    {cookieCheckCompleted
                      ? '检测完成'
                      : checkingCookies
                        ? '检测中…'
                        : '检测粘贴 Cookie'}
                  </Button>
                </div>
              )}

              {cookieStatus && (
                <div className="cookie-status-panel">
                  <div className="cookie-status-head">
                    <span>
                      应用内会话 {cookieStatus!.cookieCount} 个 cookie
                      {cookieStatus!.exported && cookieStatus!.exportedAt
                        ? ` · 已导出 ${new Date(cookieStatus!.exportedAt!).toLocaleString()}`
                        : ''}
                    </span>
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
                            <p className="field-hint">
                              下载 {platform.label} 时使用应用内登录窗口保存的会话。点上方「打开登录窗口」完成登录并保存。
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="platform-auth-save">
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  loading={savingPlatformAuth}
                  icon={<FloppyDiskBack size={16} weight="bold" />}
                  onClick={() => void handleSavePlatformAuth()}
                >
                  保存平台登录配置
                </Button>
              </div>
            </>
          )}

          {false && cookieSource === 'file' && (
            <FormField label="Cookies 文件" hint="Netscape cookies.txt，所有平台共用这一份。">
              <PathPicker
                value={config.ytdlpCookiesPath}
                onChange={(val) => onChange({ ...config, ytdlpCookiesPath: val })}
                onBrowse={() =>
                  handleSelectFile('ytdlpCookiesPath', '选择 cookies 文件', [
                    { name: 'Cookies', extensions: ['txt'] },
                    { name: '所有文件', extensions: ['*'] }
                  ])
                }
                placeholder="例如 D:/cookies.txt"
              />
            </FormField>
          )}

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
            <input
              className="input-text"
              value={config.ytdlpExtraArgs}
              onChange={(e) => onChange({ ...config, ytdlpExtraArgs: e.target.value })}
              placeholder="--geo-bypass"
            />
          </FormField>
        </div>

        <div className={`panel-box advanced-panel ${advancedOpen ? 'open' : ''}`}>
          <button
            type="button"
            className="advanced-toggle"
            onClick={() => setAdvancedOpen((open) => !open)}
            aria-expanded={advancedOpen}
          >
            <span>
              <strong>高级</strong>
              <small>调试、并发、翻译采样、Whisper chunk、Python 路径</small>
            </span>
            <CaretDown size={16} weight="bold" className={advancedOpen ? 'rotated' : ''} />
          </button>

          {advancedOpen && (
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
                <input
                  className="input-text"
                  type="number"
                  min={1}
                  step={1}
                  value={config.maxConcurrentTasks}
                  onChange={(e) =>
                    onChange({ ...config, maxConcurrentTasks: Math.max(1, Number(e.target.value) || 1) })
                  }
                />
              </FormField>

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

              <FormField label="Whisper chunk_length_s" hint="长音频可适当增大；显存不足时可减小。">
                <input
                  className="input-text"
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

              <FormField label="Python 可执行文件" hint="留空则使用打包内置解释器或开发环境的 uv。">
                <PathPicker
                  value={config.pythonExecutable}
                  onChange={(val) => onChange({ ...config, pythonExecutable: val })}
                  onBrowse={() =>
                    handleSelectFile('pythonExecutable', '选择 python.exe', [
                      { name: 'Python', extensions: ['exe'] },
                      { name: '所有文件', extensions: ['*'] }
                    ])
                  }
                  placeholder="例如 C:/Python312/python.exe"
                />
              </FormField>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            variant="primary"
            size="lg"
            type="submit"
            icon={<FloppyDisk size={18} weight="bold" />}
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
