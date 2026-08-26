export type ToolId = 'viral-materials' | 'precise-srt' | 'video-downloader'

export type ToolManifest = {
  id: ToolId
  name: string
  description: string
  accent: 'teal' | 'blue'
  artifactTags: string[]
  menus: Array<{ id: string; label: string }>
}

export const tools: ToolManifest[] = [
  {
    id: 'viral-materials',
    name: '爆款素材获取',
    description: '输入视频链接，下载视频、抽取音频、识别原文并进行本地翻译。',
    accent: 'teal',
    artifactTags: ['URL', 'Video', 'Audio', 'Transcript', 'Translation'],
    menus: [
      { id: 'run', label: '开始处理' },
      { id: 'history', label: '任务中心' }
    ]
  },
  {
    id: 'precise-srt',
    name: '精准 SRT 对齐（待完成）',
    description: '（功能暂未实现）导入音频和可选原文，输出可直接导入剪映的标准 SRT。',
    accent: 'blue',
    artifactTags: ['Audio', 'Transcript', 'Text', 'SRT'],
    menus: [
      { id: 'run', label: '开始对齐' },
      { id: 'history', label: '任务中心' }
    ]
  },
  {
    id: 'video-downloader',
    name: '视频下载',
    description: '粘贴 YouTube / Facebook / Instagram / TikTok 公开链接，下载视频到本地。',
    accent: 'teal',
    artifactTags: ['URL', 'Video'],
    menus: [
      { id: 'run', label: '开始下载' },
      { id: 'history', label: '任务中心' }
    ]
  }
]

export type TranscriptSegment = {
  text: string
  start: number
  end: number
}

export type Transcript = {
  language?: string
  segments: TranscriptSegment[]
}

export type ModelCheck = {
  id: string
  label: string
  directory: string
  format: 'transformers' | 'ctranslate2'
  ready: boolean
  configured: boolean
  expectedFiles: number
  foundFiles: number
  missingFiles: string[]
}

export type GpuStatus = {
  available: boolean
  name?: string
  totalMemoryMiB?: number
  usedMemoryMiB?: number
  freeMemoryMiB?: number
  message: string
}

export type VendorToolCheck = {
  ready: boolean
  directory: string
  executable: string
  expectedFiles: string[]
  foundFiles: string[]
  missingFiles: string[]
}

export type RuntimeStatus = {
  healthy: boolean
  startedAt: string
  gpu: GpuStatus
  models: ModelCheck[]
  vendor: {
    ytdlp: VendorToolCheck
    ffmpeg: VendorToolCheck
  }
}

export type TaskKind = 'req1' | 'req2' | 'download'
export type RequirementTwoMode = 'align' | 'asr-only'
export type TaskStage = 'queued' | 'download' | 'extract-audio' | 'separate-vocals' | 'asr' | 'align' | 'export-srt' | 'translation' | 'complete' | 'error' | 'cancelled'
export type TaskStatus = 'queued' | 'running' | 'complete' | 'error' | 'cancelled'

export type KouboxPlatform = 'YouTube' | 'TikTok' | 'Instagram' | 'Facebook' | 'Twitter' | 'Bilibili' | 'Douyin' | 'Video' | 'Audio'

export function detectPlatform(url: string): KouboxPlatform {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host.includes('youtu')) return 'YouTube'
    if (host.includes('tiktok')) return 'TikTok'
    if (host.includes('instagram')) return 'Instagram'
    if (host.includes('twitter') || host === 'x.com' || host.endsWith('.x.com')) return 'Twitter'
    if (host.includes('facebook') || host.includes('fb.watch')) return 'Facebook'
    if (host.includes('bilibili')) return 'Bilibili'
    if (host.includes('douyin')) return 'Douyin'
  } catch { /* local audio or legacy task */ }
  return 'Video'
}

/** 爆款素材获取 / 视频下载 共用的可下载平台 */
export const DOWNLOADABLE_VIDEO_PLATFORMS = ['YouTube', 'TikTok', 'Instagram', 'Facebook'] as const
export type DownloadableVideoPlatform = (typeof DOWNLOADABLE_VIDEO_PLATFORMS)[number]

export function isDownloadableVideoPlatform(platform: KouboxPlatform): platform is DownloadableVideoPlatform {
  return (DOWNLOADABLE_VIDEO_PLATFORMS as readonly string[]).includes(platform)
}

