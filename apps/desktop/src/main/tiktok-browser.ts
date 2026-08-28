import { BrowserWindow, session } from 'electron'
import { normalizeTikTokVideoUrl, type PublicMediaResolution } from '@koubox/core'
import { normalizeProxyUrl } from '@koubox/shared'

const TIKTOK_BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'

type CapturedMedia = {
  url: string
  requestHeaders?: Record<string, string>
}

function isTikTokMediaUrl(url: string): boolean {
  return /\/aweme\/v1\/play\/|\/video\/tos\/|mime_type=video/i.test(url)
}

function rankCapturedMedia(candidates: CapturedMedia[], videoId: string | undefined): CapturedMedia[] {
  return [...candidates].sort((a, b) => {
    const matchesA = videoId && /[?&](?:item_id|video_id)=/.test(a.url) && a.url.includes(videoId) ? 1 : 0
    const matchesB = videoId && /[?&](?:item_id|video_id)=/.test(b.url) && b.url.includes(videoId) ? 1 : 0
    const tosA = /\/video\/tos\//i.test(a.url) ? 1 : 0
    const tosB = /\/video\/tos\//i.test(b.url) ? 1 : 0
    return matchesB - matchesA || tosB - tosA || b.url.length - a.url.length
  })
}

/** Anonymous, isolated Chromium fallback for public TikTok media. */
export async function resolveTikTokBrowserMedia(url: string, proxy: string): Promise<PublicMediaResolution> {
  const canonicalUrl = normalizeTikTokVideoUrl(url)
  const partition = `koubox-public-media-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const isolatedSession = session.fromPartition(partition, { cache: false })
  const normalizedProxy = normalizeProxyUrl(proxy)
  if (normalizedProxy) await isolatedSession.setProxy({ proxyRules: normalizedProxy })
  const window = new BrowserWindow({
    show: false,
    width: 960,
    height: 720,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  window.webContents.setAudioMuted(true)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const videoId = new URL(canonicalUrl).pathname.match(/\/video\/(\d+)/)?.[1]
  const mediaRequests = new Map<string, CapturedMedia>()
  const rememberMedia = (candidate: string, requestHeaders?: Record<string, string>) => {
    if (!/^https?:\/\//i.test(candidate) || !isTikTokMediaUrl(candidate)) return
    mediaRequests.set(candidate, { url: candidate, requestHeaders })
  }
  isolatedSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    rememberMedia(details.url)
    callback({})
  })
  isolatedSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    rememberMedia(details.url, details.requestHeaders)
    callback({ requestHeaders: details.requestHeaders })
  })
  let disposing = false
  window.on('close', (event) => {
    if (!disposing) event.preventDefault()
  })
  try {
    await window.loadURL(canonicalUrl, { userAgent: TIKTOK_BROWSER_USER_AGENT })
    const deadline = Date.now() + 50_000
    let firstMediaAt = 0
    while (Date.now() < deadline) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        const videoUrls = await window.webContents.executeJavaScript(`
          Array.from(document.querySelectorAll('video'))
            .flatMap((video) => [video.currentSrc, video.src])
            .filter((src) => /^https?:\\/\\//i.test(src || ''))
        `, true) as string[]
        videoUrls.forEach((candidate) => rememberMedia(candidate))
        await window.webContents.executeJavaScript(`
          Promise.all(Array.from(document.querySelectorAll('video')).map((video) => {
            video.muted = true;
            return video.play().catch(() => undefined);
          })).then(() => true)
        `, true).catch(() => undefined)
        await window.webContents.executeJavaScript(
          'window.scrollBy(0, Math.max(300, window.innerHeight)); true',
          true
        ).catch(() => undefined)
      }
      if (mediaRequests.size > 0 && firstMediaAt === 0) firstMediaAt = Date.now()
      if (firstMediaAt && Date.now() - firstMediaAt >= 4_000) break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    }
    const candidates = rankCapturedMedia([...mediaRequests.values()], videoId)
    const selected = candidates[0]
    if (!selected) throw new Error('匿名浏览器已打开页面，但没有观察到公开视频流（页面可能被 TikTok 风控或当前网络未返回媒体请求）。')
    const cookies = await isolatedSession.cookies.get({ url: selected.url })
    return {
      source: 'browser',
      videoUrl: selected.url,
      alternateVideoUrls: candidates.slice(1).map((candidate) => candidate.url),
      referer: selected.requestHeaders?.Referer ?? selected.requestHeaders?.referer ?? canonicalUrl,
      userAgent: selected.requestHeaders?.['User-Agent']
        ?? selected.requestHeaders?.['user-agent']
        ?? isolatedSession.getUserAgent(),
      cookieHeader: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    }
  } finally {
    isolatedSession.webRequest.onBeforeRequest(null)
    isolatedSession.webRequest.onBeforeSendHeaders(null)
    disposing = true
    if (!window.isDestroyed()) window.destroy()
  }
}
