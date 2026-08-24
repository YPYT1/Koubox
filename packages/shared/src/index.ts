export type ToolId = 'viral-materials' | 'precise-srt'

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

export type TaskKind = 'req1' | 'req2'
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
  status: TaskStatus
  stage: TaskStage
  percent: number
  message: string
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
  ytdlpInstagramCookies: string
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
    return '读不到系统浏览器登录状态。请在「全局设置 → 下载（yt-dlp）」使用应用内登录，打开登录窗口完成登录后点「保存登录状态」。'
  }
  if (/尚未保存登录状态/i.test(text)) {
    return text
  }
  if (/\[Instagram\]|instagram\.com/i.test(text) && /login required|rate-limit|not available|Please wait|challenge|cookie/i.test(text)) {
    return 'Instagram 下载失败：登录态无效或未生效。请用浏览器插件重新导出 cookie，粘贴到「全局设置 → Instagram Cookie」后保存，再重试。'
  }
  if (/Sign in to confirm|not a bot|login required|Please log in|Use --cookies/i.test(text)) {
    return '该视频需要登录后才能下载。请在「全局设置 → 下载（yt-dlp）」打开登录窗口，保存登录状态后再试。'
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
