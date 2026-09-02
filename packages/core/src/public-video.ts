import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ProxyAgent, request } from 'undici'
import { normalizeProxyUrl } from '@koubox/shared'
import { createLogger } from '@koubox/shared/logger'

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'
const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36'
const log = createLogger('public-video')

type ElectronProcess = NodeJS.Process & { resourcesPath?: string }

function currentResourcesPath(): string | undefined {
  return (process as ElectronProcess).resourcesPath
}

function findPackagedChromium(resourcesPath: string): string | undefined {
  const browserRoot = join(resourcesPath, 'playwright-browsers')
  if (!existsSync(browserRoot)) return undefined
  const revisions = readdirSync(browserRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^chromium-/i.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
  for (const revision of revisions) {
    for (const candidate of [
      join(browserRoot, revision.name, 'chrome-win64', 'chrome.exe'),
      join(browserRoot, revision.name, 'chrome-win', 'chrome.exe')
    ]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function findPackagedPlaywrightModule(resourcesPath: string): string | undefined {
  for (const candidate of [
    join(resourcesPath, 'app.asar', 'node_modules', 'playwright'),
    join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'playwright')
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export function resolvePackagedPlaywrightRuntime(resourcesPath?: string): {
  modulePath?: string
  executablePath?: string
} {
  if (!resourcesPath) return {}
  return {
    modulePath: findPackagedPlaywrightModule(resourcesPath),
    executablePath: findPackagedChromium(resourcesPath)
  }
}

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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('任务已取消。')
}

async function fetchPage(
  url: string,
  proxy: string,
  timeoutMs = 50_000,  // 慢速网络最多等待 50 秒
  userAgent = DEFAULT_USER_AGENT,
  signal?: AbortSignal
): Promise<{ text: string; cookieHeader?: string }> {
  throwIfAborted(signal)
  const normalizedProxy = normalizeProxyUrl(proxy)
  const dispatcher = normalizedProxy ? new ProxyAgent(normalizedProxy) : undefined
  try {
    const response = await request(url, {
      dispatcher,
      signal,
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
  } catch (error) {
    if (signal?.aborted) throw new Error('任务已取消。')
    throw error
  } finally {
    await dispatcher?.close()
  }
}

async function fetchText(
  url: string,
  proxy: string,
  timeoutMs = 50_000,
  userAgent = DEFAULT_USER_AGENT,
  signal?: AbortSignal
): Promise<string> {
  return (await fetchPage(url, proxy, timeoutMs, userAgent, signal)).text
}

async function fetchJson<T>(url: string, proxy: string, timeoutMs = 50_000, signal?: AbortSignal): Promise<T> {
  return JSON.parse(await fetchText(url, proxy, timeoutMs, DEFAULT_USER_AGENT, signal)) as T
}

function isTikTokShortHost(hostname: string): boolean {
  return /^(?:vm|vt)\.tiktok\.com$/i.test(hostname)
}

/** Remove share/search context so TikTok always loads the canonical video page. */
export function normalizeTikTokVideoUrl(inputUrl: string): string {
  const canonical = new URL(inputUrl)
  canonical.search = ''
  canonical.hash = ''
  return canonical.toString()
}

async function expandTikTokUrl(inputUrl: string, proxy: string, signal?: AbortSignal): Promise<string> {
  let current = inputUrl
  for (let hop = 0; hop < 6; hop += 1) {
    throwIfAborted(signal)
    const normalizedProxy = normalizeProxyUrl(proxy)
    const dispatcher = normalizedProxy ? new ProxyAgent(normalizedProxy) : undefined
    try {
      const response = await request(current, {
        dispatcher,
        signal,
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
    } catch (error) {
      if (signal?.aborted) throw new Error('任务已取消。')
      throw error
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

async function resolveTikTok(url: string, proxy: string, signal?: AbortSignal): Promise<PublicMediaResolution> {
  throwIfAborted(signal)
  const input = new URL(url)
  const expandedUrl = isTikTokShortHost(input.hostname) ? await expandTikTokUrl(url, proxy, signal) : url
  const canonicalUrl = normalizeTikTokVideoUrl(expandedUrl)
  const canonical = new URL(canonicalUrl)
  const videoId = canonical.pathname.match(/\/video\/(\d+)/)?.[1]
  if (!videoId) throw new Error('TikTok 链接中没有视频 ID。')
  const endpoints = [`https://www.tiktok.com/@i/video/${videoId}`, canonical.toString()]
  const failures: string[] = []
  for (const userAgent of [DEFAULT_USER_AGENT, MOBILE_USER_AGENT]) {
    for (const endpoint of endpoints) {
      throwIfAborted(signal)
      try {
        const page = await fetchPage(endpoint, proxy, 25_000, userAgent, signal)
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
        if (signal?.aborted) throw new Error('任务已取消。')
        failures.push(`${new URL(endpoint).pathname}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  throw new Error(`TikTok 静态公开页面解析失败：${failures.join('；')}`)
}

async function resolveYoutube(url: string, proxy: string, maxHeight: number, signal?: AbortSignal): Promise<PublicMediaResolution> {
  throwIfAborted(signal)
  const videoId = extractYoutubeVideoId(url)
  if (!videoId) throw new Error('YouTube 链接中没有视频 ID。')
  const failures: string[] = []
  for (const instance of PIPED_INSTANCES) {
    throwIfAborted(signal)
    try {
      const data = await fetchJson<PipedResponse>(`${instance}/streams/${encodeURIComponent(videoId)}`, proxy, 20_000, signal)
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
      if (signal?.aborted) throw new Error('任务已取消。')
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
type InstagramUrlFormat = 'reels' | 'reel' | 'post' | 'unknown'

function extractInstagramInfo(url: string): { shortcode: string; format: InstagramUrlFormat } | undefined {
  const match = url.match(/instagram\.com\/(p|reel|reels)\/([A-Za-z0-9_-]+)/)
  if (!match) return undefined

  const [, formatPath, shortcode] = match
  const format: InstagramUrlFormat =
    formatPath === 'p' ? 'post' : formatPath === 'reel' ? 'reel' : 'reels'

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
async function resolveInstagram(url: string, proxy: string, signal?: AbortSignal): Promise<PublicMediaResolution> {
  throwIfAborted(signal)
  const info = extractInstagramInfo(url)
  if (!info) throw new Error('Instagram 链接格式不正确，支持 /p/、/reel/、/reels/。')

  const normalizedProxy = normalizeProxyUrl(proxy)
  const { spawn } = await import('node:child_process')
  const resourcesPath = currentResourcesPath()
  const packagedRuntime = resolvePackagedPlaywrightRuntime(resourcesPath)
  const modulePath = packagedRuntime.modulePath
  const executablePath = packagedRuntime.executablePath
  const proxyLiteral = normalizedProxy ? JSON.stringify(normalizedProxy) : 'undefined'
  const urlLiteral = JSON.stringify(url)
  const moduleLiteral = modulePath ? JSON.stringify(modulePath) : 'undefined'
  const executableLiteral = executablePath ? JSON.stringify(executablePath) : 'undefined'
  const playwrightScript = `
const path = require('node:path');
const playwright = require(process.env.KOUBOX_PLAYWRIGHT_MODULE || ${moduleLiteral} || 'playwright');
const { chromium } = playwright;
const targetUrl = ${urlLiteral};
const proxy = ${proxyLiteral};
const executablePath = process.env.KOUBOX_PLAYWRIGHT_EXECUTABLE || ${executableLiteral};

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    ...(proxy ? { proxy: { server: proxy } } : {})
  });
  const context = await browser.newContext({ userAgent: ${JSON.stringify(DEFAULT_USER_AGENT)} });
  const page = await context.newPage();
  let bestVideo = null;
  let bestAudio = '';

  page.on('response', (response) => {
    const responseUrl = response.url();
    const contentType = response.headers()['content-type'] || '';
    if (!contentType.includes('video/mp4') || !responseUrl.includes('cdninstagram.com')) return;
    try {
      const urlObject = new URL(responseUrl);
      const efg = urlObject.searchParams.get('efg');
      if (!efg) return;
      const decoded = JSON.parse(Buffer.from(efg, 'base64').toString());
      urlObject.searchParams.delete('bytestart');
      urlObject.searchParams.delete('byteend');
      const cleanUrl = urlObject.toString();
      const tag = String(decoded.vencode_tag || '').toLowerCase();
      if (tag.includes('audio')) {
        bestAudio = cleanUrl;
        return;
      }
      const bitrate = Number(decoded.bitrate || 0);
      if (bitrate > 0 && (!bestVideo || bitrate > bestVideo.bitrate)) {
        bestVideo = { url: cleanUrl, bitrate };
      }
    } catch {}
  });

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 50_000 });
    const deadline = Date.now() + 20000;
    let firstVideoAt = 0;
    while (Date.now() < deadline) {
      if (bestVideo && !firstVideoAt) firstVideoAt = Date.now();
      if (bestVideo && bestAudio) break;
      if (firstVideoAt && Date.now() - firstVideoAt >= 8_000) break;
      await page.waitForTimeout(250);
    }
    if (!bestVideo || !bestVideo.url) throw new Error('Instagram 页面没有返回视频链接。');
    process.stdout.write('VIDEO_URL=' + bestVideo.url + '\\n');
    if (bestAudio) process.stdout.write('AUDIO_URL=' + bestAudio + '\\n');
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
})().catch((error) => {
  process.stderr.write(String(error && error.message ? error.message : error));
  process.exitCode = 1;
});
`.trim()

  return new Promise<PublicMediaResolution>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: '1' }
    if (process.versions.electron) {
      env.ELECTRON_RUN_AS_NODE = '1'
    }
    if (modulePath) env.KOUBOX_PLAYWRIGHT_MODULE = modulePath
    if (executablePath) env.KOUBOX_PLAYWRIGHT_EXECUTABLE = executablePath
    if (resourcesPath && executablePath) env.PLAYWRIGHT_BROWSERS_PATH = join(resourcesPath, 'playwright-browsers')

    log.info('Instagram 匿名解析启动', {
      packaged: Boolean(resourcesPath),
      browserPath: executablePath ?? 'playwright-default',
      proxy: normalizedProxy ? 'configured' : 'none'
    })

    const child = spawn(process.execPath, ['--eval', playwrightScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env
    })
    const onAbort = () => {
      child.kill()
      finishError(new Error('任务已取消。'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finishError = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    }
    const timeout = setTimeout(() => {
      child.kill()
      finishError(new Error('Instagram 匿名解析超时（60 秒）。'))
    }, 60_000)

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
    child.on('error', (error) => finishError(new Error(`Instagram 匿名解析进程启动失败：${error.message}`)))
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (settled) return
      const videoUrl = stdout.split(/\r?\n/).find((line) => line.startsWith('VIDEO_URL='))?.slice('VIDEO_URL='.length).trim() ?? ''
      const audioUrl = stdout.split(/\r?\n/).find((line) => line.startsWith('AUDIO_URL='))?.slice('AUDIO_URL='.length).trim() ?? ''
      if (code !== 0 || !videoUrl) {
        const detail = stderr.trim() || stdout.trim() || `子进程退出码：${code ?? 'unknown'}`
        log.error('Instagram 匿名解析失败', { code, detail: detail.slice(0, 500) })
        finishError(new Error(detail.includes('Executable doesn\'t exist')
          ? `Instagram 浏览器运行环境缺失：${detail}`
          : detail.includes('Instagram 页面没有返回视频链接')
            ? 'Instagram 页面没有返回视频链接。'
            : `Instagram 匿名解析失败：${detail}`))
        return
      }
      settled = true
      clearTimeout(timeout)
      log.info('Instagram 匿名解析完成', { hasAudio: Boolean(audioUrl) })
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
  maxHeight: number,
  signal?: AbortSignal
): Promise<PublicMediaResolution> {
  throwIfAborted(signal)
  if (platform === 'TikTok') return resolveTikTok(url, proxy, signal)
  if (platform === 'YouTube') return resolveYoutube(url, proxy, maxHeight, signal)
  if (platform === 'Instagram') return resolveInstagram(url, proxy, signal)
  if (platform === 'Facebook') {
    const { resolveFacebookPublicMedia } = await import('./facebook')
    return resolveFacebookPublicMedia(url, proxy, signal)
  }
  throw new Error(`${platform} 没有配置公开页面回退解析器。`)
}
