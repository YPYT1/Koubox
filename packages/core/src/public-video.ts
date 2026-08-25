import { ProxyAgent, request } from 'undici'
import { normalizeProxyUrl } from '@koubox/shared'

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi-libre.kavin.rocks',
  'https://pipedapi.leptons.xyz',
  'https://piped-api.privacy.com.de',
  'https://api.piped.private.coffee',
  'https://pipedapi.darkness.services'
]

export type PublicMediaResolution = {
  source: 'tiktok-page' | 'browser' | 'piped'
  videoUrl: string
  audioUrl?: string
  referer: string
  userAgent: string
  cookieHeader?: string
}

type PipedStream = {
  url?: string
  format?: string
  mimeType?: string
  codec?: string
  quality?: string
  height?: number
  bitrate?: number
  videoOnly?: boolean
}

type PipedResponse = {
  title?: string
  videoStreams?: PipedStream[]
  audioStreams?: PipedStream[]
  error?: string
}

function validHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

async function fetchText(url: string, proxy: string, timeoutMs = 25_000): Promise<string> {
  const normalizedProxy = normalizeProxyUrl(proxy)
  const dispatcher = normalizedProxy ? new ProxyAgent(normalizedProxy) : undefined
  try {
    const response = await request(url, {
      dispatcher,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': DEFAULT_USER_AGENT
      },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs
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

async function fetchJson<T>(url: string, proxy: string, timeoutMs = 25_000): Promise<T> {
  return JSON.parse(await fetchText(url, proxy, timeoutMs)) as T
}

function collectTikTokUrls(video: Record<string, unknown>): Array<{ url: string; score: number }> {
  const candidates: Array<{ url: string; score: number }> = []
  const add = (value: unknown, score: number) => {
    if (validHttpUrl(value)) candidates.push({ url: value, score })
  }
  const addAddress = (value: unknown, score: number) => {
    if (typeof value === 'string') return add(value, score)
    if (!value || typeof value !== 'object') return
    const address = value as Record<string, unknown>
    add(address.url, score)
    add(address.Url, score)
    for (const key of ['urlList', 'UrlList']) {
      const urls = address[key]
      if (Array.isArray(urls)) urls.forEach((url, index) => add(url, score - index))
    }
  }

  addAddress(video.playAddr, 1_000_000)
  addAddress(video.PlayAddr, 1_000_000)
  const bitrateInfo = video.bitrateInfo ?? video.BitrateInfo
  if (Array.isArray(bitrateInfo)) {
    for (const item of bitrateInfo) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const bitrate = Number(row.bitrate ?? row.Bitrate ?? 0)
      addAddress(row.playAddr ?? row.PlayAddr, 2_000_000 + bitrate)
    }
  }
  addAddress(video.downloadAddr, 100_000)
  addAddress(video.DownloadAddr, 100_000)
  return candidates
}

export function extractTikTokPlayUrl(html: string, videoId: string): string | undefined {
  const script = html.match(/<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1]
  if (!script) return undefined
  const root = JSON.parse(script) as unknown
  const candidates: Array<{ url: string; score: number }> = []
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const record = value as Record<string, unknown>
    const id = String(record.id ?? record.itemId ?? record.aweme_id ?? '')
    if (id === videoId && record.video && typeof record.video === 'object') {
      candidates.push(...collectTikTokUrls(record.video as Record<string, unknown>))
    }
    Object.values(record).forEach(visit)
  }
  visit(root)
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.url
}

export function extractYoutubeVideoId(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'youtu.be') return parsed.pathname.split('/').filter(Boolean)[0]
    if (!/(^|\.)youtube\.com$/i.test(parsed.hostname)) return undefined
    const fromQuery = parsed.searchParams.get('v')
    if (fromQuery) return fromQuery
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') return parts[1]
  } catch {
    return undefined
  }
  return undefined
}

function streamHeight(stream: PipedStream): number {
  if (Number.isFinite(stream.height)) return Number(stream.height)
  return Number(stream.quality?.match(/(\d+)p/i)?.[1] ?? 0)
}

export function selectPipedStreams(data: PipedResponse, maxHeight: number): { videoUrl: string; audioUrl?: string } | undefined {
  const ceiling = maxHeight > 0 ? maxHeight : Number.MAX_SAFE_INTEGER
  const videos = (data.videoStreams ?? [])
    .filter((stream) => validHttpUrl(stream.url) && streamHeight(stream) <= ceiling)
    .sort((a, b) => {
      const codecA = /h264|avc1/i.test(`${a.codec ?? ''} ${a.mimeType ?? ''}`) ? 1 : 0
      const codecB = /h264|avc1/i.test(`${b.codec ?? ''} ${b.mimeType ?? ''}`) ? 1 : 0
      return codecB - codecA || streamHeight(b) - streamHeight(a) || Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0)
    })
  const muxed = videos.find((stream) => stream.videoOnly === false)
  if (muxed?.url) return { videoUrl: muxed.url }
  const video = videos[0]
  if (!video?.url) return undefined
  const audio = (data.audioStreams ?? [])
    .filter((stream) => validHttpUrl(stream.url))
    .sort((a, b) => {
      const mp4A = /m4a|mp4|mp4a/i.test(`${a.format ?? ''} ${a.mimeType ?? ''} ${a.codec ?? ''}`) ? 1 : 0
      const mp4B = /m4a|mp4|mp4a/i.test(`${b.format ?? ''} ${b.mimeType ?? ''} ${b.codec ?? ''}`) ? 1 : 0
      return mp4B - mp4A || Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0)
    })[0]
  return { videoUrl: video.url, audioUrl: audio?.url }
}

async function resolveTikTok(url: string, proxy: string): Promise<PublicMediaResolution> {
  const videoId = new URL(url).pathname.match(/\/video\/(\d+)/)?.[1]
  if (!videoId) throw new Error('TikTok 链接中没有视频 ID。')
  const html = await fetchText(url, proxy)
  const videoUrl = extractTikTokPlayUrl(html, videoId)
  if (!videoUrl) throw new Error('TikTok 页面没有返回公开视频直链。')
  return { source: 'tiktok-page', videoUrl, referer: url, userAgent: DEFAULT_USER_AGENT }
}

async function resolveYoutube(url: string, proxy: string, maxHeight: number): Promise<PublicMediaResolution> {
  const videoId = extractYoutubeVideoId(url)
  if (!videoId) throw new Error('YouTube 链接中没有视频 ID。')
  const failures: string[] = []
  for (const instance of PIPED_INSTANCES) {
    try {
      const data = await fetchJson<PipedResponse>(`${instance}/streams/${encodeURIComponent(videoId)}`, proxy, 20_000)
      if (data.error) throw new Error(data.error)
      const streams = selectPipedStreams(data, maxHeight)
      if (!streams) throw new Error('没有可用的视频流')
      return {
        source: 'piped',
        ...streams,
        referer: instance,
        userAgent: DEFAULT_USER_AGENT
      }
    } catch (error) {
      failures.push(`${new URL(instance).hostname}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`YouTube 公共解析实例均失败：${failures.join('；')}`)
}

export async function resolvePublicMedia(
  url: string,
  platform: string,
  proxy: string,
  maxHeight: number
): Promise<PublicMediaResolution> {
  if (platform === 'TikTok') return resolveTikTok(url, proxy)
  if (platform === 'YouTube') return resolveYoutube(url, proxy, maxHeight)
  throw new Error(`${platform} 没有配置公开页面回退解析器。`)
}
