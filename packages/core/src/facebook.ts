import { ProxyAgent, request } from 'undici'
import { normalizeProxyUrl } from '@koubox/shared'

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'

const FACEBOOK_DOCUMENT_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': DEFAULT_USER_AGENT,
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'upgrade-insecure-requests': '1'
}

export type FacebookMediaResolution = {
  source: 'facebook-page' | 'facebook-browser'
  videoUrl: string
  audioUrl?: string
  referer: string
  userAgent: string
  quality: 'dash' | 'hd' | 'sd'
}

type Stream = {
  url: string
  mimeType: string
  width: number
  height: number
  bitrate: number
}

function validHttpUrl(value: string | undefined): value is string {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function decodeJsonString(value: string): string | undefined {
  try {
    const parsed = JSON.parse(`"${value}"`)
    return typeof parsed === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
}

function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(attributes)?.[1]
}

function parseDashManifest(manifest: string): { video: Stream; audio?: Stream } | undefined {
  const videos: Stream[] = []
  const audios: Stream[] = []
  const adaptationSets = manifest.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi)

  for (const adaptation of adaptationSets) {
    const [, adaptationAttributes, adaptationBody] = adaptation
    const inheritedMimeType = attribute(adaptationAttributes, 'mimeType') ?? ''
    for (const representation of adaptationBody.matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi)) {
      const [, representationAttributes, representationBody] = representation
      const url = decodeXml(/<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/i.exec(representationBody)?.[1]?.trim() ?? '')
      if (!validHttpUrl(url)) continue
      const mimeType = attribute(representationAttributes, 'mimeType') ?? inheritedMimeType
      const stream: Stream = {
        url,
        mimeType,
        width: Number(attribute(representationAttributes, 'width') ?? 0),
        height: Number(attribute(representationAttributes, 'height') ?? 0),
        bitrate: Number(attribute(representationAttributes, 'bandwidth') ?? 0)
      }
      if (/video/i.test(mimeType)) videos.push(stream)
      if (/audio/i.test(mimeType)) audios.push(stream)
    }
  }

  const video = videos.sort((a, b) => b.height - a.height || b.width - a.width || b.bitrate - a.bitrate)[0]
  if (!video) return undefined
  const audio = audios.sort((a, b) => b.bitrate - a.bitrate)[0]
  return { video, audio }
}

function manifestsFromHtml(html: string): string[] {
  const manifests: string[] = []
  for (const match of html.matchAll(/"(?:dash_manifest|dash_manifest_xml_string)":"((?:\\.|[^"\\])*)"/g)) {
    const decoded = decodeJsonString(match[1])
    if (decoded?.includes('<MPD')) manifests.push(decoded)
  }
  return manifests
}

function fieldUrls(html: string, fields: string[]): string[] {
  const urls: string[] = []
  for (const field of fields) {
    const expression = new RegExp(`"${field}":"((?:\\\\.|[^"\\\\])*)"`, 'g')
    for (const match of html.matchAll(expression)) {
      const url = decodeJsonString(match[1])
      if (validHttpUrl(url)) urls.push(url)
    }
  }
  return urls
}

/**
 * Selects Facebook's highest-resolution DASH representation, then falls back
 * to Facebook's native progressive HD/SD fields. This is deliberately pure so
 * browser and public-page paths are tested with the same parser.
 */
export function extractFacebookMedia(html: string, referer: string): FacebookMediaResolution | undefined {
  for (const manifest of manifestsFromHtml(html)) {
    const streams = parseDashManifest(manifest)
    if (streams) {
      return {
        source: 'facebook-page',
        videoUrl: streams.video.url,
        audioUrl: streams.audio?.url,
        referer,
        userAgent: DEFAULT_USER_AGENT,
        quality: 'dash'
      }
    }
  }

  const hd = fieldUrls(html, ['browser_native_hd_url', 'playable_url_quality_hd', 'playable_url'])
  if (hd[0]) {
    return { source: 'facebook-page', videoUrl: hd[0], referer, userAgent: DEFAULT_USER_AGENT, quality: 'hd' }
  }
  const sd = fieldUrls(html, ['browser_native_sd_url', 'playable_url_quality_sd'])
  if (sd[0]) {
    return { source: 'facebook-page', videoUrl: sd[0], referer, userAgent: DEFAULT_USER_AGENT, quality: 'sd' }
  }
  return undefined
}

