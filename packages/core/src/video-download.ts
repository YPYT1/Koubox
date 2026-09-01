import { existsSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  assertDownloadableVideoUrl,
  isStalePlatformAuthFailure,
  isPlatformAuthConfigured,
  normalizeProxyUrl,
  platformAuthIdFromUrlPlatform,
  platformAuthRejectedMessage,
  type DownloadableVideoPlatform,
  type KouboxConfig
} from '@koubox/shared'
import { resolveFacebookPublicMedia } from './facebook.js'
import { prepareDownloadUrl } from './download-url.js'
import { resolvePublicMedia, type PublicMediaResolution } from './public-video.js'

export {
  VIDEO_DOWNLOAD_PIPELINE_PATH,
  VIDEO_MATERIALS_PIPELINE_PATH
} from '@koubox/shared'
export type { PublicMediaResolution } from './public-video.js'

export type VideoDownloadStrategy =
  | 'public-page'
  | 'tiktok-reference'
  | 'tiktok-browser'
  | 'facebook-browser'
  | 'yt-dlp-authenticated'

/** A per-task cookie file created by the desktop host and removed after yt-dlp exits. */
export type AuthenticatedCookieFile = {
  path: string
  platform: DownloadableVideoPlatform
  source: 'paste' | 'builtin'
  /** User-Agent from the browser session that supplied the cookie jar. */
  userAgent?: string
  cleanup(): Promise<void> | void
}

export type VerifiedMedia = {
  duration: number
  size: number
  videoCodec: string
  audioCodec: string
  width: number
  height: number
}

export type VideoDownloadResult = {
  path: string
  platform: DownloadableVideoPlatform
  strategy: VideoDownloadStrategy
  media: VerifiedMedia
  failures: Array<{ strategy: VideoDownloadStrategy; message: string }>
}

type DownloadConfig = Pick<
  KouboxConfig,
  | 'ytdlpProxy'
  | 'ytdlpMaxHeight'
  | 'ytdlpExtraArgs'
  | 'ytdlpPlatformAuth'
>

type RunCommand = (
  command: string,
  args: string[],
  onLine?: (line: string) => void,
  commandLabel?: string
) => Promise<void>

export type VerifyMediaOptions = {
  requireAudio?: boolean
}

export type VideoDownloadRequest = {
  url: string
  directory: string
  fileStem: string
  vendor: { ytdlpExecutable: string; ffmpegExecutable: string; denoExecutable: string }
  config: DownloadConfig
  /** 缺省为 false；设为 true 时下载校验强制要求音轨 */
  requireAudio?: boolean
  updateProgress(percent: number, message: string): void
  isCancelled?(): boolean
  signal?: AbortSignal
  runCommand: RunCommand
  resolvePublicMedia?: typeof resolvePublicMedia
  resolveFacebookPublicMedia?: typeof resolveFacebookPublicMedia
  downloadTikTokPublic?(url: string, directory: string, fileStem: string, onLine?: (line: string) => void): Promise<string>
  resolveTikTokBrowserMedia?(url: string, proxy: string, signal?: AbortSignal): Promise<PublicMediaResolution>
  resolveFacebookAnonymousMedia?(url: string, proxy: string, signal?: AbortSignal): Promise<PublicMediaResolution>
  resolveAuthenticatedCookies?(platform: DownloadableVideoPlatform): Promise<AuthenticatedCookieFile | undefined>
  verifyMediaFile?(filePath: string, ffmpegExecutable: string, options?: VerifyMediaOptions): Promise<VerifiedMedia>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function ensureActive(request: VideoDownloadRequest): void {
  if (request.signal?.aborted || request.isCancelled?.()) throw new Error('任务已取消。')
}

function looksLikePublicNetworkFailure(message: string): boolean {
  if (/video unavailable|not available|已删除|已下架|私密|private|login required|需要登录|年龄限制|age-restricted|地区不可用|geo(?:graphic)?(?:ally)?\s*(?:restricted|blocked)/i.test(message)) {
    return false
  }
  return /timed? ?out|timeout|connect timeout|ETIMEDOUT|ECONNRESET|ENETUNREACH|EAI_AGAIN|fetch failed|socket hang up|ERR_(?:TIMED_OUT|CONNECTION_|NETWORK_)|10060|10061|网络.*(?:超时|中断|失败|未返回)|连接.*(?:超时|重置|失败|中断)|页面没有返回视频链接|没有返回目标公开视频 playAddr|没有观察到公开视频流|没有暴露可下载的视频流|下载文件没有(?:视频流|原始音频流)|媒体直链已失效或中断|HTTP (?:408|429|5\d\d)/i.test(message)
}

function publicNetworkFailureMessage(
  platform: DownloadableVideoPlatform,
  failures: VideoDownloadResult['failures'],
  platformAuthConfigured: boolean
): string | undefined {
  const publicFailures = failures.filter((failure) => failure.strategy !== 'yt-dlp-authenticated')
  if (!publicFailures.some((failure) => looksLikePublicNetworkFailure(failure.message))) return undefined
  if (platformAuthConfigured) {
    return `${platform} 下载失败：网络连接超时或较慢，平台页面未完整返回媒体数据。请检查网络或代理后重试。`
  }
  return `${platform} 公开视频获取失败：当前网络较慢或连接不稳定，平台页面可能没有完整返回媒体数据。请检查网络或代理后重试；无需先配置 Cookie。`
}

function splitExtraArgs(value: string): string[] {
  const args: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of value.matchAll(pattern)) args.push(match[1] ?? match[2] ?? match[3])
  return args
}

