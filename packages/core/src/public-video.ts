import { ProxyAgent, request } from 'undici'
import { normalizeProxyUrl } from '@koubox/shared'

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'
const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36'

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi-libre.kavin.rocks',
  'https://pipedapi.leptons.xyz',
  'https://piped-api.privacy.com.de',
  'https://api.piped.private.coffee',
  'https://pipedapi.darkness.services'
]

export type PublicMediaResolution = {
  source: 'tiktok-page' | 'browser' | 'piped' | 'facebook-page' | 'facebook-browser' | 'instagram-page'
  videoUrl: string
  /** Same-quality or lower-ranked signed URLs to try before changing strategy. */
  alternateVideoUrls?: string[]
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

function cookieHeaderFromResponse(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers['set-cookie']
  if (!raw) return undefined
  const values = Array.isArray(raw) ? raw : [raw]
  const cookies = values
    .flatMap((value) => String(value).split(/,(?=[^;,]+=)/))
    .map((value) => value.split(';', 1)[0]?.trim())
    .filter(Boolean)
  return cookies.length > 0 ? cookies.join('; ') : undefined
}

async function fetchPage(
  url: string,
  proxy: string,
  timeoutMs = 12_000,  // 从 25 秒降低到 12 秒，加快失败切换速度
  userAgent = DEFAULT_USER_AGENT
): Promise<{ text: string; cookieHeader?: string }> {
  const normalizedProxy = normalizeProxyUrl(proxy)
  const dispatcher = normalizedProxy ? new ProxyAgent(normalizedProxy) : undefined
  try {
    const response = await request(url, {
      dispatcher,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': userAgent
      },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs
    })
    if (response.statusCode < 200 || response.statusCode >= 300) {
      await response.body.dump()
      throw new Error(`HTTP ${response.statusCode}`)
    }
    return {
      text: await response.body.text(),
      cookieHeader: cookieHeaderFromResponse(response.headers)
    }
  } finally {
    await dispatcher?.close()
  }
}

async function fetchText(url: string, proxy: string, timeoutMs = 12_000, userAgent = DEFAULT_USER_AGENT): Promise<string> {
  return (await fetchPage(url, proxy, timeoutMs, userAgent)).text
}

async function fetchJson<T>(url: string, proxy: string, timeoutMs = 12_000): Promise<T> {
  return JSON.parse(await fetchText(url, proxy, timeoutMs)) as T
}

function isTikTokShortHost(hostname: string): boolean {
  return /^(?:vm|vt)\.tiktok\.com$/i.test(hostname)
}

async function expandTikTokUrl(inputUrl: string, proxy: string): Promise<string> {
  let current = inputUrl
  for (let hop = 0; hop < 6; hop += 1) {
    const normalizedProxy = normalizeProxyUrl(proxy)
    const dispatcher = normalizedProxy ? new ProxyAgent(normalizedProxy) : undefined
    try {
      const response = await request(current, {
        dispatcher,
        maxRedirections: 0,
        headers: { 'user-agent': DEFAULT_USER_AGENT },
        headersTimeout: 20_000,
        bodyTimeout: 20_000
      })
      await response.body.dump()
      const location = response.headers.location
      if (response.statusCode >= 300 && response.statusCode < 400 && location) {
        current = new URL(String(location), current).toString()
        continue
      }
      return current
    } finally {
      await dispatcher?.close()
    }
  }
  return current
}

type TikTokCandidate = {
  url: string
  source: 'bitrateInfo' | 'playAddr'
  width: number
  height: number
  fps: number
  bitrate: number
  size: number
}

