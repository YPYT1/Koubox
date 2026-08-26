/**
 * 直接视频解析器 - 无需 yt-dlp，直接获取视频真实下载链接
 * 参考 cobalt 开源项目的实现思路
 */

import { request, ProxyAgent } from 'undici'
import { normalizeProxyUrl } from '@koubox/shared'
import { createLogger } from '@koubox/shared/logger'

const log = createLogger('direct-parser')

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'

export type VideoQuality = 'hd' | 'sd' | 'best'

export type DirectVideoResult = {
  success: true
  platform: 'youtube' | 'tiktok' | 'instagram' | 'facebook'
  videoUrl: string
  audioUrl?: string
  quality: VideoQuality
  filename: string
  headers?: Record<string, string>
} | {
  success: false
  error: string
  canRetryWithYtdlp: boolean
}

type FetchOptions = {
  proxy?: string
  timeout?: number
  headers?: Record<string, string>
}

async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const { proxy, timeout = 25000, headers = {} } = options
  const normalizedProxy = proxy ? normalizeProxyUrl(proxy) : undefined
  const dispatcher = normalizedProxy ? new ProxyAgent(normalizedProxy) : undefined

  try {
    const response = await request(url, {
      dispatcher,
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers
      },
      headersTimeout: timeout,
      bodyTimeout: timeout
    })

    if (response.statusCode < 200 || response.statusCode >= 300) {
      await response.body.dump()
      throw new Error(`HTTP ${response.statusCode}`)
    }

    return response.body.text()
  } finally {
    await dispatcher?.close()
  }
}

async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, options)
  return JSON.parse(text) as T
}

// ==================== TikTok 解析 ====================

type TikTokVideoData = {
  video?: {
    playAddr?: string | { urlList?: string[] }
    bitrateInfo?: Array<{
      PlayAddr?: { UrlList?: string[] }
      Bitrate?: number
      CodecType?: string
    }>
    downloadAddr?: string | { urlList?: string[] }
  }
  author?: {
    uniqueId?: string
  }
}

function extractUrlFromAddress(addr: any): string | undefined {
  if (typeof addr === 'string') return addr
  if (addr?.urlList?.[0]) return addr.urlList[0]
  if (addr?.UrlList?.[0]) return addr.UrlList[0]
  return undefined
}

function collectTikTokUrls(video: TikTokVideoData['video']): Array<{ url: string; score: number }> {
  if (!video) return []

  const candidates: Array<{ url: string; score: number }> = []

  // 优先级1: bitrateInfo（最高码率，通常无水印）
  if (video.bitrateInfo) {
    for (const item of video.bitrateInfo) {
      const bitrate = item.Bitrate || 0
      const url = extractUrlFromAddress(item.PlayAddr)
      if (url) {
        candidates.push({
          url,
          score: 2_000_000 + bitrate
        })
      }
    }
  }

  // 优先级2: playAddr
  const playUrl = extractUrlFromAddress(video.playAddr)
  if (playUrl) {
    candidates.push({ url: playUrl, score: 1_000_000 })
  }

  // 优先级3: downloadAddr
  const downloadUrl = extractUrlFromAddress(video.downloadAddr)
  if (downloadUrl) {
    candidates.push({ url: downloadUrl, score: 100_000 })
  }

  return candidates.sort((a, b) => b.score - a.score)
}

