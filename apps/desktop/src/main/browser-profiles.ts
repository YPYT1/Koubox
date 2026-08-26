import { BrowserWindow, session } from 'electron'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserProfile, ChromeProfileLoginProbe, YtdlpCookiePlatformId } from '@koubox/shared'
import {
  normalizeBrowserProfile,
  normalizeProxyUrl,
  PLATFORM_COOKIE_RULES,
  PLATFORM_HOMEPAGES,
  platformLabel
} from '@koubox/shared'
import { extractFacebookMedia, type PublicMediaResolution } from '@koubox/core'

type ChromeLocalState = {
  profile?: { info_cache?: Record<string, { name?: string }> }
}

type BitBrowserCookie = {
  name?: string
  value?: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
}

type CookieFile = {
  path: string
  /** Must accompany the exported cookies so yt-dlp uses the same Chromium UA. */
  userAgent: string
  cleanup(): Promise<void>
}

const FACEBOOK_BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'

function chromeUserDataDirectory(): string | undefined {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) return undefined
  return join(localAppData, 'Google', 'Chrome', 'User Data')
}

function bitBrowserRootDirectory(): string | undefined {
  const appData = process.env.APPDATA
  if (!appData) return undefined
  return join(appData, 'bitbrowser')
}

function bitBrowserApiBase(): string {
  const root = bitBrowserRootDirectory()
  if (root) {
    const configPath = join(root, 'config.json')
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf8')) as { localServerAddress?: string }
        if (typeof config.localServerAddress === 'string' && config.localServerAddress.trim()) {
          return config.localServerAddress.trim().replace(/\/$/, '')
        }
      } catch { /* default below */ }
    }
  }
  return 'http://127.0.0.1:54345'
}

