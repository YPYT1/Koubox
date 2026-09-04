import { randomUUID } from 'node:crypto'
import { ProxyAgent, request } from 'undici'
import { normalizeProxyUrl, parsePlatformUrl } from '@koubox/shared'
import type { PublicMediaResolution } from './public-video.js'

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com'
const API_RETRY_LIMIT = 3
const API_RETRY_BASE_MS = 400
const REDIRECT_LIMIT = 5

type BiliApiBody = {
  code?: number
  message?: string
  data?: Record<string, unknown>
  result?: Record<string, unknown>
}

type ViewPage = {
  cid?: number
  page?: number
  part?: string
}

type DashMedia = {
  id?: number
  baseUrl?: string
  base_url?: string
  backupUrl?: string[]
  backup_url?: string[]
  bandwidth?: number
  width?: number
  height?: number
  codecs?: string
  codecid?: number
}

type PlayIds = { bvid: string; aid: number; cid: number; epid?: number }

type BangumiTarget = { epid?: number; seasonId?: number }

type BangumiEpisode = {
  id?: number
  aid?: number
  bvid?: string
  cid?: number
  title?: string
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('任务已取消。')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('任务已取消。'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('任务已取消。'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 匿名设备指纹，降低「请求错误」/412 概率（非登录态） */
function createAnonymousCookie(): string {
  const id = randomUUID().replace(/-/g, '').toUpperCase()
  return `buvid3=${id}infoc; buvid4=${id}%2C${Date.now()}`
}

export async function resolveBilibiliShortUrl(
  inputUrl: string,
  proxy: string,
  signal?: AbortSignal
): Promise<{ finalUrl: string; redirectChain: string[] }> {
  const redirectChain = [inputUrl]
  const seen = new Set(redirectChain)
  let current = inputUrl
  for (let hop = 0; hop < REDIRECT_LIMIT; hop += 1) {
    throwIfAborted(signal)
    const normalizedProxy = normalizeProxyUrl(proxy)
    const dispatcher = normalizedProxy ? new ProxyAgent(normalizedProxy) : undefined
    try {
      const response = await request(current, {
        dispatcher,
        signal,
        maxRedirections: 0,
        headers: {
          accept: 'text/html,application/xhtml+xml',
          referer: 'https://www.bilibili.com/',
          'user-agent': DEFAULT_USER_AGENT
        },
        headersTimeout: 20_000,
        bodyTimeout: 20_000
      })
      await response.body.dump()
      const location = response.headers.location
      if (response.statusCode >= 300 && response.statusCode < 400 && location) {
        const next = new URL(String(location), current).toString()
        if (seen.has(next)) throw new Error('Bilibili 短链重定向出现循环。')
        seen.add(next)
        redirectChain.push(next)
        if (!/^(?:https?:\/\/)?(?:[^/]+\.)?b23\.tv\//i.test(next)) {
          return { finalUrl: next, redirectChain }
        }
        current = next
        continue
      }
      if (response.statusCode >= 200 && response.statusCode < 300) {
        throw new Error('Bilibili 短链没有返回视频重定向地址。')
      }
      throw new Error(`Bilibili 短链返回 HTTP ${response.statusCode}，没有可用的重定向目标。`)
    } finally {
      await dispatcher?.close()
    }
  }
  throw new Error('Bilibili 短链重定向次数过多。')
}

function isTransientBiliFailure(message: string, statusCode?: number): boolean {
  if (statusCode === 412 || statusCode === 429 || (statusCode !== undefined && statusCode >= 500)) return true
  return /请求错误|频繁|稍后再试|超时|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed|HTTP 412|HTTP 429|HTTP 5\d\d/i.test(message)
}

function isFatalPlayurlFailure(code: number | undefined, message: string): boolean {
  if (code === -404 || code === 62002 || code === 62004) return true
  return /不存在|已删除|已下架|不可见|啥都木有/.test(message)
}

function cdnRank(url: string): number {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host.includes('bilivideo.com')) return 0
    if (host.includes('akamaized') || host.includes('biliapi')) return 1
    return 2
  } catch {
    return 3
  }
}

function preferStableCdns(urls: string[]): string[] {
  const unique = [...new Set(urls.filter((url) => validHttpUrl(url)))]
  return unique.sort((a, b) => cdnRank(a) - cdnRank(b))
}

function collectMediaUrls(item: DashMedia | undefined): string[] {
  if (!item) return []
  const urls: string[] = []
  const primary = item.baseUrl ?? item.base_url
  if (validHttpUrl(primary)) urls.push(primary)
  for (const backup of item.backupUrl ?? item.backup_url ?? []) {
    if (validHttpUrl(backup)) urls.push(backup)
  }
  return preferStableCdns(urls)
}

function mediaUrl(item: DashMedia | undefined): string | undefined {
  return collectMediaUrls(item)[0]
}

async function biliJson(
  url: string,
  proxy: string,
  cookie: string,
  signal?: AbortSignal
): Promise<BiliApiBody> {
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= API_RETRY_LIMIT; attempt += 1) {
    throwIfAborted(signal)
    try {
      const normalizedProxy = normalizeProxyUrl(proxy)
      const response = await request(url, {
        method: 'GET',
        signal,
        dispatcher: normalizedProxy ? new ProxyAgent(normalizedProxy) : undefined,
        headers: {
          accept: 'application/json,text/plain,*/*',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          origin: REFERER,
          referer: `${REFERER}/`,
          'user-agent': DEFAULT_USER_AGENT,
          cookie
        }
      })
      const text = await response.body.text()
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const error = new Error(`Bilibili API HTTP ${response.statusCode}`)
        if (attempt < API_RETRY_LIMIT && isTransientBiliFailure(error.message, response.statusCode)) {
          lastError = error
          await sleep(API_RETRY_BASE_MS * attempt, signal)
          continue
        }
        throw error
      }
      let body: BiliApiBody
      try {
        body = JSON.parse(text) as BiliApiBody
      } catch {
        throw new Error('Bilibili API 返回了无法解析的 JSON。')
      }
      const message = body.message?.trim() || ''
      if (
        body.code !== 0
        && attempt < API_RETRY_LIMIT
        && !isFatalPlayurlFailure(body.code, message)
        && isTransientBiliFailure(message || `code=${body.code}`)
      ) {
        lastError = new Error(message || `获取播放地址失败（code=${body.code}）`)
        await sleep(API_RETRY_BASE_MS * attempt, signal)
        continue
      }
      return body
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      if (err.message === '任务已取消。') throw err
      if (attempt < API_RETRY_LIMIT && isTransientBiliFailure(err.message)) {
        lastError = err
        await sleep(API_RETRY_BASE_MS * attempt, signal)
        continue
      }
      throw err
    }
  }
  throw lastError ?? new Error('Bilibili API 请求失败。')
}