async function parseTikTok(url: string, proxy?: string): Promise<DirectVideoResult> {
  try {
    // 提取视频 ID
    const videoIdMatch = url.match(/\/video\/(\d+)/)
    if (!videoIdMatch) {
      return { success: false, error: 'Invalid TikTok URL', canRetryWithYtdlp: false }
    }
    const videoId = videoIdMatch[1]

    // 获取页面 HTML
    const html = await fetchText(`https://www.tiktok.com/@i/video/${videoId}`, { proxy })

    // 提取 __UNIVERSAL_DATA_FOR_REHYDRATION__
    const scriptMatch = html.match(/<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i)
    if (!scriptMatch) {
      log.warn('TikTok: 未找到 __UNIVERSAL_DATA_FOR_REHYDRATION__')
      return { success: false, error: 'Failed to extract video data', canRetryWithYtdlp: true }
    }

    const data = JSON.parse(scriptMatch[1])
    const videoDetail = data?.['__DEFAULT_SCOPE__']?.['webapp.video-detail']

    if (!videoDetail || videoDetail.statusMsg) {
      return { success: false, error: 'Video unavailable or deleted', canRetryWithYtdlp: false }
    }

    const detail: TikTokVideoData = videoDetail?.itemInfo?.itemStruct

    if (!detail?.video) {
      return { success: false, error: 'No video data found', canRetryWithYtdlp: true }
    }

    // 收集所有可能的视频 URL 并按优先级排序
    const candidates = collectTikTokUrls(detail.video)

    if (candidates.length === 0) {
      return { success: false, error: 'No video URLs found', canRetryWithYtdlp: true }
    }

    const bestUrl = candidates[0].url
    const username = detail.author?.uniqueId || 'unknown'

    log.info(`TikTok: 找到 ${candidates.length} 个候选 URL，选择最高质量`)

    return {
      success: true,
      platform: 'tiktok',
      videoUrl: bestUrl,
      quality: 'best',
      filename: `tiktok_${username}_${videoId}.mp4`,
      headers: {
        'Referer': 'https://www.tiktok.com/',
        'User-Agent': DEFAULT_USER_AGENT
      }
    }
  } catch (error) {
    log.error('TikTok 解析失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      canRetryWithYtdlp: true
    }
  }
}

// ==================== Instagram 解析 ====================

type InstagramMediaData = {
  video_url?: string
  video_versions?: Array<{
    url: string
    width: number
    height: number
  }>
  image_versions2?: {
    candidates: Array<{ url: string }>
  }
}

async function parseInstagram(url: string, proxy?: string): Promise<DirectVideoResult> {
  try {
    // 提取 shortcode
    const shortcodeMatch = url.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/)
    if (!shortcodeMatch) {
      return { success: false, error: 'Invalid Instagram URL', canRetryWithYtdlp: false }
    }
    const shortcode = shortcodeMatch[2]

    // 方法1: 尝试 embed 页面
    try {
      const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`
      const html = await fetchText(embedUrl, { proxy })

      // 提取 "init",[],[ ... ] 中的数据
      const initMatch = html.match(/"init",\[\],\[(.*?)\]\],/)
      if (initMatch) {
        const embedData = JSON.parse(initMatch[1])
        if (embedData?.contextJSON) {
          const context = JSON.parse(embedData.contextJSON)
          const media = context?.graphql?.shortcode_media || context?.media

          if (media?.video_url) {
            return {
              success: true,
              platform: 'instagram',
              videoUrl: media.video_url,
              quality: 'best',
              filename: `instagram_${shortcode}.mp4`,
              headers: {
                'Referer': 'https://www.instagram.com/',
                'User-Agent': DEFAULT_USER_AGENT
              }
            }
          }
        }
      }
    } catch (embedError) {
      log.warn('Instagram embed 方法失败，尝试其他方法')
    }

    // 方法2: 尝试移动 API (oembed)
    try {
      const oembedUrl = `https://i.instagram.com/api/v1/oembed/?url=https://www.instagram.com/p/${shortcode}/`
      const oembedData = await fetchJson<{ media_id?: string }>(oembedUrl, { proxy })

      if (oembedData.media_id) {
        const mediaUrl = `https://i.instagram.com/api/v1/media/${oembedData.media_id}/info/`
        const mediaInfo = await fetchJson<{ items?: InstagramMediaData[] }>(mediaUrl, {
          proxy,
          headers: {
            'x-ig-app-id': '936619743392459',
            'User-Agent': 'Instagram 275.0.0.27.98 Android'
          }
        })

        const item = mediaInfo.items?.[0]
        if (item?.video_versions?.[0]) {
          // 选择最高分辨率
          const bestVideo = item.video_versions.reduce((a, b) =>
            (a.width * a.height > b.width * b.height) ? a : b
          )

          return {
            success: true,
            platform: 'instagram',
            videoUrl: bestVideo.url,
            quality: 'best',
            filename: `instagram_${shortcode}.mp4`,
            headers: {
              'Referer': 'https://www.instagram.com/',
              'User-Agent': DEFAULT_USER_AGENT
            }
          }
        }
      }
    } catch (apiError) {
      log.warn('Instagram API 方法失败')
    }

    return {
      success: false,
      error: 'Failed to extract video URL from all methods',
      canRetryWithYtdlp: true
    }
  } catch (error) {
    log.error('Instagram 解析失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      canRetryWithYtdlp: true
    }
  }
}