function profileDirectories(root: string): string[] {
  const localState = join(root, 'Local State')
  let profileNames: Record<string, { name?: string }> = {}
  try {
    profileNames = (JSON.parse(readFileSync(localState, 'utf8')) as ChromeLocalState).profile?.info_cache ?? {}
  } catch {
    // Chrome can rebuild Local State; directories remain a valid scan fallback.
  }
  return Object.keys(profileNames)
    .filter((name) => /^(Default|Profile \d+)$/i.test(name))
    .filter((name) => existsSync(join(root, name, 'Network', 'Cookies')) || existsSync(join(root, name, 'Cookies')))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

export async function scanChromeProfiles(): Promise<BrowserProfile[]> {
  const root = chromeUserDataDirectory()
  if (!root || !existsSync(root)) return []
  let labels: Record<string, { name?: string }> = {}
  try {
    labels = (JSON.parse(readFileSync(join(root, 'Local State'), 'utf8')) as ChromeLocalState).profile?.info_cache ?? {}
  } catch { /* directory names remain usable */ }
  return profileDirectories(root).map((profileDirectory) => ({
    browser: 'chrome',
    userDataDirectory: root,
    profileDirectory,
    label: `Chrome · ${labels[profileDirectory]?.name?.trim() || profileDirectory}`
  }))
}

async function postBitBrowserJson<T>(path: string, body: unknown): Promise<T> {
  const base = new URL(bitBrowserApiBase())
  const payload = Buffer.from(JSON.stringify(body))
  const transport = base.protocol === 'https:' ? httpsRequest : httpRequest
  return await new Promise<T>((resolve, reject) => {
    const req = transport(
      {
        hostname: base.hostname,
        port: base.port || (base.protocol === 'https:' ? 443 : 80),
        path: `${base.pathname.replace(/\/$/, '')}${path}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length
        },
        timeout: 8_000
      },
      (response) => {
        let text = ''
        response.on('data', (chunk) => { text += chunk })
        response.on('end', () => {
          try {
            resolve(JSON.parse(text) as T)
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('比特浏览器本地 API 超时。请确认比特浏览器已启动。'))
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

export async function scanBitBrowserProfiles(): Promise<BrowserProfile[]> {
  const root = bitBrowserRootDirectory()
  if (!root || !existsSync(root)) return []
  const cacheRoot = join(root, 'BrowserCache')
  const byId = new Map<string, BrowserProfile>()

  if (existsSync(cacheRoot)) {
    for (const id of readdirSync(cacheRoot)) {
      const userDataDirectory = join(cacheRoot, id)
      const cookiesPath = join(userDataDirectory, 'Default', 'Network', 'Cookies')
      if (!existsSync(cookiesPath) && !existsSync(join(userDataDirectory, 'Default', 'Cookies'))) continue
      byId.set(id, {
        browser: 'bitbrowser',
        userDataDirectory,
        profileDirectory: 'Default',
        label: `比特 · ${id.slice(0, 8)}`,
        bitBrowserId: id
      })
    }
  }

  try {
    let page = 0
    const pageSize = 100
    for (;;) {
      const response = await postBitBrowserJson<{
        success?: boolean
        msg?: string
        data?: { list?: Array<{ id?: string; name?: string; seq?: number }>; totalNum?: number }
      }>('/browser/list', { page, pageSize })
      if (!response.success) {
        if (byId.size === 0) {
          throw new Error(response.msg || '比特浏览器本地 API 返回失败。请确认比特浏览器已启动。')
        }
        break
      }
      const list = response.data?.list ?? []
      for (const item of list) {
        if (!item.id) continue
        const userDataDirectory = join(cacheRoot, item.id)
        const name = item.name?.trim() || (item.seq != null ? `窗口 ${item.seq}` : item.id.slice(0, 8))
        byId.set(item.id, {
          browser: 'bitbrowser',
          userDataDirectory,
          profileDirectory: 'Default',
          label: `比特 · ${name}`,
          bitBrowserId: item.id
        })
      }
      const total = response.data?.totalNum ?? list.length
      page += 1
      if (list.length === 0 || page * pageSize >= total) break
    }
  } catch (error) {
    if (byId.size === 0) throw error
  }

  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
}

/** 扫描本机 Chrome + 比特浏览器配置。 */
export async function scanBrowserProfiles(): Promise<BrowserProfile[]> {
  const chrome = await scanChromeProfiles()
  let bitbrowser: BrowserProfile[] = []
  try {
    bitbrowser = await scanBitBrowserProfiles()
  } catch {
    // Chrome results still usable when BitBrowser API is offline.
  }
  return [...chrome, ...bitbrowser]
}

function copyIfPresent(source: string, destination: string): void {
  if (existsSync(source)) copyFileSync(source, destination)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Builds a small, disposable Chromium profile containing only the selected
 * profile's cookie store. This avoids locking or mutating the user's live
 * Chrome profile while Electron reads the same Windows-encrypted cookies.
 */
function cloneProfileForSession(profile: BrowserProfile): string {
  const normalized = normalizeBrowserProfile(profile)
  const root = normalized.userDataDirectory
  const source = join(root, normalized.profileDirectory)
  if (!existsSync(join(root, 'Local State'))) throw new Error('所选 Chrome 用户数据目录缺少 Local State。')
  if (!existsSync(source)) throw new Error('所选 Chrome 配置文件目录不存在。')
  const tempRoot = join(tmpdir(), 'koubox-temp')
  mkdirSync(tempRoot, { recursive: true })
  const destination = mkdtempSync(join(tempRoot, 'chrome-profile-'))
  try {
    copyFileSync(join(root, 'Local State'), join(destination, 'Local State'))
    const sourceNetwork = join(source, 'Network')
    if (existsSync(sourceNetwork)) {
      mkdirSync(join(destination, 'Network'), { recursive: true })
      for (const filename of ['Cookies', 'Cookies-wal', 'Cookies-shm']) {
        copyIfPresent(join(sourceNetwork, filename), join(destination, 'Network', filename))
      }
    }
    for (const filename of ['Cookies', 'Cookies-wal', 'Cookies-shm', 'Preferences']) {
      copyIfPresent(join(source, filename), join(destination, filename))
    }
    if (!existsSync(join(destination, 'Network', 'Cookies')) && !existsSync(join(destination, 'Cookies'))) {
      throw new Error('所选 Chrome 配置文件中未找到 Cookie 数据库。')
    }
    return destination
  } catch (error) {
    rmSync(destination, { recursive: true, force: true })
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EBUSY' || code === 'EPERM') {
      throw new Error('所选 Chrome 配置文件正在被 Chrome 占用。关闭该配置文件的全部 Chrome 窗口后重试；公开视频仍可走匿名直连。')
    }
    throw error
  }
}

/** Chromium may keep Cache files locked briefly; never block the probe on cleanup. */
function disposeClonedProfileSession(
  profileSession: Electron.Session,
  profileClone: string,
  window?: BrowserWindow
): void {
  if (window && !window.isDestroyed()) window.destroy()
  void (async () => {
    await sleep(120)
    await profileSession.clearStorageData().catch(() => undefined)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        rmSync(profileClone, { recursive: true, force: true, maxRetries: 2, retryDelay: 80 })
        return
      } catch {
        await sleep(150 * (attempt + 1))
      }
    }
  })()
}

function cookieHeader(cookies: Electron.Cookie[]): string | undefined {
  const value = cookies.filter((item) => item.name && item.value).map((item) => `${item.name}=${item.value}`).join('; ')
  return value || undefined
}

function cookieNamesMissing(
  cookies: Array<{ name?: string; domain?: string }>,
  platformId: YtdlpCookiePlatformId
): string[] {
  const rule = PLATFORM_COOKIE_RULES.find((item) => item.id === platformId)
  if (!rule) throw new Error(`未知平台：${platformId}`)
  const names = new Set(
    cookies
      .filter((cookie) => cookieDomainMatches(cookie.domain ?? '', rule.domainTest))
      .map((cookie) => cookie.name)
      .filter((name): name is string => Boolean(name))
  )
  return rule.requiredNames.filter((name) => !names.has(name))
}

function platformCookies<T extends { domain?: string }>(cookies: T[], platformId: YtdlpCookiePlatformId): T[] {
  const rule = PLATFORM_COOKIE_RULES.find((item) => item.id === platformId)
  if (!rule) throw new Error(`未知平台：${platformId}`)
  return cookies.filter((cookie) => cookieDomainMatches(cookie.domain ?? '', rule.domainTest))
}

function cookiesToNetscape(cookies: Array<{
  name?: string
  value?: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  expirationDate?: number
  expires?: number
}>): string {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# This file is temporary and is deleted after the download task.'
  ]
  for (const cookie of cookies) {
    if (!cookie.name || cookie.value == null || !cookie.domain) continue
    const domain = cookie.httpOnly && !cookie.domain.startsWith('#HttpOnly_')
      ? `#HttpOnly_${cookie.domain}`
      : cookie.domain
    const includeSubdomains = cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE'
    const expiryValue = cookie.expirationDate ?? cookie.expires ?? 0
    const expiry = Number.isFinite(expiryValue) && Number(expiryValue) > 0 ? Math.floor(Number(expiryValue)) : 0
    lines.push(`${domain}\t${includeSubdomains}\t${cookie.path || '/'}\t${cookie.secure ? 'TRUE' : 'FALSE'}\t${expiry}\t${cookie.name}\t${cookie.value}`)
  }
  return `${lines.join('\n')}\n`
}

/** Creates a per-task yt-dlp cookie file from the selected Chrome / 比特 profile. */
export async function exportBrowserProfileCookies(
  profile: BrowserProfile,
  platformId: YtdlpCookiePlatformId
): Promise<CookieFile> {
  const normalizedProfile = normalizeBrowserProfile(profile)
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'koubox-ytdlp-cookies-'))
  const cookiesPath = join(temporaryDirectory, `${platformId}.cookies.txt`)
  let profileClone: string | undefined
  let profileSession: Electron.Session | undefined
  // BitBrowser exposes its cookie jar through the local API but not a portable
  // per-profile UA endpoint. Electron's session UA is also the UA used by this
  // desktop bridge when it probes the selected profile, so preserve it for
  // yt-dlp instead of relying on yt-dlp's unrelated default UA.
  let userAgent = session.defaultSession.getUserAgent()
  const cleanup = async (): Promise<void> => {
    if (profileSession && profileClone) {
      disposeClonedProfileSession(profileSession, profileClone)
      profileSession = undefined
      profileClone = undefined
    }
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
  try {
    let cookies: Array<Electron.Cookie | BitBrowserCookie>
    if (normalizedProfile.browser === 'bitbrowser') {
      const browserId = normalizedProfile.bitBrowserId?.trim()
      if (!browserId) throw new Error('比特浏览器配置缺少窗口 ID，请重新扫描后再选择。')
      cookies = await fetchBitBrowserCookies(browserId)
    } else {
      profileClone = cloneProfileForSession(normalizedProfile)
      profileSession = session.fromPath(profileClone)
      userAgent = profileSession.getUserAgent()
      cookies = await profileSession.cookies.get({})
    }
    const selectedCookies = platformCookies(cookies, platformId)
    const missing = cookieNamesMissing(selectedCookies, platformId)
    if (missing.length > 0) {
      throw new Error(`${platformLabel(platformId)} 登录 Cookie 不完整：缺少 ${missing.join(' / ')}。请在所选浏览器配置中重新登录后再试。`)
    }
    writeFileSync(cookiesPath, cookiesToNetscape(selectedCookies), 'utf8')
    return { path: cookiesPath, userAgent, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
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

export async function resolveFacebookWithChromeProfile(
  url: string,
  proxy: string,
  profile: BrowserProfile
): Promise<PublicMediaResolution> {
  const normalizedProfile = normalizeBrowserProfile(profile)
  if (normalizedProfile.browser !== 'chrome') throw new Error('Facebook 目前仅支持 Chrome 配置文件。')
  const profileClone = cloneProfileForSession(normalizedProfile)
  const profileSession = session.fromPath(profileClone)
  const normalizedProxy = normalizeProxyUrl(proxy)
  if (normalizedProxy) await profileSession.setProxy({ proxyRules: normalizedProxy })
  const window = new BrowserWindow({
    show: false,
    width: 960,
    height: 720,
    webPreferences: {
      session: profileSession,
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
    const cookies = await profileSession.cookies.get({ url: 'https://www.facebook.com/' })
    return {
      ...media,
      source: 'facebook-browser',
      userAgent: FACEBOOK_BROWSER_USER_AGENT,
      cookieHeader: cookieHeader(cookies)
    }
  } finally {
    disposeClonedProfileSession(profileSession, profileClone, window)
  }
}

function cookieDomainMatches(domain: string, domainTest: RegExp): boolean {
  const bare = domain.replace(/^\./, '')
  return domainTest.test(bare) || domainTest.test(`.${bare}`)
}

function requiredCookiesPresent(
  cookies: Array<{ name?: string; domain?: string }>,
  platformId: YtdlpCookiePlatformId
): { ok: boolean; missing: string[] } {
  const rule = PLATFORM_COOKIE_RULES.find((item) => item.id === platformId)
  if (!rule) throw new Error(`未知平台：${platformId}`)
  const names = new Set(
    cookies
      .filter((cookie) => cookieDomainMatches(cookie.domain ?? '', rule.domainTest))
      .map((cookie) => cookie.name)
  )
  const missing = rule.requiredNames.filter((name) => !names.has(name))
  if (missing.length === 0) return { ok: true, missing: [] }
  // YouTube 新登录态常以 __Secure-*PSID / LOGIN_INFO 为准，不再强依赖旧版 SID 组合。
  if (platformId === 'youtube') {
    const modernOk = names.has('__Secure-1PSID') || names.has('__Secure-3PSID')
    if (modernOk) return { ok: true, missing: [] }
  }
  return { ok: false, missing }
}

/** Login / challenge / checkpoint URLs mean the session cannot enter the real homepage. */
const HOMEPAGE_BLOCKED_URL_PATTERNS: Record<YtdlpCookiePlatformId, RegExp> = {
  youtube: /accounts\.google\.com|\/signin|ServiceLogin|\/AccountChooser|\/checkcookie/i,
  tiktok: /\/login|\/signup|passport|\/tiktokstudio\/login/i,
  instagram: /\/accounts\/login|\/accounts\/emailsignup|\/challenge\/|\/consent\/|\/auth_platform|\/accounts\/suspended/i,
  facebook: /\/login\.php|\/login\/|checkpoint|\/recover\//i
}

function formatHomepageLoadFailure(errorCode: number, errorDescription: string): string {
  const desc = `${errorDescription || ''}`.toUpperCase()
  if (
    errorCode === -100 ||
    desc.includes('CONNECTION_CLOSED') ||
    desc.includes('ERR_CONNECTION_CLOSED')
  ) {
    return '网络连接被关闭（常见于代理未就绪或 SSL 握手失败）。请确认代理可用后重试。'
  }
  if (errorCode === -101 || desc.includes('CONNECTION_RESET') || desc.includes('ERR_CONNECTION_RESET')) {
    return '网络连接被重置。请检查代理与网络后重试。'
  }
  if (
    errorCode === -107 ||
    errorCode === -202 ||
    errorCode === -200 ||
    errorCode === -201 ||
    desc.includes('SSL') ||
    desc.includes('CERT')
  ) {
    return 'SSL/证书校验失败。请检查代理是否支持 HTTPS 后重试。'
  }
  if (errorCode === -105 || desc.includes('NAME_NOT_RESOLVED')) {
    return '无法解析域名。请检查网络或 DNS 后重试。'
  }
  if (errorCode === -106 || desc.includes('INTERNET_DISCONNECTED')) {
    return '当前无网络连接。'
  }
  if (errorCode === -7 || desc.includes('TIMED_OUT') || desc.includes('TIMEOUT')) {
    return '打开首页超时。请检查代理后重试。'
  }
  if (errorCode === -21 || desc.includes('NETWORK_CHANGED')) {
    return '网络状态发生变化，请重试检测。'
  }
  if (!errorDescription && !errorCode) return '打开首页失败。请检查网络与代理后重试。'
  return `打开首页失败。请检查网络与代理后重试。`
}

function formatProbeThrownError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const upper = text.toUpperCase()
  if (upper.includes('CONNECTION_CLOSED') || upper.includes('ERR_CONNECTION_CLOSED') || /net_error\s*-?100/i.test(text)) {
    return formatHomepageLoadFailure(-100, text)
  }
  if (upper.includes('SSL') || upper.includes('CERT') || upper.includes('HANDSHAKE')) {
    return formatHomepageLoadFailure(-107, text)
  }
  if (upper.includes('CONNECTION_RESET')) return formatHomepageLoadFailure(-101, text)
  if (text.includes('打开首页')) return text
  return `检测过程出错：${text}`
}

async function loadHomepageWithTimeout(
  window: BrowserWindow,
  url: string,
  timeoutMs: number,
  userAgent?: string
): Promise<void> {
  const webContents = window.webContents
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      webContents.removeListener('did-finish-load', onOk)
      webContents.removeListener('did-fail-load', onFail)
      if (error) reject(error)
      else resolve()
    }
    const onOk = () => finish()
    const onFail = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string
    ) => {
      if (errorCode === -3) return // aborted by stop()
      finish(new Error(formatHomepageLoadFailure(errorCode, errorDescription)))
    }
    const timer = setTimeout(() => {
      try {
        if (!window.isDestroyed()) webContents.stop()
      } catch { /* ignore */ }
      finish(new Error(`打开首页超时（${Math.round(timeoutMs / 1000)} 秒）。可检查代理或先关闭占用该配置的浏览器。`))
    }, timeoutMs)
    webContents.on('did-finish-load', onOk)
    webContents.on('did-fail-load', onFail)
    void window.loadURL(url, userAgent ? { userAgent } : undefined).catch((error) => {
      finish(new Error(formatProbeThrownError(error)))
    })
  })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function buildProbeResult(input: {
  platformId: YtdlpCookiePlatformId
  label: string
  homepage: string
  finalUrl: string
  profileLabel: string
  cookieCheck: { ok: boolean; missing: string[] }
  blockedPage: boolean
}): ChromeProfileLoginProbe {
  const { platformId, label, homepage, finalUrl, profileLabel, cookieCheck, blockedPage } = input
  const loggedIn = cookieCheck.ok && !blockedPage
  let detail: string
  if (loggedIn) {
    detail = `已进入 ${label} 首页，会话可用。`
  } else if (blockedPage && cookieCheck.ok) {
    detail = `检测到登录痕迹，但打开首页被转到登录/验证页（会话失效或风控）。请在该浏览器配置里重新登录 ${label} 后再检测。`
  } else if (blockedPage) {
    detail = `打开首页后进入登录/验证页，该配置未登录 ${label}。请先在所选浏览器中登录后再检测。`
  } else if (!cookieCheck.ok) {
    detail = `该配置当前未登录 ${label}。请在所选浏览器中登录 ${label} 后再点「检测登录」。`
  } else {
    detail = `未能确认 ${label} 登录态，请重试检测。`
  }
  return { platformId, label, loggedIn, detail, homepage, finalUrl, profileLabel }
}

async function fetchBitBrowserCookies(browserId: string): Promise<BitBrowserCookie[]> {
  const response = await postBitBrowserJson<{ success?: boolean; msg?: string; data?: BitBrowserCookie[] }>(
    '/browser/cookies/get',
    { browserId }
  )
  if (!response.success || !Array.isArray(response.data)) {
    throw new Error(response.msg || '读取比特浏览器 Cookie 失败。请确认比特浏览器已启动且该窗口存在。')
  }
  return response.data
}

async function injectCookiesIntoSession(targetSession: Electron.Session, cookies: BitBrowserCookie[]): Promise<void> {
  for (const cookie of cookies) {
    if (!cookie.name || cookie.value == null || !cookie.domain) continue
    const host = cookie.domain.replace(/^\./, '')
    const secure = Boolean(cookie.secure)
    const path = cookie.path || '/'
    const url = `${secure ? 'https' : 'http'}://${host}${path.startsWith('/') ? path : `/${path}`}`
    const sameSite =
      cookie.sameSite === 'no_restriction' || cookie.sameSite === 'None'
        ? 'no_restriction'
        : cookie.sameSite === 'lax' || cookie.sameSite === 'Lax'
          ? 'lax'
          : cookie.sameSite === 'strict' || cookie.sameSite === 'Strict'
            ? 'strict'
            : undefined
    await targetSession.cookies.set({
      url,
      name: cookie.name,
      value: String(cookie.value),
      domain: cookie.domain,
      path,
      secure,
      httpOnly: Boolean(cookie.httpOnly),
      expirationDate: typeof cookie.expires === 'number' && cookie.expires > 0 ? cookie.expires : undefined,
      sameSite
    }).catch(() => undefined)
  }
  await targetSession.cookies.flushStore()
}

async function probeBitBrowserProfileLogin(
  profile: BrowserProfile,
  platformId: YtdlpCookiePlatformId,
  proxy: string
): Promise<ChromeProfileLoginProbe> {
  const browserId = profile.bitBrowserId?.trim()
  if (!browserId) throw new Error('比特浏览器配置缺少窗口 ID，请重新扫描后再选择。')
  const homepage = PLATFORM_HOMEPAGES[platformId]
  const label = platformLabel(platformId)
  const bitCookies = await fetchBitBrowserCookies(browserId)
  const cookieCheck = requiredCookiesPresent(bitCookies, platformId)
  const partition = `koubox-bitbrowser-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const profileSession = session.fromPartition(partition, { cache: false })
  const normalizedProxy = normalizeProxyUrl(proxy)
  if (normalizedProxy) await profileSession.setProxy({ proxyRules: normalizedProxy })
  await injectCookiesIntoSession(profileSession, bitCookies)
  await sleep(200)
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
    try {
      await loadHomepageWithTimeout(window, homepage, 10_000, platformId === 'facebook' ? FACEBOOK_BROWSER_USER_AGENT : undefined)
      await sleep(800)
    } catch (error) {
      const detail = formatProbeThrownError(error)
      if (cookieCheck.ok) {
        return {
          platformId,
          label,
          loggedIn: false,
          detail: `已检测到登录痕迹，但${detail}`,
          homepage,
          finalUrl: homepage,
          profileLabel: profile.label
        }
      }
      return {
        platformId,
        label,
        loggedIn: false,
        detail: `该配置当前未登录 ${label}（${detail}）。请先在所选浏览器中登录后再检测。`,
        homepage,
        finalUrl: homepage,
        profileLabel: profile.label
      }
    }
    const finalUrl = window.webContents.getURL()
    const cookies = await profileSession.cookies.get({})
    const liveCheck = requiredCookiesPresent(cookies, platformId)
    const blockedPage = HOMEPAGE_BLOCKED_URL_PATTERNS[platformId].test(finalUrl)
    return buildProbeResult({
      platformId,
      label,
      homepage,
      finalUrl,
      profileLabel: profile.label,
      cookieCheck: liveCheck.ok || cookieCheck.ok
        ? { ok: true, missing: [] }
        : liveCheck,
      blockedPage
    })
  } finally {
    if (!window.isDestroyed()) window.destroy()
    void profileSession.clearStorageData().catch(() => undefined)
  }
}

async function probeChromeProfileLoginInner(
  profile: BrowserProfile,
  platformId: YtdlpCookiePlatformId,
  proxy: string
): Promise<ChromeProfileLoginProbe> {
  const homepage = PLATFORM_HOMEPAGES[platformId]
  const label = platformLabel(platformId)
  const profileClone = cloneProfileForSession(profile)
  const profileSession = session.fromPath(profileClone)
  const normalizedProxy = normalizeProxyUrl(proxy)
  if (normalizedProxy) await profileSession.setProxy({ proxyRules: normalizedProxy })

  // Cookie-first: avoid opening homepage if session cookies are already missing.
  const seedCookies = await profileSession.cookies.get({})
  const seedCheck = requiredCookiesPresent(seedCookies, platformId)
  if (!seedCheck.ok) {
    disposeClonedProfileSession(profileSession, profileClone)
    return {
      platformId,
      label,
      loggedIn: false,
      detail: `该配置当前未登录 ${label}。请在所选浏览器中登录 ${label} 后再点「检测登录」。`,
      homepage,
      finalUrl: homepage,
      profileLabel: profile.label
    }
  }

  const window = new BrowserWindow({
    show: false,
    width: 960,
    height: 720,
    webPreferences: {
      session: profileSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  window.webContents.setAudioMuted(true)
  try {
    try {
      await loadHomepageWithTimeout(window, homepage, 10_000, platformId === 'facebook' ? FACEBOOK_BROWSER_USER_AGENT : undefined)
      await sleep(800)
    } catch (error) {
      const detail = formatProbeThrownError(error)
      return {
        platformId,
        label,
        loggedIn: false,
        detail: `已检测到登录痕迹，但${detail}`,
        homepage,
        finalUrl: homepage,
        profileLabel: profile.label
      }
    }
    const finalUrl = window.webContents.getURL()
    const cookies = await profileSession.cookies.get({})
    const cookieCheck = requiredCookiesPresent(cookies, platformId)
    const blockedPage = HOMEPAGE_BLOCKED_URL_PATTERNS[platformId].test(finalUrl)
    return buildProbeResult({
      platformId,
      label,
      homepage,
      finalUrl,
      profileLabel: profile.label,
      cookieCheck: cookieCheck.ok || seedCheck.ok ? { ok: true, missing: [] } : cookieCheck,
      blockedPage
    })
  } finally {
    disposeClonedProfileSession(profileSession, profileClone, window)
  }
}

/**
 * Opens the platform homepage with the selected browser profile session.
 * Hard-timeouts so Settings UI never stays on “检测中” forever.
 */
export async function probeChromeProfileLogin(
  profile: BrowserProfile,
  platformId: YtdlpCookiePlatformId,
  proxy: string
): Promise<ChromeProfileLoginProbe> {
  const normalizedProfile = normalizeBrowserProfile(profile)
  const run =
    normalizedProfile.browser === 'bitbrowser'
      ? probeBitBrowserProfileLogin(normalizedProfile, platformId, proxy)
      : normalizedProfile.browser === 'chrome'
        ? probeChromeProfileLoginInner(normalizedProfile, platformId, proxy)
        : Promise.reject(new Error('目前仅支持 Chrome / 比特浏览器配置文件登录检测。'))
  return withTimeout(
    run,
    16_000,
    '登录检测超时（16 秒）。请关闭占用该配置的浏览器，检查代理后重试。'
  )
}
