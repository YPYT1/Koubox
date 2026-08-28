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
  version?: string
  channel?: 'stable' | 'nightly' | 'master'
  source?: 'bundled' | 'user-update'
  ejsVersion?: string
  jsRuntimeVersion?: string
}

export type YtdlpUpdateStatus = {
  channel: 'nightly'
  currentVersion: string
  currentSource: 'bundled' | 'user-update'
  latestVersion?: string
  updateAvailable: boolean
  checkedAt?: string
  downloadUrl?: string
  sha256?: string
}

export type RuntimeStatus = {
  healthy: boolean
  startedAt: string
  gpu: GpuStatus
  models: ModelCheck[]
  vendor: {
    ytdlp: VendorToolCheck
    ffmpeg: VendorToolCheck
    deno: VendorToolCheck
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
export type YtdlpCookiePlatformId = 'youtube' | 'tiktok' | 'instagram' | 'facebook'
export type PlatformAuthMode = 'builtin' | 'paste'

export function isYtdlpCookiePlatformId(value: unknown): value is YtdlpCookiePlatformId {
  return value === 'youtube' || value === 'tiktok' || value === 'instagram' || value === 'facebook'
}

export type PlatformAuthEntry = {
  mode: PlatformAuthMode
  cookies: string
}

export type PlatformAuthConfig = Record<YtdlpCookiePlatformId, PlatformAuthEntry>

export type PlatformAuthContext = {
  platformId: YtdlpCookiePlatformId
  mode: PlatformAuthMode
}

export function defaultPlatformAuth(): PlatformAuthConfig {
  return {
    youtube: { mode: 'paste', cookies: '' },
    tiktok: { mode: 'paste', cookies: '' },
    instagram: { mode: 'paste', cookies: '' },
    facebook: { mode: 'paste', cookies: '' }
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

type ParsedNetscapeCookie = { domain: string; expiry: number; name: string }

function parsedNetscapeCookies(text: string): ParsedNetscapeCookie[] {
  const rows: ParsedNetscapeCookie[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    if (!line) continue
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
    else if (line.startsWith('#')) continue
    const parts = line.split('\t')
    if (parts.length < 7) continue
    const domain = (parts[0] ?? '').replace(/^\./, '')
    const expiry = Number(parts[4] ?? 0)
    const name = parts[5]
    if (!domain || !name) continue
    rows.push({ domain, expiry: Number.isFinite(expiry) ? expiry : 0, name })
  }
  return rows
}

export function pastedCookieNamesFromNetscape(text: string, domainTest: RegExp): Set<string> {
  const names = new Set<string>()
  for (const row of parsedNetscapeCookies(text)) {
    if (domainTest.test(row.domain)) names.add(row.name)
  }
  return names
}

export function assertPastedPlatformCookies(platformId: YtdlpCookiePlatformId, text: string): void {
  const rule = PLATFORM_COOKIE_RULES.find((item) => item.id === platformId)
  if (!rule) throw new Error(`未知平台：${platformId}`)
  const parsed = parsedNetscapeCookies(text)
  if (parsed.length === 0) {
    throw new Error(`${rule.label} Cookie 格式错误：需要 Netscape cookies.txt 格式。`)
  }
  const platformRows = parsed.filter((row) => rule.domainTest.test(row.domain))
  if (platformRows.length === 0) {
    throw new Error(`Cookie 平台错误：粘贴内容不属于 ${rule.label}。`)
  }
  const names = new Set(platformRows.map((row) => row.name))
  const missing = rule.requiredNames.filter((name) => !names.has(name))
  if (missing.length > 0) {
    throw new Error(`${rule.label} Cookie 不完整：缺少 ${missing.join(' / ')}。请用浏览器插件重新导出后粘贴。`)
  }
  const now = Math.floor(Date.now() / 1000)
  const expiredRequired = platformRows
    .filter((row) => rule.requiredNames.includes(row.name))
    .filter((row) => row.expiry > 0 && row.expiry < now)
    .map((row) => row.name)
  if (expiredRequired.length > 0) {
    throw new Error(`${rule.label} Cookie 已过期：${[...new Set(expiredRequired)].join(' / ')}。请用浏览器插件重新导出后粘贴。`)
  }
}

export function pastedPlatformCookiesReady(platformId: YtdlpCookiePlatformId, text: string): { ok: boolean; detail: string } {
  try {
    assertPastedPlatformCookies(platformId, text)
    const rule = PLATFORM_COOKIE_RULES.find((item) => item.id === platformId)!
    return { ok: true, detail: `Cookie 格式完整，含 ${rule.requiredNames.length} 个关键字段；实际任务链接尚未验证` }
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
  mode: PlatformAuthMode
  loggedIn: boolean
  liveVerified: boolean
  saved: boolean
  savedAt?: string
  cookieCount: number
  detail: string
}

export type YtdlpCookieStatus = {
  exported: boolean
  exportedAt?: string
  cookieCount: number
  platforms: YtdlpCookiePlatformStatus[]
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
  denoDirectory: string
  translationTargetLanguage: TranslationTargetLanguage
  asrLanguage: AsrLanguage
  openOutputOnComplete: boolean
  ytdlpProxy: string
  /** 各平台独立：应用内登录 / 粘贴 Cookie */
  ytdlpPlatformAuth: PlatformAuthConfig
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

/** Normalize every filesystem path field on KouboxConfig (JP Windows ¥/￥ → `\`). */
export function normalizeKouboxConfigPaths(config: KouboxConfig): KouboxConfig {
  return {
    ...config,
    modelsDirectory: normalizeOsPath(config.modelsDirectory),
    outputDirectory: normalizeOsPath(config.outputDirectory),
    asrModelDirectory: normalizeOsPath(config.asrModelDirectory),
    translationModelDirectory: normalizeOsPath(config.translationModelDirectory),
    demucsModelDirectory: normalizeOsPath(config.demucsModelDirectory),
    ytdlpDirectory: normalizeOsPath(config.ytdlpDirectory),
    ffmpegDirectory: normalizeOsPath(config.ffmpegDirectory),
    denoDirectory: normalizeOsPath(config.denoDirectory),
    pythonExecutable: normalizeOsPath(config.pythonExecutable)
  }
}

export function normalizeProxyUrl(proxy: string): string | null {
  const trimmed = proxy.trim()
  if (!trimmed) return null
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

export function toUserTaskMessage(raw: string, auth?: PlatformAuthContext): string {
  const text = raw.trim()
  if (!text) return '任务失败，请重试。'

  if (/Deno (?:运行时不存在|运行时检测失败|SHA-256 校验失败)|未能启用 Deno JS Challenge Provider/i.test(text)) {
    return 'Deno 运行时缺失或损坏。请在「全局设置 → 模型与运行环境」检查内置 Deno 2.9.5。'
  }
  if (/yt-dlp.*未检测到内置 yt-dlp-ejs|yt-dlp-ejs.*(?:missing|缺失)/i.test(text)) {
    return 'yt-dlp 内置 EJS 组件缺失或损坏。请恢复内置版本，或重新执行手动更新。'
  }
  if (/Netscape formatted|not JSON/i.test(text)) {
    return 'Cookie 格式不对。请使用「口播匣 Cookie 导出」插件复制 Netscape 格式全文，不能使用 JSON。'
  }
  if (/(粘贴 Cookie 已配置|应用内登录已保存)，?但 yt-dlp 鉴权失败/i.test(text)) {
    return text
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
  if (/已选「粘贴 Cookie」|当前为「应用内登录」|平台登录/i.test(text) && /请到「全局设置/i.test(text)) {
    return text
  }
  if (/尚未保存登录状态/i.test(text)) {
    return text
  }
  // YouTube 常见：带 Cookie 时 tv_downgraded 客户端返回 UNPLAYABLE / The page needs to be reloaded
  if (/the page needs to be reloaded|tv_downgraded.*UNPLAYABLE|player response playability status:\s*UNPLAYABLE/i.test(text)) {
    const platform = auth?.platformId ?? detectAuthPlatformFromText(text) ?? 'youtube'
    const label = platformLabel(platform)
    if (auth?.mode === 'builtin') {
      return `${label} 当前应用内登录请求被平台拒绝。请到「全局设置 → 平台登录」打开 ${label} 登录窗口，确认账号可正常访问后重新保存应用内登录。`
    }
    return `${label} 当前粘贴 Cookie 被平台拒绝。请用「口播匣 Cookie 导出」插件重新导出 ${label} Cookie，粘贴并保存后重试。`
  }
  const authPlatform = detectAuthPlatformFromText(text)
  if (/\[Instagram\]|instagram\.com/i.test(text) && /login required|rate-limit|not available|Please wait|challenge|cookie/i.test(text)) {
    const mode = auth?.platformId === 'instagram' ? auth.mode : 'paste'
    return platformAuthMissingMessage('instagram', mode, 'login-required')
  }
  if (/Sign in to confirm|not a bot|login required|Please log in|Use --cookies/i.test(text)) {
    if (authPlatform) {
      return `${platformLabel(authPlatform)} Cookie 或应用内登录已被平台拒绝。请到「全局设置 → 平台登录」检查当前选择的登录方式。`
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
  if (/\[TikTok\]|tiktok\.com/i.test(text) && /Unable to extract universal data for rehydration|Unexpected response from webpage request|Unable to extract challenge data/i.test(text)) {
    const mode = auth?.platformId === 'tiktok' ? auth.mode : 'paste'
    const source = mode === 'paste' ? '粘贴 Cookie' : '应用内登录'
    return `TikTok 页面验证未通过：yt-dlp 已读取${source}并启用浏览器模拟，但平台仍未返回可解析的视频数据。请刷新 TikTok 登录状态后重试。`
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