function extractVideoId(url: string): { bvid?: string; aid?: string; page: number } {
  const parsed = parsePlatformUrl(url)
  if (!parsed || parsed.platform !== 'Bilibili' || !parsed.id) {
    throw new Error('Bilibili 链接格式不正确，需要 /video/BV… 或 /video/av…。')
  }
  const pageMatch = /\bp=(\d+)/i.exec(parsed.canonicalUrl)
  const page = pageMatch ? Number(pageMatch[1]) : 1
  if (/^BV/i.test(parsed.id)) return { bvid: parsed.id, page }
  if (/^av/i.test(parsed.id)) return { aid: parsed.id.slice(2), page }
  throw new Error('Bilibili 链接格式不正确，需要 /video/BV… 或 /video/av…。')
}

function extractBangumiTarget(url: string): BangumiTarget | undefined {
  const parsed = parsePlatformUrl(url)
  if (!parsed || parsed.platform !== 'Bilibili' || parsed.kind !== 'bilibili-bangumi') return undefined
  const match = /^(ep|ss)(\d+)$/i.exec(parsed.id ?? '')
  if (!match) return undefined
  const value = Number(match[2])
  if (!(value > 0)) return undefined
  return match[1].toLowerCase() === 'ep' ? { epid: value } : { seasonId: value }
}

async function fetchView(
  ids: { bvid?: string; aid?: string },
  proxy: string,
  cookie: string,
  signal?: AbortSignal
): Promise<{ bvid: string; aid: number; cid: number; pages: ViewPage[] }> {
  const query = ids.bvid
    ? `bvid=${encodeURIComponent(ids.bvid)}`
    : `aid=${encodeURIComponent(ids.aid!)}`
  const body = await biliJson(`https://api.bilibili.com/x/web-interface/view?${query}`, proxy, cookie, signal)
  if (body.code !== 0 || !body.data) {
    throw new Error(body.message?.trim() || `获取视频信息失败（code=${body.code ?? 'unknown'}）`)
  }
  const data = body.data
  const bvid = typeof data.bvid === 'string' ? data.bvid : ids.bvid
  if (!bvid) throw new Error('视频信息缺少 bvid。')
  const aid = typeof data.aid === 'number' ? data.aid : Number(ids.aid || 0)
  if (!(aid > 0)) throw new Error('视频信息缺少 aid。')
  const pages = Array.isArray(data.pages) ? (data.pages as ViewPage[]) : []
  const firstCid = typeof data.cid === 'number' ? data.cid : pages[0]?.cid
  if (!firstCid) throw new Error('视频信息缺少 cid。')
  return { bvid, aid, cid: firstCid, pages }
}