export function isFacebookShareUrl(url: string): boolean {
  try {
    return /\/share\/[rv]\//i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

function normalizeFacebookFinalUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const reel = parsed.pathname.match(/\/reel\/(\d+)/i)
    if (reel) return `https://www.facebook.com/reel/${reel[1]}`
    const video = parsed.pathname.match(/\/videos\/(\d+)/i)
    if (video) return `https://www.facebook.com/videos/${video[1]}`
    const watchId = parsed.searchParams.get('v')
    if (watchId && /^\d+$/.test(watchId)) return `https://www.facebook.com/watch?v=${watchId}`
  } catch { /* ignore */ }
  return url
}

export async function resolveFacebookShareUrl(
  inputUrl: string,
  proxy: string,
  signal?: AbortSignal
): Promise<{ finalUrl: string; redirectChain: string[] }> {
  const redirectChain = [inputUrl]
  const seen = new Set<string>([inputUrl])
  let current = inputUrl

  for (let hop = 0; hop < 5; hop += 1) {
    if (signal?.aborted) throw new Error('任务已取消。')
    const normalizedProxy = normalizeProxyUrl(proxy)
    const dispatcher = normalizedProxy ? new ProxyAgent(normalizedProxy) : undefined
    try {
      const response = await request(current, {
        dispatcher,
        signal,
        maxRedirections: 0,
        headers: FACEBOOK_DOCUMENT_HEADERS,
        headersTimeout: 20_000,
        bodyTimeout: 20_000
      })
      await response.body.dump()
      const location = response.headers.location
      if (response.statusCode >= 300 && response.statusCode < 400 && location) {
        const next = new URL(String(location), current).toString()
        if (seen.has(next)) throw new Error('Facebook 分享链接重定向出现循环。')
        seen.add(next)
        redirectChain.push(next)
        if (!isFacebookShareUrl(next)) {
          return { finalUrl: normalizeFacebookFinalUrl(next), redirectChain }
        }
        current = next
        continue
      }
      if (response.statusCode >= 200 && response.statusCode < 300 && !isFacebookShareUrl(current)) {
        return { finalUrl: normalizeFacebookFinalUrl(current), redirectChain }
      }
      if (response.statusCode >= 200 && response.statusCode < 300 && isFacebookShareUrl(current)) {
        throw new Error('Facebook 分享链接无法跳转到视频页面。')
      }
      throw new Error(`Facebook 分享链接返回 HTTP ${response.statusCode}，没有可用的重定向目标。`)
    } catch (error) {
      if (signal?.aborted) throw new Error('任务已取消。')
      throw error
    } finally {
      await dispatcher?.close()
    }
  }
  throw new Error('Facebook 分享链接重定向次数过多。')
}

export function extractFacebookVideoId(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    const queryId = parsed.searchParams.get('v')
    if (queryId && /^\d+$/.test(queryId)) return queryId
    const match = parsed.pathname.match(/\/(?:videos|reel|reels)\/(\d+)/i)
    if (match) return match[1]
  } catch {
    return undefined
  }
  return undefined
}

async function fetchFacebookHtml(url: string, proxy: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('任务已取消。')
  const normalizedProxy = normalizeProxyUrl(proxy)
  const dispatcher = normalizedProxy ? new ProxyAgent(normalizedProxy) : undefined
  try {
    const response = await request(url, {
      dispatcher,
      signal,
      maxRedirections: 5,
      headers: {
        ...FACEBOOK_DOCUMENT_HEADERS,
        'sec-fetch-site': 'none'
      },
      headersTimeout: 25_000,
      bodyTimeout: 25_000
    })
    if (response.statusCode < 200 || response.statusCode >= 300) {
      await response.body.dump()
      throw new Error(`Facebook 页面返回 HTTP ${response.statusCode}`)
    }
    return response.body.text()
  } catch (error) {
    if (signal?.aborted) throw new Error('任务已取消。')
    throw error
  } finally {
    await dispatcher?.close()
  }
}

export async function resolveFacebookPublicMedia(url: string, proxy: string, signal?: AbortSignal): Promise<FacebookMediaResolution> {
  const failures: string[] = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal?.aborted) throw new Error('任务已取消。')
    try {
      const html = await fetchFacebookHtml(url, proxy, signal)
      const media = extractFacebookMedia(html, url)
      if (media) return media
      failures.push(`第 ${attempt + 1} 次页面没有媒体字段`)
    } catch (error) {
      if (signal?.aborted) throw new Error('任务已取消。')
      failures.push(`第 ${attempt + 1} 次：${error instanceof Error ? error.message : String(error)}`)
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Facebook 公开页面未返回可下载的视频流（${failures.join('；')}）。`)
}