/** 校验链接后返回 trim 后的 URL；不合法直接抛错 */
export function assertDownloadableVideoUrl(url: string): { url: string; platform: DownloadableVideoPlatform } {
  const trimmed = url.trim()
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('请输入合法的视频链接（http/https）。')
  }
  const platform = detectPlatform(trimmed)
  if (!isDownloadableVideoPlatform(platform)) {
    throw new Error('仅支持 YouTube / Facebook / Instagram / TikTok。')
  }
  return { url: trimmed, platform }
}

/** 爆款素材获取：本地上传视频允许的扩展名 */
export const LOCAL_VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'flv'] as const

/** 校验本地视频路径（只校验路径与扩展名；是否存在由调用方用 fs 检查） */
export function assertLocalVideoPath(filePath: string): string {
  const trimmed = normalizeOsPath(filePath.trim())
  if (!trimmed) throw new Error('请选择本地视频文件。')
  const base = trimmed.replace(/^.*[/\\]/, '')
  const dot = base.lastIndexOf('.')
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : ''
  if (!(LOCAL_VIDEO_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new Error(`仅支持常见视频格式：${LOCAL_VIDEO_EXTENSIONS.join(' / ')}。`)
  }
  return trimmed
}

/** 爆款素材获取的视频来源：链接下载或本地上传 */
export type MaterialsSourceMode = 'url' | 'local'

/** 桌面端/任务共用的下载管线路径 */
export const VIDEO_DOWNLOAD_PIPELINE_PATH = '/pipelines/download'
export const VIDEO_MATERIALS_PIPELINE_PATH = '/pipelines/req1'

export type TaskArtifacts = {
  video?: string
  sourceAudio?: string
  audio?: string
  vocals?: string
  transcript?: string
  transcriptText?: string
  translation?: string
  translationText?: string
  srt?: string
}

export type TaskError = {
  code: string
  message: string
}

export type TaskSnapshot = {
  taskId: string
  kind: TaskKind
  mode?: RequirementTwoMode
  /** req1：链接下载或本地上传；缺省按 url 以 http(s) 判断 */
  sourceMode?: MaterialsSourceMode
  status: TaskStatus
  stage: TaskStage
  percent: number
  message: string
  /** 链接 URL，或本地视频绝对路径（sourceMode=local） */
  url: string
  sourceText?: string
  outputDirectory: string
  taskDirectory: string
  language?: string
  transcript?: Transcript
  translation?: string
  translationLines?: string[]
  artifacts: TaskArtifacts
  error?: TaskError
  createdAt: string
  updatedAt: string
}

export type TaskEvent = {
  type: 'snapshot'
  task: TaskSnapshot
}

export type TranslationTargetLanguage = 'zh-Hans' | 'zh-Hant' | 'en' | 'ja' | 'ko'
export type AsrLanguage = 'auto' | TranslationTargetLanguage
export type YtdlpMaxHeight = 0 | 1080 | 720 | 480
export type YtdlpCookieSource = 'builtin' | 'none' | 'file'
export type YtdlpCookiePlatformId = 'youtube' | 'tiktok' | 'instagram' | 'facebook'
export type PlatformAuthMode = 'builtin' | 'paste'

/** A Chrome / 比特浏览器 profile selected by the user; no cookie text is persisted. */
export type BrowserProfile = {
  browser: 'chrome' | 'bitbrowser'
  userDataDirectory: string
  profileDirectory: string
  label: string
  /** 比特浏览器窗口 ID，用于本地 API 读取 Cookie */
  bitBrowserId?: string
}

export type PlatformBrowserProfiles = Partial<Record<YtdlpCookiePlatformId, BrowserProfile>>

export function defaultPlatformBrowserProfiles(): PlatformBrowserProfiles {
  return {}
}

export type PlatformAuthEntry = {
  mode: PlatformAuthMode
  cookies: string
}

export type PlatformAuthConfig = Record<YtdlpCookiePlatformId, PlatformAuthEntry>

export function defaultPlatformAuth(): PlatformAuthConfig {
  return {
    youtube: { mode: 'builtin', cookies: '' },
    tiktok: { mode: 'builtin', cookies: '' },
    instagram: { mode: 'paste', cookies: '' },
    facebook: { mode: 'builtin', cookies: '' }
  }
}

export function platformAuthIdFromUrlPlatform(platform: KouboxPlatform): YtdlpCookiePlatformId | undefined {
  if (platform === 'YouTube') return 'youtube'
  if (platform === 'TikTok') return 'tiktok'
  if (platform === 'Instagram') return 'instagram'
  if (platform === 'Facebook') return 'facebook'
  return undefined
}

export type PlatformCookieRule = {
  id: YtdlpCookiePlatformId
  label: string
  domainTest: RegExp
  requiredNames: string[]
}

export const PLATFORM_COOKIE_RULES: PlatformCookieRule[] = [
  {
    id: 'youtube',
    label: 'YouTube',
    domainTest: /(?:^|\.)(youtube\.com|google\.com)$/i,
    requiredNames: ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID']
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    domainTest: /(?:^|\.)tiktok\.com$/i,
    requiredNames: ['sessionid', 'sid_tt']
  },
  {
    id: 'instagram',
    label: 'Instagram',
    domainTest: /(?:^|\.)instagram\.com$/i,
    requiredNames: ['sessionid', 'ds_user_id']
  },
  {
    id: 'facebook',
    label: 'Facebook',
    domainTest: /(?:^|\.)(facebook\.com|fb\.com)$/i,
    requiredNames: ['c_user', 'xs']
  }
]

export function pastedCookieNamesFromNetscape(text: string, domainTest: RegExp): Set<string> {
  const names = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    if (!line) continue
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
    else if (line.startsWith('#')) continue
    const parts = line.split('\t')
    if (parts.length < 7) continue
    const domain = (parts[0] ?? '').replace(/^\./, '')
    const name = parts[5]
    if (!domain || !name) continue
    if (!domainTest.test(domain)) continue
    names.add(name)
  }
  return names
}