function ytdlpVideoFormat(maxHeight: number): string {
  const height = maxHeight > 0 ? `[height<=${maxHeight}]` : ''
  return `bv*${height}+ba/bv*${height}/b${height}/best${height}`
}

function ytdlpVideoOnlyFormat(maxHeight: number): string {
  const height = maxHeight > 0 ? `[height<=${maxHeight}]` : ''
  return `bv*${height}/b${height}/best${height}`
}

function looksLikeMissingAudioFailure(message: string): boolean {
  return /没有音轨|没有原始音频流|没有音频流|no audio|audio.?only.*not available|unable to (?:download|extract).*audio|merg(?:e|ing).*(?:audio|formats).*fail|requested format is not available/i.test(message)
}

function publicYtdlpExtraArgs(value: string): string[] {
  const args = splitExtraArgs(value)
  const blockedWithValue = new Set([
    '--cookies', '--cookies-from-browser', '--username', '--password',
    '--video-password', '--ap-mso', '--ap-username', '--ap-password',
    '--netrc-location', '--config-locations', '--config-location', '-u', '-p'
  ])
  const blockedFlags = new Set(['--netrc', '-n'])
  const updateOptions = new Set(['-U', '--update', '--no-update', '--update-to'])
  const safe: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const option = argument.split('=', 1)[0]
    if (updateOptions.has(option)) {
      if (option === '--update-to' && !argument.includes('=')) index += 1
      continue
    }
    if (blockedWithValue.has(option)) {
      if (!argument.includes('=')) index += 1
      continue
    }
    if (blockedFlags.has(option)) continue
    safe.push(argument)
  }
  return safe
}

function cleanupDownloadTemps(directory: string, tempStem: string): void {
  if (!existsSync(directory)) return
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(`${tempStem}.`) && !name.startsWith(`${tempStem}_`)) continue
    const path = join(directory, name)
    if (existsSync(path)) unlinkSync(path)
  }
}

function finalizeYtdlpDownload(directory: string, tempStem: string, fileStem: string): string {
  const file = readdirSync(directory).find((name) =>
    !name.endsWith('.part') && !name.endsWith('.ytdl') && name.startsWith(`${tempStem}.`))
  if (!file) throw new Error('yt-dlp 已结束，但没有找到下载的视频文件。')
  const downloaded = join(directory, file)
  const finalExt = extname(file).toLowerCase() || '.mp4'
  const finalPath = join(directory, `${fileStem}${finalExt === '.mp4' ? '.mp4' : finalExt}`)
  if (downloaded !== finalPath) {
    if (existsSync(finalPath)) throw new Error(`目标视频文件已存在：${finalPath}`)
    renameSync(downloaded, finalPath)
  }
  return finalPath
}