// ==================== Facebook 解析 ====================

async function parseFacebook(url: string, proxy?: string): Promise<DirectVideoResult> {
  try {
    // 提取视频 ID
    let videoId: string | undefined
    let finalUrl = url

    // 处理短链接 fb.watch/xxx - 使用 undici 支持的参数
    if (url.includes('fb.watch/')) {
      const shortLinkMatch = url.match(/fb\.watch\/([A-Za-z0-9_-]+)/)
      if (shortLinkMatch) {
        try {
          const response = await request(url, {
            method: 'HEAD',
            maxRedirections: 5,
            headersTimeout: 10000
          })
          await response.body.dump()
          const location = response.headers.location as string | undefined
          if (location) {
            finalUrl = location
          }
        } catch {
          // 短链接解析失败时继续使用原始 URL
        }
      }
    }

    // 提取 video ID
    const patterns = [
      /\/videos\/(\d+)/,
      /\/reel\/(\d+)/,
      /[?&]v=(\d+)/,
      /\/watch\/\?v=(\d+)/
    ]

    for (const pattern of patterns) {
      const match = finalUrl.match(pattern)
      if (match) {
        videoId = match[1]
        break
      }
    }

    if (!videoId) {
      return { success: false, error: 'Cannot extract Facebook video ID', canRetryWithYtdlp: false }
    }

    // 获取页面 HTML
    const html = await fetchText(finalUrl, { proxy })

    // 方法1: browser_native_hd_url
    const hdMatch = html.match(/"browser_native_hd_url":"([^"]+)"/)
    if (hdMatch) {
      const videoUrl = JSON.parse(`"${hdMatch[1]}"`) // 处理转义字符
      return {
        success: true,
        platform: 'facebook',
        videoUrl,
        quality: 'hd',
        filename: `facebook_${videoId}.mp4`,
        headers: {
          'Referer': 'https://www.facebook.com/',
          'User-Agent': DEFAULT_USER_AGENT
        }
      }
    }

    // 方法2: browser_native_sd_url
    const sdMatch = html.match(/"browser_native_sd_url":"([^"]+)"/)
    if (sdMatch) {
      const videoUrl = JSON.parse(`"${sdMatch[1]}"`)
      return {
        success: true,
        platform: 'facebook',
        videoUrl,
        quality: 'sd',
        filename: `facebook_${videoId}.mp4`,
        headers: {
          'Referer': 'https://www.facebook.com/',
          'User-Agent': DEFAULT_USER_AGENT
        }
      }
    }

    return {
      success: false,
      error: 'Failed to extract Facebook video URL',
      canRetryWithYtdlp: true
    }
  } catch (error) {
    log.error('Facebook 解析失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      canRetryWithYtdlp: true
    }
  }
}

// ==================== YouTube 解析（Piped API）====================

type PipedStream = {
  url?: string
  quality?: string
  format?: string
  mimeType?: string
  codec?: string
  videoOnly?: boolean
  bitrate?: number
  height?: number
}

type PipedResponse = {
  title?: string
  videoStreams?: PipedStream[]
  audioStreams?: PipedStream[]
  error?: string
}

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi-libre.kavin.rocks',
  'https://pipedapi.leptons.xyz',
  'https://piped-api.privacy.com.de',
  'https://api.piped.private.coffee'
]