async function fetchBangumiEpisode(
  target: BangumiTarget,
  proxy: string,
  cookie: string,
  signal?: AbortSignal
): Promise<PlayIds> {
  const query = target.epid ? `ep_id=${target.epid}` : `season_id=${target.seasonId}`
  const body = await biliJson(`https://api.bilibili.com/pgc/view/web/season?${query}`, proxy, cookie, signal)
  const result = body.result
  const episodes = result && Array.isArray(result.episodes) ? result.episodes as BangumiEpisode[] : []
  const episode = target.epid
    ? episodes.find((item) => item.id === target.epid)
    : episodes.find((item) => typeof item.cid === 'number' && typeof item.aid === 'number')
  if (body.code !== 0 || !episode) {
    throw new Error(body.message?.trim() || 'Bilibili 番剧没有可用分集。')
  }
  if (!(episode.cid && episode.aid && episode.bvid)) {
    throw new Error('Bilibili 番剧分集缺少播放参数。')
  }
  return { epid: episode.id, aid: episode.aid, bvid: episode.bvid, cid: episode.cid }
}

function pickCid(pages: ViewPage[], fallbackCid: number, page: number): number {
  if (page <= 1) return fallbackCid
  const matched = pages.find((item) => item.page === page)
  if (matched?.cid) return matched.cid
  const byIndex = pages[page - 1]
  if (byIndex?.cid) return byIndex.cid
  throw new Error(`未找到第 ${page} 分 P 的 cid。`)
}

/** 对齐 bili.js：mp4 用 platform=html5 + fnval=0；DASH 用 fnval=4048 */
function buildPlayurl(ids: PlayIds, mode: 'html5' | 'dash'): string {
  const params = new URLSearchParams({
    avid: String(ids.aid),
    bvid: ids.bvid,
    cid: String(ids.cid),
    otype: 'json',
    fourk: '1'
  })
  if (mode === 'html5') {
    params.set('qn', '80')
    params.set('fnver', '0')
    params.set('fnval', '0')
    params.set('type', 'mp4')
    params.set('platform', 'html5')
    params.set('high_quality', '1')
  } else {
    params.set('qn', '127')
    params.set('fnver', '0')
    params.set('fnval', '4048')
    params.set('type', 'dash')
    params.set('try_look', '1')
  }
  return `https://api.bilibili.com/x/player/playurl?${params.toString()}`
}

function buildBangumiPlayurl(ids: PlayIds, mode: 'html5' | 'dash'): string {
  const params = new URLSearchParams({
    ep_id: String(ids.epid),
    avid: String(ids.aid),
    bvid: ids.bvid,
    cid: String(ids.cid),
    otype: 'json',
    fourk: '1'
  })
  if (mode === 'html5') {
    params.set('qn', '80')
    params.set('fnver', '0')
    params.set('fnval', '0')
    params.set('type', 'mp4')
    params.set('platform', 'html5')
    params.set('high_quality', '1')
  } else {
    params.set('qn', '127')
    params.set('fnver', '0')
    params.set('fnval', '4048')
    params.set('type', 'dash')
  }
  return `https://api.bilibili.com/pgc/player/web/playurl?${params.toString()}`
}

function resolveHtml5(payload: Record<string, unknown>, cookie: string): PublicMediaResolution | undefined {
  const durl = Array.isArray(payload.durl) ? payload.durl : []
  const urls: string[] = []
  for (const item of durl) {
    if (!item || typeof item !== 'object') continue
    const entry = item as { url?: unknown; backup_url?: unknown }
    if (validHttpUrl(entry.url)) urls.push(entry.url)
    if (Array.isArray(entry.backup_url)) {
      for (const backup of entry.backup_url) {
        if (validHttpUrl(backup)) urls.push(backup)
      }
    }
  }
  const ordered = preferStableCdns(urls)
  const primary = ordered[0]
  if (!primary) return undefined
  return {
    source: 'bilibili-page',
    videoUrl: primary,
    alternateVideoUrls: ordered.slice(1),
    referer: REFERER,
    userAgent: DEFAULT_USER_AGENT,
    cookieHeader: cookie
  }
}