function parseProbeNumber(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export async function verifyDownloadedMedia(
  filePath: string,
  ffmpegExecutable: string,
  options: VerifyMediaOptions = {}
): Promise<VerifiedMedia> {
  const requireAudio = options.requireAudio === true
  const ffprobe = join(dirname(ffmpegExecutable), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  if (!existsSync(ffprobe)) throw new Error(`ffprobe 不存在：${ffprobe}`)
  const result = spawnSync(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height',
    '-of', 'json',
    filePath
  ], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`ffprobe 失败：${(result.stderr || result.stdout || '').trim()}`)
  const data = JSON.parse(result.stdout || '{}') as {
    format?: { duration?: string; size?: string }
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>
  }
  const video = data.streams?.find((stream) => stream.codec_type === 'video')
  const audio = data.streams?.find((stream) => stream.codec_type === 'audio')
  const duration = parseProbeNumber(data.format?.duration)
  const size = parseProbeNumber(data.format?.size)
  if (!video) throw new Error('下载文件没有视频流。')
  if (!audio && requireAudio) throw new Error('下载的视频没有音轨。')
  if (!(duration > 0)) throw new Error('下载文件时长无效。')
  if (!(size > 0)) throw new Error('下载文件大小无效。')
  return {
    duration,
    size,
    videoCodec: video.codec_name ?? '',
    audioCodec: audio?.codec_name ?? '',
    width: parseProbeNumber(video.width),
    height: parseProbeNumber(video.height)
  }
}

async function downloadResolvedMedia(request: VideoDownloadRequest, resolved: PublicMediaResolution): Promise<string> {
  ensureActive(request)
  const proxy = normalizeProxyUrl(request.config.ytdlpProxy)
  const tempPath = join(request.directory, `_dl_${request.fileStem}.public.mp4`)
  const finalPath = join(request.directory, `${request.fileStem}.mp4`)
  if (existsSync(tempPath)) unlinkSync(tempPath)
  const args = ['-hide_banner', '-loglevel', 'warning', '-y', '-progress', 'pipe:1']
  const addInput = (url: string) => {
    args.push(
      '-rw_timeout', '50000000',
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '3'
    )
    if (proxy) args.push('-http_proxy', proxy)
    const userAgent = resolved.source.startsWith('facebook-') ? 'facebookexternalhit/1.1' : resolved.userAgent
    args.push('-user_agent', userAgent, '-referer', resolved.referer)
    if (resolved.cookieHeader && !resolved.source.startsWith('facebook-')) {
      args.push('-headers', `Cookie: ${resolved.cookieHeader}\r\n`)
    }
    args.push('-i', url)
  }
  addInput(resolved.videoUrl)
  if (resolved.audioUrl) addInput(resolved.audioUrl)
  args.push('-map', '0:v:0')
  if (resolved.audioUrl) args.push('-map', '1:a:0')
  else args.push('-map', '0:a:0?')
  args.push('-c', 'copy', '-movflags', '+faststart', tempPath)
  request.updateProgress(8, `已解析公开媒体流（${resolved.source}），正在下载…`)

  // 监控 FFmpeg 进度
  let lastProgressTime = Date.now()
  await request.runCommand(request.vendor.ffmpegExecutable, args, (line) => {
    ensureActive(request)
    // FFmpeg progress 格式: time=00:00:10.00
    const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.\d+)/)
    if (timeMatch) {
      const hours = parseInt(timeMatch[1])
      const minutes = parseInt(timeMatch[2])
      const seconds = parseFloat(timeMatch[3])
      const currentSeconds = hours * 3600 + minutes * 60 + seconds

      // 节流：每 500ms 更新一次进度
      const now = Date.now()
      if (now - lastProgressTime > 500) {
        lastProgressTime = now
        // 假设视频不超过 10 分钟，按比例计算进度（8% - 28%）
        const estimatedDuration = 600 // 10 分钟
        const progress = Math.min(20, (currentSeconds / estimatedDuration) * 20)
        request.updateProgress(8 + progress, `下载中 ${Math.floor(currentSeconds)}s…`)
      }
    }
  }, '公开媒体下载')

  ensureActive(request)
  if (!existsSync(tempPath)) throw new Error('公开媒体流已处理，但没有生成视频文件。')
  if (existsSync(finalPath)) throw new Error(`目标视频文件已存在：${finalPath}`)
  renameSync(tempPath, finalPath)
  return finalPath
}