function extractYoutubeVideoId(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'youtu.be') {
      return parsed.pathname.split('/').filter(Boolean)[0]
    }
    if (/(^|\.)youtube\.com$/i.test(parsed.hostname)) {
      const fromQuery = parsed.searchParams.get('v')
      if (fromQuery) return fromQuery
      const parts = parsed.pathname.split('/').filter(Boolean)
      if (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') {
        return parts[1]
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

async function parseYoutube(url: string, proxy?: string, maxHeight?: number): Promise<DirectVideoResult> {
  try {
    const videoId = extractYoutubeVideoId(url)
    if (!videoId) {
      return { success: false, error: 'Invalid YouTube URL', canRetryWithYtdlp: false }
    }

    // 轮询 Piped 实例
    let lastError: Error | undefined
    for (const instance of PIPED_INSTANCES) {
      try {
        const apiUrl = `${instance}/streams/${videoId}`
        const data = await fetchJson<PipedResponse>(apiUrl, { proxy, timeout: 10000 })

        if (data.error) {
          log.warn(`Piped instance ${instance} 返回错误:`, data.error)
          continue
        }

        if (!data.videoStreams || data.videoStreams.length === 0) {
          log.warn(`Piped instance ${instance} 无视频流`)
          continue
        }

        // 选择最佳视频流
        let videoStreams = data.videoStreams.filter(s => s.url)

        // 应用画质限制
        if (maxHeight && maxHeight > 0) {
          videoStreams = videoStreams.filter(s => !s.height || s.height <= maxHeight)
        }

        // 优先选择 H.264/AVC1 编码（更好的兼容性）
        const h264Streams = videoStreams.filter(s =>
          s.codec?.includes('avc1') || s.codec?.includes('h264') || s.mimeType?.includes('avc1')
        )

        const candidateStreams = h264Streams.length > 0 ? h264Streams : videoStreams

        // 选择最高画质
        const bestVideo = candidateStreams.reduce((best, current) => {
          const bestHeight = best.height || 0
          const currentHeight = current.height || 0
          return currentHeight > bestHeight ? current : best
        })

        // 选择最佳音频流
        let audioUrl: string | undefined
        if (data.audioStreams && data.audioStreams.length > 0) {
          const audioStreams = data.audioStreams.filter(s => s.url)
          // 优先 M4A/MP4A 格式
          const m4aStreams = audioStreams.filter(s =>
            s.mimeType?.includes('mp4') || s.mimeType?.includes('m4a')
          )
          const candidateAudio = m4aStreams.length > 0 ? m4aStreams : audioStreams
          const bestAudio = candidateAudio.reduce((best, current) => {
            const bestBitrate = best.bitrate || 0
            const currentBitrate = current.bitrate || 0
            return currentBitrate > bestBitrate ? current : best
          })
          audioUrl = bestAudio.url
        }

        log.info(`YouTube: 使用 Piped 实例 ${instance}，画质 ${bestVideo.quality || bestVideo.height + 'p'}`)

        return {
          success: true,
          platform: 'youtube',
          videoUrl: bestVideo.url!,
          audioUrl,
          quality: 'best',
          filename: `youtube_${videoId}.mp4`,
          headers: {
            'Referer': 'https://www.youtube.com/',
            'User-Agent': DEFAULT_USER_AGENT
          }
        }
      } catch (error) {
        log.warn(`Piped instance ${instance} 失败:`, error)
        lastError = error instanceof Error ? error : new Error(String(error))
      }
    }

    // 所有实例都失败
    return {
      success: false,
      error: `All Piped instances failed: ${lastError?.message || 'unknown error'}`,
      canRetryWithYtdlp: true
    }
  } catch (error) {
    log.error('YouTube 解析失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      canRetryWithYtdlp: true
    }
  }
}

// ==================== 主入口 ====================

export async function parseVideoUrl(
  url: string,
  options: {
    proxy?: string
    maxHeight?: number
  } = {}
): Promise<DirectVideoResult> {
  const { proxy, maxHeight } = options

  // 检测平台
  if (url.includes('tiktok.com') || url.includes('vt.tiktok.com')) {
    log.info('检测到 TikTok 平台')
    return parseTikTok(url, proxy)
  }

  if (url.includes('instagram.com')) {
    log.info('检测到 Instagram 平台')
    return parseInstagram(url, proxy)
  }

  if (url.includes('facebook.com') || url.includes('fb.watch')) {
    log.info('检测到 Facebook 平台')
    return parseFacebook(url, proxy)
  }

  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    log.info('检测到 YouTube 平台')
    return parseYoutube(url, proxy, maxHeight)
  }

  return {
    success: false,
    error: 'Unsupported platform',
    canRetryWithYtdlp: false
  }
}
