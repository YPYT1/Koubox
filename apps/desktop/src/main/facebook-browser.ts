import { BrowserWindow, session } from 'electron'
import { normalizeProxyUrl } from '@koubox/shared'
import { extractFacebookMedia, type PublicMediaResolution } from '@koubox/core'

const FACEBOOK_BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForFacebookMedia(window: BrowserWindow, url: string) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const html = await window.webContents.executeJavaScript('document.documentElement.outerHTML', true) as string
    const media = extractFacebookMedia(html, url)
    if (media) return media
    await sleep(500)
  }
  throw new Error('Facebook 页面加载完成，但 8 秒内没有暴露可下载的视频流。')
}

export async function resolveFacebookAnonymousWithChromium(url: string, proxy: string): Promise<PublicMediaResolution> {
  const partition = `koubox-facebook-anonymous-${Date.now()}-${Math.random().toString(16).slice(2)}`
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
  try {
    await window.loadURL(url, { userAgent: FACEBOOK_BROWSER_USER_AGENT })
    const media = await waitForFacebookMedia(window, url)
    return { ...media, source: 'facebook-browser', userAgent: FACEBOOK_BROWSER_USER_AGENT }
  } finally {
    if (!window.isDestroyed()) window.destroy()
    await isolatedSession.clearStorageData().catch(() => undefined)
  }
}