async function resolvePrimaryPublicMedia(
  request: VideoDownloadRequest,
  platform: DownloadableVideoPlatform
): Promise<PublicMediaResolution> {
  // YouTube 不使用公开解析，强制走 yt-dlp 登录态
  if (platform === 'YouTube') {
    throw new Error('YouTube 需要登录后才能下载。')
  }
  if (platform === 'Facebook') {
    return (request.resolveFacebookPublicMedia ?? resolveFacebookPublicMedia)(request.url, request.config.ytdlpProxy, request.signal)
  }
  return (request.resolvePublicMedia ?? resolvePublicMedia)(
    request.url,
    platform,
    request.config.ytdlpProxy,
    request.config.ytdlpMaxHeight,
    request.signal
  )
}

function publicFallbacks(
  request: VideoDownloadRequest,
  platform: DownloadableVideoPlatform
): Array<{ strategy: VideoDownloadStrategy; resolveAttempts: number; resolve(): Promise<PublicMediaResolution> }> {
  const fallbacks: Array<{ strategy: VideoDownloadStrategy; resolveAttempts: number; resolve(): Promise<PublicMediaResolution> }> = []
  if (platform === 'TikTok' && request.resolveTikTokBrowserMedia) {
    fallbacks.push({
      strategy: 'tiktok-browser',
      resolveAttempts: 3,
      resolve: () => request.resolveTikTokBrowserMedia!(request.url, request.config.ytdlpProxy, request.signal)
    })
  }
  if (platform === 'Facebook' && request.resolveFacebookAnonymousMedia) {
    fallbacks.push({
      strategy: 'facebook-browser',
      resolveAttempts: 1,
      resolve: () => request.resolveFacebookAnonymousMedia!(request.url, request.config.ytdlpProxy, request.signal)
    })
  }
  return fallbacks
}

async function runYtdlpAuthenticated(request: VideoDownloadRequest, authentication: AuthenticatedCookieFile): Promise<string> {
  return runYtdlp(request, authentication)
}

function ytdlpAuthenticationArgs(request: VideoDownloadRequest, authentication?: AuthenticatedCookieFile): string[] {
  const args: string[] = ['--socket-timeout', '50']
  const proxy = normalizeProxyUrl(request.config.ytdlpProxy)
  if (proxy) args.push('--proxy', proxy)
  if (authentication?.path) args.push('--cookies', authentication.path)
  if (authentication?.userAgent?.trim()) args.push('--user-agent', authentication.userAgent.trim())
  args.push('--js-runtimes', `deno:${request.vendor.denoExecutable}`)
  return args
}

function authenticationSourceLabel(source: AuthenticatedCookieFile['source']): string {
  return source === 'paste' ? '粘贴 Cookie 已配置' : '应用内登录已保存'
}

function formatYtdlpAuthenticatedFailure(
  platform: DownloadableVideoPlatform,
  source: AuthenticatedCookieFile['source'],
  failure: string
): string {
  if (/没有音轨|没有原始音频流|没有音频流/.test(failure)) {
    return '影片中没有音轨。'
  }
  const platformId = platformAuthIdFromUrlPlatform(platform)
  const mode = source === 'paste' ? 'paste' : 'builtin'
  if (platformId && isStalePlatformAuthFailure(failure)) {
    return platformAuthRejectedMessage(platformId, mode)
  }
  return `${platform} ${authenticationSourceLabel(source)}，但 yt-dlp 下载失败：${failure}`
}

/**
 * Verify the exported browser session before beginning a media download.
 * `--skip-download --simulate` still forces yt-dlp to load the target page and
 * select the requested format, but leaves no partial media files behind.
 */
async function runYtdlpAuthenticationPreflight(
  request: VideoDownloadRequest,
  authentication: AuthenticatedCookieFile
): Promise<void> {
  const runPreflight = async (format: string) => {
    const args = [
      '--ignore-config', '--newline', '--no-playlist', '--no-warnings',
      '--skip-download', '--simulate',
      ...ytdlpAuthenticationArgs(request, authentication),
      '-f', format,
      request.url
    ]
    await request.runCommand(request.vendor.ytdlpExecutable, args, undefined, 'yt-dlp 认证预检')
  }
  try {
    await runPreflight(ytdlpVideoFormat(request.config.ytdlpMaxHeight))
  } catch (error) {
    if (request.requireAudio === true || !looksLikeMissingAudioFailure(errorMessage(error))) throw error
    await runPreflight(ytdlpVideoOnlyFormat(request.config.ytdlpMaxHeight))
  }
}

