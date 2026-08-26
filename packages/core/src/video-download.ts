import { existsSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  assertDownloadableVideoUrl,
  normalizeProxyUrl,
  type DownloadableVideoPlatform,
  type KouboxConfig
} from '@koubox/shared'
import { resolveFacebookPublicMedia } from './facebook.js'
import { resolvePublicMedia, type PublicMediaResolution } from './public-video.js'

export {
  VIDEO_DOWNLOAD_PIPELINE_PATH,
  VIDEO_MATERIALS_PIPELINE_PATH
} from '@koubox/shared'
export type { PublicMediaResolution } from './public-video.js'

export type VideoDownloadStrategy =
  | 'public-page'
  | 'tiktok-browser'
  | 'facebook-browser'
  | 'yt-dlp-authenticated'
  | 'yt-dlp-public'

/** A per-task cookie file created by the desktop host and removed after yt-dlp exits. */
export type AuthenticatedCookieFile = {
  path: string
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
>

type RunCommand = (
  command: string,
  args: string[],
  onLine?: (line: string) => void,
  commandLabel?: string
) => Promise<void>

export type VideoDownloadRequest = {
  url: string
  directory: string
  fileStem: string
  vendor: { ytdlpExecutable: string; ffmpegExecutable: string }
  config: DownloadConfig
  updateProgress(percent: number, message: string): void
  runCommand: RunCommand
  resolvePublicMedia?: typeof resolvePublicMedia
  resolveFacebookPublicMedia?: typeof resolveFacebookPublicMedia
  resolveTikTokBrowserMedia?(url: string, proxy: string): Promise<PublicMediaResolution>
  resolveFacebookAnonymousMedia?(url: string, proxy: string): Promise<PublicMediaResolution>
  resolveAuthenticatedCookies?(platform: DownloadableVideoPlatform): Promise<AuthenticatedCookieFile | undefined>
  verifyMediaFile?(filePath: string, ffmpegExecutable: string): Promise<VerifiedMedia>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function splitExtraArgs(value: string): string[] {
  const args: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of value.matchAll(pattern)) args.push(match[1] ?? match[2] ?? match[3])
  return args
}

function ytdlpVideoFormat(maxHeight: number): string {
  const height = maxHeight > 0 ? `[height<=${maxHeight}]` : ''
  return `bv*${height}+ba/b${height}/best${height}`
}

function publicYtdlpExtraArgs(value: string): string[] {
  const args = splitExtraArgs(value)
  const blockedWithValue = new Set([
    '--cookies', '--cookies-from-browser', '--username', '--password',
    '--video-password', '--ap-mso', '--ap-username', '--ap-password',
    '--netrc-location', '--config-locations', '--config-location', '-u', '-p'
  ])
  const blockedFlags = new Set(['--netrc', '-n'])
  const safe: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const option = argument.split('=', 1)[0]
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

export async function verifyDownloadedMedia(filePath: string, ffmpegExecutable: string): Promise<VerifiedMedia> {
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
  if (!audio) throw new Error('下载文件没有原始音频流。')
  if (!(duration > 0)) throw new Error('下载文件时长无效。')
  if (!(size > 0)) throw new Error('下载文件大小无效。')
  return {
    duration,
    size,
    videoCodec: video.codec_name ?? '',
    audioCodec: audio.codec_name ?? '',
    width: parseProbeNumber(video.width),
    height: parseProbeNumber(video.height)
  }
}

async function downloadResolvedMedia(request: VideoDownloadRequest, resolved: PublicMediaResolution): Promise<string> {
  const proxy = normalizeProxyUrl(request.config.ytdlpProxy)
  const tempPath = join(request.directory, `_dl_${request.fileStem}.public.mp4`)
  const finalPath = join(request.directory, `${request.fileStem}.mp4`)
  if (existsSync(tempPath)) unlinkSync(tempPath)
  const args = ['-hide_banner', '-loglevel', 'warning', '-y']
  const addInput = (url: string) => {
    args.push(
      '-rw_timeout', '30000000',
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
  await request.runCommand(request.vendor.ffmpegExecutable, args, undefined, '公开媒体下载')
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
    return (request.resolveFacebookPublicMedia ?? resolveFacebookPublicMedia)(request.url, request.config.ytdlpProxy)
  }
  return (request.resolvePublicMedia ?? resolvePublicMedia)(
    request.url,
    platform,
    request.config.ytdlpProxy,
    request.config.ytdlpMaxHeight
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
      resolve: () => request.resolveTikTokBrowserMedia!(request.url, request.config.ytdlpProxy)
    })
  }
  if (platform === 'Facebook' && request.resolveFacebookAnonymousMedia) {
    fallbacks.push({
      strategy: 'facebook-browser',
      resolveAttempts: 1,
      resolve: () => request.resolveFacebookAnonymousMedia!(request.url, request.config.ytdlpProxy)
    })
  }
  return fallbacks
}

async function runYtdlpPublic(request: VideoDownloadRequest): Promise<string> {
  return runYtdlp(request)
}

async function runYtdlpAuthenticated(request: VideoDownloadRequest, authentication: AuthenticatedCookieFile): Promise<string> {
  return runYtdlp(request, authentication)
}

function ytdlpAuthenticationArgs(request: VideoDownloadRequest, authentication?: AuthenticatedCookieFile): string[] {
  const args: string[] = []
  const proxy = normalizeProxyUrl(request.config.ytdlpProxy)
  if (proxy) args.push('--proxy', proxy)
  if (authentication?.path) args.push('--cookies', authentication.path)
  if (authentication?.userAgent?.trim()) args.push('--user-agent', authentication.userAgent.trim())
  return args
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
  const args = [
    '--ignore-config', '--newline', '--no-playlist', '--no-warnings',
    '--skip-download', '--simulate',
    ...ytdlpAuthenticationArgs(request, authentication),
    '-f', ytdlpVideoFormat(request.config.ytdlpMaxHeight),
    request.url
  ]
  await request.runCommand(request.vendor.ytdlpExecutable, args, undefined, 'yt-dlp 认证预检')
}

async function runYtdlp(request: VideoDownloadRequest, authentication?: AuthenticatedCookieFile): Promise<string> {
  const tempStem = `_dl_${request.fileStem}`
  const args = [
    '--ignore-config', '--newline', '--no-playlist', '--no-warnings',
    '--ffmpeg-location', dirname(request.vendor.ffmpegExecutable),
    '--merge-output-format', 'mp4',
    '-o', join(request.directory, `${tempStem}.%(ext)s`)
  ]
  args.push(...ytdlpAuthenticationArgs(request, authentication))
  args.push('-f', ytdlpVideoFormat(request.config.ytdlpMaxHeight))
  if (request.config.ytdlpExtraArgs.trim()) args.push(...publicYtdlpExtraArgs(request.config.ytdlpExtraArgs.trim()))
  const onLine = (line: string) => {
    const percent = line.match(/(\d+(?:\.\d+)?)%/)
    if (percent) request.updateProgress(Math.min(28, Math.max(1, Number(percent[1]) * 0.28)), `正在下载视频 ${percent[1]}%`)
    else if (/Extracting URL/i.test(line)) request.updateProgress(2, '正在解析视频链接…')
    else if (/Downloading webpage|Downloading android|Downloading m3u8|Downloading player/i.test(line)) request.updateProgress(4, '正在获取视频信息…')
    else if (/\[download\]\s+Destination:/i.test(line)) request.updateProgress(8, '开始下载视频文件…')
  }
  try {
    await request.runCommand(request.vendor.ytdlpExecutable, [...args, request.url], onLine, 'yt-dlp')
    return finalizeYtdlpDownload(request.directory, tempStem, request.fileStem)
  } catch (error) {
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
  const media = await (request.verifyMediaFile ?? verifyDownloadedMedia)(path, request.vendor.ffmpegExecutable)
  return { path, platform, strategy, media, failures }
}

/** Canonical download pipeline used by both `download` and `req1` tasks. */
export async function downloadVideo(request: VideoDownloadRequest): Promise<VideoDownloadResult> {
  const checked = assertDownloadableVideoUrl(request.url)
  const failures: VideoDownloadResult['failures'] = []
  const tryResolved = async (
    strategy: VideoDownloadStrategy,
    resolver: () => Promise<PublicMediaResolution>,
    resolveAttempts = 1
  ): Promise<VideoDownloadResult | undefined> => {
    try {
      request.updateProgress(4, strategy === 'public-page' ? '正在解析公开页面最高质量媒体流…' : '正在使用匿名浏览器捕获公开媒体流…')
      const attemptResolution = async (resolution: PublicMediaResolution): Promise<VideoDownloadResult> => {
        const candidates = [resolution.videoUrl, ...(resolution.alternateVideoUrls ?? [])]
        let lastError: unknown
        for (const videoUrl of candidates) {
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
      for (let attempt = 1; attempt <= resolveAttempts; attempt += 1) {
        try {
          firstResolution = await resolver()
          break
        } catch (error) {
          resolutionError = error
          if (attempt < resolveAttempts) {
            request.updateProgress(5, `匿名浏览器未捕获到媒体流，正在重试（${attempt + 1}/${resolveAttempts}）…`)
          }
        }
      }
      if (!firstResolution) throw resolutionError ?? new Error('解析器没有返回媒体流。')
      try {
        return await attemptResolution(firstResolution)
      } catch {
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

  // YouTube 跳过公开解析，直接走登录态
  if (checked.platform !== 'YouTube') {
    const direct = await tryResolved('public-page', () => resolvePrimaryPublicMedia(request, checked.platform))
    if (direct) return direct

    for (const fallback of publicFallbacks(request, checked.platform)) {
      const result = await tryResolved(fallback.strategy, fallback.resolve, fallback.resolveAttempts)
      if (result) return result
    }
  }

  let browserSessionExported = false
  let ytdlpAuthenticationFailure: string | undefined
  // Facebook is intentionally kept on its direct public/DASH + anonymous
  // browser pipeline. Do not reintroduce a logged-in profile or yt-dlp there.
  if (checked.platform !== 'Facebook' && request.resolveAuthenticatedCookies) {
    try {
      request.updateProgress(4, checked.platform === 'YouTube' ? '正在读取已登录浏览器会话…' : '公开解析失败，正在读取已登录浏览器会话…')
      const cookieFile = await request.resolveAuthenticatedCookies(checked.platform)
      if (cookieFile) {
        browserSessionExported = true
        try {
          request.updateProgress(5, '正在验证浏览器登录会话…')
          await runYtdlpAuthenticationPreflight(request, cookieFile)
          request.updateProgress(6, '浏览器会话验证通过，正在下载…')
          const path = await runYtdlpAuthenticated(request, cookieFile)
          return await verifyResult(request, path, checked.platform, 'yt-dlp-authenticated', failures)
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
    if (!request.resolveAuthenticatedCookies || !browserSessionExported) {
      throw new Error('YouTube 视频需要登录后才能下载。请在【全局设置】→【平台登录配置】中配置 YouTube 登录状态。')
    }
    if (ytdlpAuthenticationFailure) {
      throw new Error(`YouTube 浏览器登录有效，但 yt-dlp 鉴权失败：${ytdlpAuthenticationFailure}`)
    }
    throw new Error(`YouTube 视频下载失败：${failures.map((item) => `${item.strategy}：${item.message}`).join('；')}。请检查 YouTube 登录状态是否有效。`)
  }

  if (checked.platform === 'TikTok') {
    if (!request.resolveAuthenticatedCookies && failures.length > 0) {
      throw new Error(`TikTok 视频公开解析失败：${failures.map((item) => `${item.strategy}：${item.message}`).join('；')}。建议在【全局设置】→【平台登录配置】中配置 TikTok 登录状态以提高成功率。`)
    }
  }

  if (checked.platform === 'Facebook') {
    if (!request.resolveAuthenticatedCookies && failures.length > 0) {
      throw new Error(`Facebook 视频公开解析失败：${failures.map((item) => `${item.strategy}：${item.message}`).join('；')}。建议在【全局设置】→【平台登录配置】中配置 Facebook 登录状态以提高成功率。`)
    }
    throw new Error(`Facebook 公开视频直连失败：${failures.map((item) => `${item.strategy}：${item.message}`).join('；')}`)
  }

  if (checked.platform === 'Instagram') {
    if (!request.resolveAuthenticatedCookies && failures.length > 0) {
      throw new Error(`Instagram 视频公开解析失败：${failures.map((item) => `${item.strategy}：${item.message}`).join('；')}。建议在【全局设置】→【平台登录配置】中配置 Instagram 登录状态以提高成功率。`)
    }
  }

  try {
    request.updateProgress(4, '公开直链解析失败，正在使用匿名 yt-dlp 兜底…')
    const path = await runYtdlpPublic(request)
    return await verifyResult(request, path, checked.platform, 'yt-dlp-public', failures)
  } catch (error) {
    failures.push({ strategy: 'yt-dlp-public', message: errorMessage(error) })
  }

  if (ytdlpAuthenticationFailure) {
    throw new Error(`${checked.platform} 浏览器登录有效，但 yt-dlp 鉴权失败：${ytdlpAuthenticationFailure}`)
  }

  throw new Error(`公开视频下载失败：${failures.map((item) => `${item.strategy}：${item.message}`).join('；')}`)
}