export function assertPastedPlatformCookies(platformId: YtdlpCookiePlatformId, text: string): void {
  const rule = PLATFORM_COOKIE_RULES.find((item) => item.id === platformId)
  if (!rule) throw new Error(`未知平台：${platformId}`)
  const names = pastedCookieNamesFromNetscape(text, rule.domainTest)
  const missing = rule.requiredNames.filter((name) => !names.has(name))
  if (missing.length > 0) {
    throw new Error(`${rule.label} Cookie 不完整：缺少 ${missing.join(' / ')}。请用浏览器插件重新导出后粘贴。`)
  }
}

export function pastedPlatformCookiesReady(platformId: YtdlpCookiePlatformId, text: string): { ok: boolean; detail: string } {
  try {
    assertPastedPlatformCookies(platformId, text)
    const rule = PLATFORM_COOKIE_RULES.find((item) => item.id === platformId)!
    return { ok: true, detail: `粘贴的 Cookie 含 ${rule.requiredNames.length} 个关键字段` }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

export function platformLabel(platformId: YtdlpCookiePlatformId): string {
  return PLATFORM_COOKIE_RULES.find((item) => item.id === platformId)?.label ?? platformId
}

/** 从错误原文或 URL 里识别需要登录提示的平台 */
export function detectAuthPlatformFromText(text: string): YtdlpCookiePlatformId | undefined {
  if (/instagram\.com|\[instagram\]/i.test(text)) return 'instagram'
  if (/tiktok\.com|\[tiktok\]/i.test(text)) return 'tiktok'
  if (/facebook\.com|fb\.watch|\[facebook\]/i.test(text)) return 'facebook'
  if (/youtube\.com|youtu\.be|\[youtube\]/i.test(text)) return 'youtube'
  return undefined
}

export function platformAuthMissingMessage(
  platformId: YtdlpCookiePlatformId,
  mode: PlatformAuthMode,
  reason: 'empty-paste' | 'no-builtin-export' | 'builtin-incomplete' | 'login-required'
): string {
  const label = platformLabel(platformId)
  if (mode === 'paste' || reason === 'empty-paste') {
    if (reason === 'empty-paste') {
      return `${label} 已选「粘贴 Cookie」，但尚未粘贴内容。请到「全局设置 → 平台登录」展开 ${label}，粘贴后保存。`
    }
    return `${label} 登录态无效或 Cookie 未生效。请用插件重新导出 ${label} Cookie，粘贴到「全局设置 → 平台登录」后保存，再重试。`
  }
  if (reason === 'no-builtin-export') {
    return `${label} 当前为「应用内登录」，但尚未保存登录状态。请到「全局设置 → 平台登录」打开登录窗口，登录 ${label} 后点击「保存应用内登录」。`
  }
  if (reason === 'builtin-incomplete') {
    return `${label} 当前为「应用内登录」，但已保存的登录里缺少 ${label} Cookie。请打开登录窗口登录 ${label}，再点「保存应用内登录」。`
  }
  return `${label} 需要有效登录才能下载。请到「全局设置 → 平台登录」为 ${label} 配置「应用内登录」或「粘贴 Cookie」后重试。`
}

export type YtdlpCookiePlatformStatus = {
  id: YtdlpCookiePlatformId
  label: string
  loggedIn: boolean
  detail: string
}

export type YtdlpCookieStatus = {
  exported: boolean
  exportedAt?: string
  cookieCount: number
  platforms: YtdlpCookiePlatformStatus[]
}

/** Chrome 配置文件进平台首页后的登录检测结果 */
export type ChromeProfileLoginProbe = {
  platformId: YtdlpCookiePlatformId
  label: string
  loggedIn: boolean
  detail: string
  homepage: string
  finalUrl: string
  profileLabel: string
}

export const PLATFORM_HOMEPAGES: Record<YtdlpCookiePlatformId, string> = {
  youtube: 'https://www.youtube.com/',
  tiktok: 'https://www.tiktok.com/',
  instagram: 'https://www.instagram.com/',
  facebook: 'https://www.facebook.com/'
}

export type KouboxConfig = {
  modelsDirectory: string
  outputDirectory: string
  asrModelDirectory: string
  translationModelDirectory: string
  demucsModelDirectory: string
  ytdlpDirectory: string
  ffmpegDirectory: string
  translationTargetLanguage: TranslationTargetLanguage
  asrLanguage: AsrLanguage
  openOutputOnComplete: boolean
  ytdlpProxy: string
  ytdlpCookieSource: YtdlpCookieSource
  ytdlpCookiesPath: string
  /** 各平台独立：应用内登录 / 粘贴 Cookie */
  ytdlpPlatformAuth: PlatformAuthConfig
  /** 各平台独立选择本机 Chrome 配置文件，不保存或展示 Cookie。 */
  platformBrowserProfiles: PlatformBrowserProfiles
  ytdlpMaxHeight: YtdlpMaxHeight
  ytdlpExtraArgs: string
  maxConcurrentTasks: number
  translationTemperature: number
  translationMaxNewTokens: number
  translationTopP: number
  whisperChunkLengthS: number
  pythonExecutable: string
  debugMode: boolean
}

export type ApiError = { error: string; detail?: string }

/**
 * Japanese Windows often displays / copies backslash (U+005C) as yen (¥ U+00A5)
 * or fullwidth yen (￥ U+FFE5). Node only treats `\` and `/` as separators, so
 * normalize those glyphs before join / existsSync / open.
 */
export function normalizeOsPath(input: string): string {
  return input.replace(/\u00A5/g, '\\').replace(/\uFFE5/g, '\\')
}

export function normalizeBrowserProfile(profile: BrowserProfile): BrowserProfile {
  const next: BrowserProfile = {
    ...profile,
    userDataDirectory: normalizeOsPath(profile.userDataDirectory.trim()),
    profileDirectory: normalizeOsPath(profile.profileDirectory.trim())
  }
  if (profile.bitBrowserId) next.bitBrowserId = profile.bitBrowserId.trim()
  return next
}

/** Normalize every filesystem path field on KouboxConfig (JP Windows ¥/￥ → `\`). */
export function normalizeKouboxConfigPaths(config: KouboxConfig): KouboxConfig {
  const platformBrowserProfiles: PlatformBrowserProfiles = {}
  for (const [id, profile] of Object.entries(config.platformBrowserProfiles ?? {}) as Array<[YtdlpCookiePlatformId, BrowserProfile | undefined]>) {
    if (profile) platformBrowserProfiles[id] = normalizeBrowserProfile(profile)
  }
  return {
    ...config,
    modelsDirectory: normalizeOsPath(config.modelsDirectory),
    outputDirectory: normalizeOsPath(config.outputDirectory),
    asrModelDirectory: normalizeOsPath(config.asrModelDirectory),
    translationModelDirectory: normalizeOsPath(config.translationModelDirectory),
    demucsModelDirectory: normalizeOsPath(config.demucsModelDirectory),
    ytdlpDirectory: normalizeOsPath(config.ytdlpDirectory),
    ffmpegDirectory: normalizeOsPath(config.ffmpegDirectory),
    ytdlpCookiesPath: normalizeOsPath(config.ytdlpCookiesPath),
    pythonExecutable: normalizeOsPath(config.pythonExecutable),
    platformBrowserProfiles
  }
}

export function normalizeProxyUrl(proxy: string): string | null {
  const trimmed = proxy.trim()
  if (!trimmed) return null
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

export function toUserTaskMessage(raw: string): string {
  const text = raw.trim()
  if (!text) return '任务失败，请重试。'

  if (/Netscape formatted|not JSON/i.test(text)) {
    return 'Cookies 文件格式不对。若已选择 Chrome / Edge 登录，请先点「保存配置更改」；若使用 Cookies 文件，需 Netscape 格式的 cookies.txt，不能用浏览器导出的 JSON。'
  }
  if (/DEMUCS|demucs|torchaudio|人声分离|koubox_runtime/i.test(text) && /10061|积极拒绝|actively refused|Connect/i.test(text)) {
    return '人声分离启动失败：检测到系统代理环境变量可能指向错误端口。请到「全局设置 → 下载（yt-dlp）」确认代理为 http://127.0.0.1:7897，或清空系统 HTTP_PROXY。'
  }
  if (/Unable to connect to proxy|ProxyError|\[download\]|yt-dlp|yt_dlp/i.test(text) && /10061|积极拒绝|actively refused|proxy/i.test(text)) {
    const host = text.match(/host=['"]?([^'"\s,)]+)/i)?.[1]
    const port = text.match(/port=(\d+)/i)?.[1]
    const where = host && port ? `${host}:${port}` : text.match(/\d+\.\d+\.\d+\.\d+:\d+/)?.[0]
    if (where) {
      return `连不上代理 ${where}。请先打开代理软件，或到「全局设置 → 下载（yt-dlp）」改对 / 清空代理地址。`
    }
    return '连不上代理。请先打开代理软件，或到「全局设置 → 下载（yt-dlp）」改对 / 清空代理地址。'
  }
  if (/10061|积极拒绝|actively refused/i.test(text)) {
    const where = text.match(/\d+\.\d+\.\d+\.\d+:\d+/)?.[0]
    if (where) {
      return `网络连接失败 ${where}。请检查系统 HTTP_PROXY 环境变量与全局设置中的代理是否一致。`
    }
  }
  if (/Could not copy (Chrome|Edge) cookie|Failed to decrypt|Failed to load cookies|cookie database is locked|being used by/i.test(text)) {
    return '读不到系统浏览器登录状态。请在「全局设置 → 平台登录」使用应用内登录，打开登录窗口完成登录后点「保存应用内登录」。'
  }
  if (/已选「粘贴 Cookie」|当前为「应用内登录」|平台登录/i.test(text) && /请到「全局设置/i.test(text)) {
    return text
  }
  if (/尚未保存登录状态/i.test(text)) {
    return text
  }
  const authPlatform = detectAuthPlatformFromText(text)
  if (/\[Instagram\]|instagram\.com/i.test(text) && /login required|rate-limit|not available|Please wait|challenge|cookie/i.test(text)) {
    return platformAuthMissingMessage('instagram', 'paste', 'login-required')
  }
  if (/Sign in to confirm|not a bot|login required|Please log in|Use --cookies/i.test(text)) {
    if (authPlatform) {
      return platformAuthMissingMessage(authPlatform, 'builtin', 'login-required')
    }
    return '该视频需要登录后才能下载。请到「全局设置 → 平台登录」为对应平台配置登录后再试。'
  }
  if (/age-restricted|confirm your age/i.test(text)) {
    return '该视频有年龄限制。请使用已登录且符合年龄要求的账号，并检查下载设置中的登录来源。'
  }
  if (/Private video|members-only|Join this channel/i.test(text)) {
    return '这是私密或会员视频，当前账号没有观看权限。'
  }
  if (/Video unavailable|This video is not available/i.test(text)) {
    return '该视频无法访问，可能已删除、设为私密，或当前地区不可看。请更换链接后重试。'
  }
  if (/geo(?:graphic)?(?:ally)?\s*(?:restricted|blocked)|not available in your country/i.test(text)) {
    return '该视频在当前地区不可观看。可在「全局设置 → 下载（yt-dlp）」配置可用的代理后再试。'
  }
  if (/HTTP Error 429|Too Many Requests/i.test(text)) {
    return '请求太频繁，平台暂时限制了下载。请稍等几分钟再试。'
  }
  if (/HTTP Error 403|Forbidden/i.test(text)) {
    return '下载被拒绝。请检查登录和代理设置后重试。'
  }
  if (/Unsupported URL|No video formats|Requested format is not available/i.test(text)) {
    return '无法解析该链接，或没有可下载的清晰度。请确认链接完整，并检查清晰度限制。'
  }
  if (/timed? ?out|Timeout/i.test(text)) {
    return '下载超时。请检查网络或代理后重试。'
  }
  if (/SSL|certificate verify failed/i.test(text)) {
    return '网络安全验证失败。请检查代理或系统时间是否正确。'
  }

  const looksLikeDump = /^ERROR:/i.test(text) || /NewConnectionError|please report this issue|caused by |Extractor/i.test(text)
  if (looksLikeDump) {
    return '下载失败。请检查视频链接、网络，以及「全局设置 → 下载（yt-dlp）」中的代理和登录设置。'
  }
  return text
}