function ytdlpProgressHandler(request: VideoDownloadRequest): (line: string) => void {
  return (line) => {
    const percent = line.match(/(\d+(?:\.\d+)?)%/)
    if (percent) request.updateProgress(Math.min(28, Math.max(1, Number(percent[1]) * 0.28)), `正在下载视频 ${percent[1]}%`)
    else if (/Extracting URL/i.test(line)) request.updateProgress(2, '正在解析视频链接…')
    else if (/Downloading webpage|Downloading android|Downloading m3u8|Downloading player/i.test(line)) request.updateProgress(4, '正在获取视频信息…')
    else if (/\[download\]\s+Destination:/i.test(line)) request.updateProgress(8, '开始下载视频文件…')
  }
}

async function runYtdlpWithFormat(
  request: VideoDownloadRequest,
  authentication: AuthenticatedCookieFile | undefined,
  tempStem: string,
  format: string
): Promise<void> {
  const args = [
    '--ignore-config', '--newline', '--no-playlist', '--no-warnings',
    '--ffmpeg-location', dirname(request.vendor.ffmpegExecutable),
    '--merge-output-format', 'mp4',
    '-o', join(request.directory, `${tempStem}.%(ext)s`)
  ]
  args.push(...ytdlpAuthenticationArgs(request, authentication))
  args.push('-f', format)
  if (request.config.ytdlpExtraArgs.trim()) args.push(...publicYtdlpExtraArgs(request.config.ytdlpExtraArgs.trim()))
  await request.runCommand(request.vendor.ytdlpExecutable, [...args, request.url], ytdlpProgressHandler(request), 'yt-dlp')
}

async function runYtdlp(request: VideoDownloadRequest, authentication?: AuthenticatedCookieFile): Promise<string> {
  const tempStem = `_dl_${request.fileStem}`
  const maxHeight = request.config.ytdlpMaxHeight
  try {
    await runYtdlpWithFormat(request, authentication, tempStem, ytdlpVideoFormat(maxHeight))
    return finalizeYtdlpDownload(request.directory, tempStem, request.fileStem)
  } catch (error) {
    const message = errorMessage(error)
    if (request.requireAudio !== true) {
      try {
        return finalizeYtdlpDownload(request.directory, tempStem, request.fileStem)
      } catch {
        /* 没有可用的部分下载文件 */
      }
      if (looksLikeMissingAudioFailure(message)) {
        cleanupDownloadTemps(request.directory, tempStem)
        await runYtdlpWithFormat(request, authentication, tempStem, ytdlpVideoOnlyFormat(maxHeight))
        return finalizeYtdlpDownload(request.directory, tempStem, request.fileStem)
      }
    }
    cleanupDownloadTemps(request.directory, tempStem)
    throw error
  }
}

async function verifyResult(
  request: VideoDownloadRequest,
  path: string,
  platform: DownloadableVideoPlatform,
  strategy: VideoDownloadStrategy,
  failures: VideoDownloadResult['failures']
): Promise<VideoDownloadResult> {
  const verifyOptions: VerifyMediaOptions = { requireAudio: request.requireAudio === true }
  const media = await (request.verifyMediaFile ?? verifyDownloadedMedia)(path, request.vendor.ffmpegExecutable, verifyOptions)
  return { path, platform, strategy, media, failures }
}