function collectTikTokUrls(video: Record<string, unknown>): TikTokCandidate[] {
  const candidates: TikTokCandidate[] = []
  const add = (value: unknown, candidate: Omit<TikTokCandidate, 'url'>) => {
    if (validHttpUrl(value)) candidates.push({ url: value, ...candidate })
  }
  const addAddress = (value: unknown, candidate: Omit<TikTokCandidate, 'url'>) => {
    if (typeof value === 'string') return add(value, candidate)
    if (!value || typeof value !== 'object') return
    const address = value as Record<string, unknown>
    const withAddress = {
      ...candidate,
      width: Number(address.width ?? address.Width ?? candidate.width),
      height: Number(address.height ?? address.Height ?? candidate.height),
      size: Number(address.dataSize ?? address.DataSize ?? candidate.size)
    }
    add(address.url, withAddress)
    add(address.Url, withAddress)
    for (const key of ['urlList', 'UrlList']) {
      const urls = address[key]
      if (Array.isArray(urls)) urls.forEach((url) => add(url, withAddress))
    }
  }

  const bitrateInfo = video.bitrateInfo ?? video.BitrateInfo
  if (Array.isArray(bitrateInfo)) {
    for (const item of bitrateInfo) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      addAddress(row.playAddr ?? row.PlayAddr, {
        source: 'bitrateInfo',
        width: Number(row.width ?? row.Width ?? video.width ?? video.Width ?? 0),
        height: Number(row.height ?? row.Height ?? video.height ?? video.Height ?? 0),
        fps: Number(row.fps ?? row.FPS ?? video.fps ?? video.FPS ?? 0),
        bitrate: Number(row.bitrate ?? row.Bitrate ?? 0),
        size: Number(row.dataSize ?? row.DataSize ?? 0)
      })
    }
  }
  addAddress(video.playAddr ?? video.PlayAddr, {
    source: 'playAddr',
    width: Number(video.width ?? video.Width ?? 0),
    height: Number(video.height ?? video.Height ?? 0),
    fps: Number(video.fps ?? video.FPS ?? 0),
    bitrate: Number(video.bitrate ?? video.Bitrate ?? 0),
    size: Number(video.dataSize ?? video.DataSize ?? 0)
  })
  const unique = new Map<string, TikTokCandidate>()
  for (const candidate of candidates) if (!unique.has(candidate.url)) unique.set(candidate.url, candidate)
  return [...unique.values()].sort((a, b) =>
    (b.width * b.height) - (a.width * a.height)
    || b.fps - a.fps
    || b.bitrate - a.bitrate
    || b.size - a.size
    || Number(b.source === 'bitrateInfo') - Number(a.source === 'bitrateInfo'))
}

export function extractTikTokPlayUrls(html: string, videoId: string): string[] {
  const script = html.match(/<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1]
  if (!script) return []
  const root = JSON.parse(script) as unknown
  const candidates: TikTokCandidate[] = []
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
  return candidates.map((candidate) => candidate.url)
}