function pickDashVideo(videos: DashMedia[], maxHeight: number): DashMedia | undefined {
  const usable = videos.filter((item) => collectMediaUrls(item).length > 0)
  if (!usable.length) return undefined
  const heightLimited = maxHeight > 0
    ? usable.filter((item) => (item.height ?? 0) <= maxHeight || !(item.height ?? 0))
    : usable
  const pool = heightLimited.length ? heightLimited : usable
  // AVC 优先，便于 ffmpeg -c copy 稳定封装；再 HEVC / AV1
  for (const codecid of [7, 12, 13]) {
    const matched = pool
      .filter((item) => item.codecid === codecid)
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0))
    if (matched[0]) return matched[0]
  }
  return pool.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0]
}

function pickDashAudio(audios: DashMedia[], flac?: DashMedia): string | undefined {
  const flacUrls = collectMediaUrls(flac)
  if (flacUrls[0]) return flacUrls[0]
  const best = audios
    .filter((item) => collectMediaUrls(item).length > 0)
    .sort((a, b) => (b.id ?? 0) - (a.id ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0]
  return mediaUrl(best)
}

function resolveDash(payload: Record<string, unknown>, maxHeight: number, cookie: string): PublicMediaResolution | undefined {
  const dash = payload.dash
  if (!dash || typeof dash !== 'object') return undefined
  const dashObj = dash as {
    video?: DashMedia[]
    audio?: DashMedia[]
    flac?: { audio?: DashMedia }
  }
  const video = pickDashVideo(Array.isArray(dashObj.video) ? dashObj.video : [], maxHeight)
  const videoUrls = collectMediaUrls(video)
  if (!videoUrls[0]) return undefined
  const audioUrl = pickDashAudio(Array.isArray(dashObj.audio) ? dashObj.audio : [], dashObj.flac?.audio)
  return {
    source: 'bilibili-page',
    videoUrl: videoUrls[0],
    alternateVideoUrls: videoUrls.slice(1),
    audioUrl,
    referer: REFERER,
    userAgent: DEFAULT_USER_AGENT,
    cookieHeader: cookie
  }
}

export async function resolveBilibiliPublicMedia(
  url: string,
  proxy: string,
  maxHeight: number,
  signal?: AbortSignal
): Promise<PublicMediaResolution> {
  throwIfAborted(signal)
  const cookie = createAnonymousCookie()
  const bangumi = extractBangumiTarget(url)
  const resolvedIds: PlayIds = bangumi
    ? await fetchBangumiEpisode(bangumi, proxy, cookie, signal)
    : await (() => {
      const ids = extractVideoId(url)
      return fetchView(ids, proxy, cookie, signal).then((view) => ({
        bvid: view.bvid,
        aid: view.aid,
        cid: pickCid(view.pages, view.cid, ids.page)
      }))
    })()

  const html5Url = bangumi ? buildBangumiPlayurl({ ...resolvedIds, epid: resolvedIds.epid }, 'html5') : buildPlayurl(resolvedIds, 'html5')
  const dashUrl = bangumi ? buildBangumiPlayurl({ ...resolvedIds, epid: resolvedIds.epid }, 'dash') : buildPlayurl(resolvedIds, 'dash')
  const html5Body = await biliJson(html5Url, proxy, cookie, signal)
  if (html5Body.code === 0) {
    const payload = html5Body.data ?? html5Body.result
    if (payload && typeof payload === 'object') {
      const html5 = resolveHtml5(payload, cookie)
      if (html5) return html5
    }
  } else {
    const message = html5Body.message?.trim() || `获取播放地址失败（code=${html5Body.code}）`
    if (isFatalPlayurlFailure(html5Body.code, message)) throw new Error(message)
  }

  // 与 html5 请求稍作间隔，降低连续打 playurl 触发「请求错误」的概率
  await sleep(220, signal)

  const dashBody = await biliJson(dashUrl, proxy, cookie, signal)
  if (dashBody.code !== 0) {
    throw new Error(dashBody.message?.trim() || `获取播放地址失败（code=${dashBody.code}）`)
  }
  const payload = dashBody.data ?? dashBody.result
  if (!payload || typeof payload !== 'object') {
    throw new Error('Bilibili 未返回可用的播放地址。')
  }
  const dash = resolveDash(payload, maxHeight, cookie)
  if (dash) return dash

  throw new Error('Bilibili 未返回可用的播放地址。')
}