/** Canonical download pipeline used by both `download` and `req1` tasks. */
export async function downloadVideo(request: VideoDownloadRequest): Promise<VideoDownloadResult> {
  ensureActive(request)
  const checked = assertDownloadableVideoUrl(request.url)
  const prepared = await prepareDownloadUrl(request.url, request.config.ytdlpProxy, request.signal)
  const effectiveRequest: VideoDownloadRequest = { ...request, url: prepared.downloadUrl }
  const failures: VideoDownloadResult['failures'] = []
  const tryResolved = async (
    strategy: VideoDownloadStrategy,
    resolver: () => Promise<PublicMediaResolution>,
    resolveAttempts = 1
  ): Promise<VideoDownloadResult | undefined> => {
    try {
      ensureActive(request)
      request.updateProgress(4, strategy === 'public-page' ? '正在解析公开页面最高质量媒体流…' : '正在使用匿名浏览器捕获公开媒体流…')
      const attemptResolution = async (resolution: PublicMediaResolution): Promise<VideoDownloadResult> => {
        const candidates = [resolution.videoUrl, ...(resolution.alternateVideoUrls ?? [])]
        let lastError: unknown
        for (const videoUrl of candidates) {
          ensureActive(request)
          const finalPath = join(request.directory, `${request.fileStem}.mp4`)
          if (existsSync(finalPath)) unlinkSync(finalPath)
          try {
            const path = await downloadResolvedMedia(request, {
              ...resolution,
              videoUrl,
              alternateVideoUrls: undefined
            })
            return await verifyResult(request, path, checked.platform, strategy, failures)
          } catch (error) {
            lastError = error
            if (existsSync(finalPath)) unlinkSync(finalPath)
          }
        }
        throw lastError ?? new Error('解析器没有返回可下载的媒体候选。')
      }
      let firstResolution: PublicMediaResolution | undefined
      let resolutionError: unknown
      const resolverLabel = strategy === 'public-page'
        ? '正在解析公开页面最高质量媒体流'
        : '正在使用匿名浏览器捕获公开媒体流'
      const startedAt = Date.now()
      let heartbeat = 0
      const heartbeatTimer = setInterval(() => {
        if (request.isCancelled?.()) return
        heartbeat += 1
        const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
        request.updateProgress(Math.min(7, 4 + heartbeat), `${resolverLabel}（已等待 ${elapsedSeconds} 秒）…`)
      }, 5_000)
      for (let attempt = 1; attempt <= resolveAttempts; attempt += 1) {
        try {
          ensureActive(request)
          firstResolution = await resolver()
          ensureActive(request)
          break
        } catch (error) {
          resolutionError = error
          ensureActive(request)
          if (attempt < resolveAttempts) {
            request.updateProgress(5, `匿名浏览器未捕获到媒体流，正在重试（${attempt + 1}/${resolveAttempts}）…`)
          }
        }
      }
      clearInterval(heartbeatTimer)
      if (!firstResolution) throw resolutionError ?? new Error('解析器没有返回媒体流。')
      try {
        return await attemptResolution(firstResolution)
      } catch {
        ensureActive(request)
        request.updateProgress(6, '媒体直链已失效或中断，正在重新解析后重试…')
        return await attemptResolution(await resolver())
      }
    } catch (error) {
      failures.push({ strategy, message: errorMessage(error) })
      const finalPath = join(request.directory, `${request.fileStem}.mp4`)
      if (existsSync(finalPath)) unlinkSync(finalPath)
      return undefined
    }
  }

  // YouTube 直接走登录态；TikTok 优先使用复制进来的参考下载器，再回退匿名浏览器。
  if (checked.platform === 'TikTok') {
    if (effectiveRequest.downloadTikTokPublic) {
      effectiveRequest.updateProgress(4, '正在使用 TikTok 无 Cookie 下载器…')
      try {
        const startedAt = Date.now()
        let sawProgress = false
        const heartbeatTimer = setInterval(() => {
          if (effectiveRequest.isCancelled?.() || sawProgress) return
          const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
          effectiveRequest.updateProgress(5, `正在解析 TikTok 视频信息（已等待 ${elapsedSeconds} 秒）…`)
        }, 1_200)
        const path = await effectiveRequest.downloadTikTokPublic(effectiveRequest.url, effectiveRequest.directory, effectiveRequest.fileStem, (line) => {
          ensureActive(effectiveRequest)
          const percent = line.match(/(\d+(?:\.\d+)?)%/)
          if (percent) {
            sawProgress = true
            effectiveRequest.updateProgress(Math.min(28, Math.max(8, Number(percent[1]) * 0.28)), `正在下载视频 ${percent[1]}%`)
          } else if (/Downloading webpage|Solving JS challenge/i.test(line)) {
            effectiveRequest.updateProgress(5, '正在解析 TikTok 视频信息…')
          }
        }).finally(() => clearInterval(heartbeatTimer))
        ensureActive(effectiveRequest)
        return await verifyResult(effectiveRequest, path, checked.platform, 'tiktok-reference', failures)
      } catch (error) {
        failures.push({ strategy: 'tiktok-reference', message: errorMessage(error) })
      }
    }
    const browserFallback = publicFallbacks(effectiveRequest, checked.platform).find((item) => item.strategy === 'tiktok-browser')
    if (browserFallback) {
      const result = await tryResolved(browserFallback.strategy, browserFallback.resolve, browserFallback.resolveAttempts)
      if (result) return result
    }
  } else if (checked.platform !== 'YouTube') {
    const direct = await tryResolved('public-page', () => resolvePrimaryPublicMedia(effectiveRequest, checked.platform))
    if (direct) return direct

    for (const fallback of publicFallbacks(effectiveRequest, checked.platform)) {
      const result = await tryResolved(fallback.strategy, fallback.resolve, fallback.resolveAttempts)
      if (result) return result
    }
  }

  let authenticationResolved: AuthenticatedCookieFile | undefined
  let ytdlpAuthenticationFailure: string | undefined
  if (effectiveRequest.resolveAuthenticatedCookies) {
    try {
      ensureActive(effectiveRequest)
      effectiveRequest.updateProgress(4, checked.platform === 'YouTube' ? '正在读取平台登录配置…' : '公开解析失败，正在读取平台登录配置…')
      const cookieFile = await effectiveRequest.resolveAuthenticatedCookies(checked.platform)
      if (cookieFile) {
        authenticationResolved = cookieFile
        try {
          ensureActive(effectiveRequest)
          effectiveRequest.updateProgress(5, `正在验证${cookieFile.source === 'paste' ? '粘贴 Cookie' : '应用内登录'}…`)
          await runYtdlpAuthenticationPreflight(effectiveRequest, cookieFile)
          ensureActive(effectiveRequest)
          effectiveRequest.updateProgress(6, '平台登录验证通过，正在下载…')
          const path = await runYtdlpAuthenticated(effectiveRequest, cookieFile)
          ensureActive(effectiveRequest)
          return await verifyResult(effectiveRequest, path, checked.platform, 'yt-dlp-authenticated', failures)
        } catch (error) {
          ytdlpAuthenticationFailure = errorMessage(error)
          throw error
        } finally {
          await cookieFile.cleanup()
        }
      }
    } catch (error) {
      failures.push({ strategy: 'yt-dlp-authenticated', message: errorMessage(error) })
    }
  }

  // 个性化错误提示
  if (checked.platform === 'YouTube') {
    if (!request.resolveAuthenticatedCookies || (!authenticationResolved && !ytdlpAuthenticationFailure)) {
      throw new Error('YouTube 视频需要登录后才能下载。请在【全局设置】→【平台登录配置】中配置 YouTube 登录状态。')
    }
    if (ytdlpAuthenticationFailure) {
      if (!authenticationResolved) throw new Error(ytdlpAuthenticationFailure)
      throw new Error(formatYtdlpAuthenticatedFailure('YouTube', authenticationResolved.source, ytdlpAuthenticationFailure))
    }
    throw new Error(`YouTube 视频下载失败：${failures.map((item) => `${item.strategy}：${item.message}`).join('；')}。请检查 YouTube 登录状态是否有效。`)
  }

  if (ytdlpAuthenticationFailure) {
    if (authenticationResolved) {
      throw new Error(formatYtdlpAuthenticatedFailure(checked.platform, authenticationResolved.source, ytdlpAuthenticationFailure))
    }
    throw new Error(`${checked.platform} 公开视频解析失败；认证线路失败：${ytdlpAuthenticationFailure}`)
  }

  if (!authenticationResolved) {
    const platformAuthConfigured = isPlatformAuthConfigured(checked.platform, effectiveRequest.config.ytdlpPlatformAuth)
    const networkMessage = publicNetworkFailureMessage(checked.platform, failures, platformAuthConfigured)
    if (networkMessage) throw new Error(networkMessage)
  }

  const platformAuthConfigured = isPlatformAuthConfigured(checked.platform, effectiveRequest.config.ytdlpPlatformAuth)
  if (platformAuthConfigured) {
    throw new Error(`${checked.platform} 视频下载失败：${failures.map((item) => `${item.strategy}：${item.message}`).join('；')}。请检查网络、代理或平台登录状态后重试。`)
  }

  throw new Error(`${checked.platform} 公开视频解析失败：${failures.map((item) => `${item.strategy}：${item.message}`).join('；')}。请到【全局设置】→【平台登录配置】配置该平台。`)
}