export function extractTikTokPlayUrl(html: string, videoId: string): string | undefined {
  return extractTikTokPlayUrls(html, videoId)[0]
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
  const input = new URL(url)
  const expandedUrl = isTikTokShortHost(input.hostname) ? await expandTikTokUrl(url, proxy) : url
  const canonical = new URL(expandedUrl)
  canonical.search = ''
  canonical.hash = ''
  const videoId = canonical.pathname.match(/\/video\/(\d+)/)?.[1]
  if (!videoId) throw new Error('TikTok 链接中没有视频 ID。')
  const endpoints = [`https://www.tiktok.com/@i/video/${videoId}`, canonical.toString()]
  const failures: string[] = []
  for (const userAgent of [DEFAULT_USER_AGENT, MOBILE_USER_AGENT]) {
    for (const endpoint of endpoints) {
      try {
        const page = await fetchPage(endpoint, proxy, 25_000, userAgent)
        const videoUrls = extractTikTokPlayUrls(page.text, videoId)
        const videoUrl = videoUrls[0]
        if (!videoUrl) throw new Error('页面没有返回目标公开视频 playAddr')
        return {
          source: 'tiktok-page',
          videoUrl,
          alternateVideoUrls: videoUrls.slice(1),
          referer: canonical.toString(),
          userAgent,
          cookieHeader: page.cookieHeader
        }
      } catch (error) {
        failures.push(`${new URL(endpoint).pathname}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  throw new Error(`TikTok 静态公开页面解析失败：${failures.join('；')}`)
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

/**
 * 识别 Instagram URL 格式
 *
 * Instagram 视频只有两种格式：
 * - /reels/ ✅ 推荐页刷视频（Reels 功能），可直接解析
 * - /p/     ✅ 个人页视频、搜索结果页（Post 格式），可直接解析
 *
 * 两种格式都支持无登录公开解析。
 */
type InstagramUrlFormat = 'reels' | 'post' | 'unknown'

function extractInstagramInfo(url: string): { shortcode: string; format: InstagramUrlFormat } | undefined {
  const match = url.match(/instagram\.com\/(p|reels)\/([A-Za-z0-9_-]+)/)
  if (!match) return undefined

  const [, formatPath, shortcode] = match
  const format: InstagramUrlFormat = formatPath === 'reels' ? 'reels' : 'post'

  return { shortcode, format }
}

function extractInstagramShortcode(url: string): string | undefined {
  return extractInstagramInfo(url)?.shortcode
}

/**
 * 解析 Instagram 视频
 *
 * 支持的 URL 格式：
 * - https://www.instagram.com/reels/<shortcode>/ ✅ 推荐页刷视频（Reels）
 * - https://www.instagram.com/p/<shortcode>/      ✅ 个人页视频、搜索结果页（Post）
 *
 * 两种格式都可以无登录公开解析。
 * 使用 Playwright 打开页面并捕获 CDN 网络请求来获取视频直链。
 * 通过 efg 参数（Base64 编码的元数据）来筛选最高质量的视频流。
 */
async function resolveInstagram(url: string, proxy: string): Promise<PublicMediaResolution> {
  const info = extractInstagramInfo(url)
  if (!info) throw new Error('Instagram 链接格式不正确。仅支持 /reels/ 和 /p/ 格式。')

  // 规范化代理 URL
  const normalizedProxy = normalizeProxyUrl(proxy)
  if (!normalizedProxy) {
    throw new Error('Instagram 解析需要代理配置。请在设置中配置代理后重试。')
  }

  // 使用 Playwright 捕获网络请求来获取视频 URL
  const { spawn } = await import('node:child_process')

  return new Promise<PublicMediaResolution>((resolve, reject) => {
    const playwrightScript = `
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: '${normalizedProxy}' }
  });
  const context = await browser.newContext({ userAgent: '${DEFAULT_USER_AGENT}' });
  const page = await context.newPage();

  let videoUrl = null;
  let audioUrl = null;

  page.on('response', async (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';

    if (!contentType.includes('video/mp4')) return;
    if (!url.includes('cdninstagram.com')) return;

    try {
      const urlObj = new URL(url);
      const efg = urlObj.searchParams.get('efg');
      if (!efg) return;

      const decoded = JSON.parse(Buffer.from(efg, 'base64').toString());

      urlObj.searchParams.delete('bytestart');
      urlObj.searchParams.delete('byteend');
      const cleanUrl = urlObj.toString();

      if (decoded.vencode_tag && decoded.vencode_tag.includes('audio')) {
        audioUrl = cleanUrl;
      } else if (decoded.vencode_tag && decoded.bitrate) {
        const bitrate = decoded.bitrate;
        if (!videoUrl || bitrate > videoUrl.bitrate) {
          videoUrl = { url: cleanUrl, bitrate };
        }
      }
    } catch (e) {
      // 忽略解析错误
    }
  });

  await page.goto('${url}', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  await browser.close();

  if (videoUrl && videoUrl.url) {
    console.log('VIDEO_URL=' + videoUrl.url);
    if (audioUrl) {
      console.log('AUDIO_URL=' + audioUrl);
    }
  }
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
`.trim()

    const child = spawn('node', ['--eval', playwrightScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' }
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('close', (code: number) => {
      if (code !== 0) {
        reject(new Error(`Instagram 页面解析失败：${stderr || stdout || 'Playwright 进程异常退出'}`))
        return
      }

      let videoUrl = ''
      let audioUrl = ''

      for (const line of stdout.split('\n')) {
        if (line.startsWith('VIDEO_URL=')) {
          videoUrl = line.slice('VIDEO_URL='.length).trim()
        } else if (line.startsWith('AUDIO_URL=')) {
          audioUrl = line.slice('AUDIO_URL='.length).trim()
        }
      }

      if (!videoUrl) {
        reject(new Error('Instagram 页面没有返回视频链接。'))
        return
      }

      resolve({
        source: 'instagram-page',
        videoUrl,
        audioUrl: audioUrl || undefined,
        referer: url,
        userAgent: DEFAULT_USER_AGENT
      })
    })
  })
}

export async function resolvePublicMedia(
  url: string,
  platform: string,
  proxy: string,
  maxHeight: number
): Promise<PublicMediaResolution> {
  if (platform === 'TikTok') return resolveTikTok(url, proxy)
  if (platform === 'YouTube') return resolveYoutube(url, proxy, maxHeight)
  if (platform === 'Instagram') return resolveInstagram(url, proxy)
  if (platform === 'Facebook') {
    const { resolveFacebookPublicMedia } = await import('./facebook')
    return resolveFacebookPublicMedia(url, proxy)
  }
  throw new Error(`${platform} 没有配置公开页面回退解析器。`)
}
