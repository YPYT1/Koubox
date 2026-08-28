import { BrowserWindow, session, type Cookie, type Session } from 'electron'
import {
  defaultPlatformAuth,
  pastedPlatformCookiesReady,
  PLATFORM_COOKIE_RULES,
  platformAuthMissingMessage,
  platformLabel,
  type PlatformAuthEntry,
  type PlatformAuthConfig,
  type YtdlpCookiePlatformId,
  type YtdlpCookiePlatformStatus,
  type YtdlpCookieStatus
} from '@koubox/shared'
import { createTemporaryPlatformCookieFile, type AuthenticatedCookieFile } from '@koubox/core'

export const LOGIN_PARTITION = 'persist:koubox-ytdlp-login'
const INSTAGRAM_PROBE_PARTITION = 'persist:koubox-instagram-probe'


export function loginSession() {
  return session.fromPartition(LOGIN_PARTITION)
}

export function normalizeProxyRules(proxy: string): string | null {
  const trimmed = proxy.trim()
  if (!trimmed) return null
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

export async function applyLoginSessionProxy(proxy: string): Promise<void> {
  await applyLoginSessionProxyTo(loginSession(), proxy)
}

export async function readLoginCookies(): Promise<Cookie[]> {
  return loginSession().cookies.get({})
}

function cookieDomain(cookie: Cookie): string {
  return (cookie.domain ?? '').replace(/^\./, '').toLowerCase()
}

function cookieNamesForPlatform(cookies: Cookie[], rule: (typeof PLATFORM_COOKIE_RULES)[number]): Set<string> {
  const names = new Set<string>()
  for (const cookie of cookies) {
    if (!cookie.name || !cookie.value) continue
    if (!rule.domainTest.test(cookieDomain(cookie))) continue
    if (!rule.requiredNames.includes(cookie.name)) continue
    names.add(cookie.name)
  }
  return names
}

function platformRule(platformId: YtdlpCookiePlatformId) {
  const rule = PLATFORM_COOKIE_RULES.find((item) => item.id === platformId)
  if (!rule) throw new Error(`未知平台：${platformId}`)
  return rule
}

function platformCookies(cookies: Cookie[], platformId: YtdlpCookiePlatformId): Cookie[] {
  const rule = platformRule(platformId)
  return cookies.filter((cookie) => rule.domainTest.test(cookieDomain(cookie)))
}

function instagramCheckpoint(url: string, html: string): boolean {
  const location = url.toLowerCase()
  if (/\/accounts\/login|\/challenge|\/accounts\/suspended|checkpoint|contact_point|two_factor|accounts\/password/.test(location)) {
    return true
  }
  return /请输入手机号|verify your (phone|mobile)|we suspended your account|account has been disabled|checkpoint_required|enter the confirmation code|confirm your identity/.test(html)
}

function instagramViewerId(html: string): string | undefined {
  return (
    html.match(/"viewerId"\s*:\s*"(\d+)"/)?.[1] ??
    html.match(/"viewerId"\s*:\s*(\d+)/)?.[1] ??
    html.match(/"viewer"\s*:\s*\{[^}]{0,400}?"id"\s*:\s*"(\d+)"/)?.[1] ??
    html.match(/"ds_user_id"\s*:\s*"(\d+)"/)?.[1]
  )
}

function parseNetscapeInstagramCookies(text: string): Array<{
  domain: string
  path: string
  secure: boolean
  expiry: number
  name: string
  value: string
}> {
  const rows: Array<{ domain: string; path: string; secure: boolean; expiry: number; name: string; value: string }> = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    if (!line) continue
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
    else if (line.startsWith('#')) continue
    const parts = line.split('\t')
    if (parts.length < 7) continue
    const [domain, , path, secure, expiry, name, ...valueParts] = parts
    if (!domain || !name) continue
    if (!/(?:^|\.)instagram\.com$/i.test(domain.replace(/^\./, ''))) continue
    rows.push({
      domain,
      path: path || '/',
      secure: secure.toUpperCase() === 'TRUE',
      expiry: Number(expiry) || 0,
      name,
      value: valueParts.join('\t').replace(/^"(.*)"$/, '$1')
    })
  }
  return rows
}

async function instagramHomepageReadyFromSession(
  sess: Session,
  source: 'pasted' | 'builtin'
): Promise<{ ok: boolean; detail: string }> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: sess,
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  const timer = setTimeout(() => {
    if (!win.isDestroyed()) win.webContents.stop()
  }, 18000)
  try {
    await win.loadURL('https://www.instagram.com/accounts/edit/')
    await new Promise((resolve) => setTimeout(resolve, 900))
    const url = win.webContents.getURL()
    const html = (await win.webContents.executeJavaScript('document.documentElement.outerHTML')) as string
    if (instagramCheckpoint(url, html)) {
      return {
        ok: false,
        detail: source === 'pasted'
          ? 'Instagram Cookie 已失效（验证页或封禁页），请重新导出后粘贴'
          : 'Instagram 仍在验证或封禁页，未进入个人主页'
      }
    }
    const viewerId = instagramViewerId(html)
    const onAccountPage = /instagram\.com\/accounts\//i.test(url) && !/\/accounts\/login/i.test(url)
    if (!viewerId && !onAccountPage) {
      return {
        ok: false,
        detail: source === 'pasted'
          ? 'Instagram Cookie 已失效，未能进入个人主页'
          : '未进入 Instagram 个人主页'
      }
    }
    return {
      ok: true,
      detail: source === 'pasted'
        ? `粘贴的 Cookie 有效${viewerId ? `（用户 ${viewerId}）` : '，已进入账号页'}`
        : `已进入 Instagram 个人主页${viewerId ? `（用户 ${viewerId}）` : ''}`
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(source === 'pasted' ? `无法用 Instagram Cookie 打开主页：${message}` : `无法打开 Instagram 主页确认登录：${message}`)
  } finally {
    clearTimeout(timer)
    if (!win.isDestroyed()) win.destroy()
  }
}

async function instagramPastedCookiesReady(text: string, proxy: string): Promise<{ ok: boolean; detail: string }> {
  const rows = parseNetscapeInstagramCookies(text)
  const names = new Set(rows.map((row) => row.name))
  if (!names.has('sessionid') || !names.has('ds_user_id')) {
    return { ok: false, detail: '粘贴的 Cookie 不完整，缺少 sessionid 或 ds_user_id' }
  }
  const now = Math.floor(Date.now() / 1000)
  const sessionRow = rows.find((row) => row.name === 'sessionid')
  if (sessionRow && sessionRow.expiry > 0 && sessionRow.expiry < now) {
    return { ok: false, detail: 'Instagram Cookie 已过期，请用插件重新导出后粘贴' }
  }

  const probe = session.fromPartition(INSTAGRAM_PROBE_PARTITION)
  await applyLoginSessionProxyTo(probe, proxy)
  await probe.clearStorageData({ storages: ['cookies'] })
  for (const row of rows) {
    await probe.cookies.set({
      url: 'https://www.instagram.com/',
      name: row.name,
      value: row.value,
      domain: '.instagram.com',
      path: row.path,
      secure: row.secure,
      expirationDate: row.expiry > 0 ? row.expiry : undefined,
      httpOnly: row.name === 'sessionid'
    })
  }
  return instagramHomepageReadyFromSession(probe, 'pasted')
}

async function applyLoginSessionProxyTo(sess: Session, proxy: string): Promise<void> {
  const proxyRules = normalizeProxyRules(proxy)
  if (!proxyRules) {
    await sess.setProxy({ mode: 'direct' })
    return
  }
  await sess.setProxy({ proxyRules, proxyBypassRules: '<local>' })
}

async function platformStatuses(
  cookies: Cookie[],
  platformAuth: PlatformAuthConfig,
  proxy: string,
  onlyPlatformId?: YtdlpCookiePlatformId
): Promise<YtdlpCookiePlatformStatus[]> {
  const statuses: YtdlpCookiePlatformStatus[] = []
  for (const rule of PLATFORM_COOKIE_RULES) {
    if (onlyPlatformId && rule.id !== onlyPlatformId) continue
    const auth = platformAuth[rule.id]
    const matched = cookieNamesForPlatform(cookies, rule)
    if (auth.mode === 'paste') {
      try {
        if (!auth.cookies.trim()) {
          statuses.push({
            id: rule.id,
            label: rule.label,
            loggedIn: false,
            detail: '已选粘贴 Cookie，但尚未粘贴内容'
          })
          continue
        }
        if (rule.id === 'instagram') {
          const homepage = await instagramPastedCookiesReady(auth.cookies, proxy)
          statuses.push({
            id: rule.id,
            label: rule.label,
            loggedIn: homepage.ok,
            detail: homepage.detail
          })
          continue
        }
        const ready = pastedPlatformCookiesReady(rule.id, auth.cookies)
        statuses.push({
          id: rule.id,
          label: rule.label,
          loggedIn: ready.ok,
          detail: ready.detail
        })
      } catch (error) {
        statuses.push({
          id: rule.id,
          label: rule.label,
          loggedIn: false,
          detail: error instanceof Error ? error.message : String(error)
        })
      }
      continue
    }

    if (rule.id === 'instagram') {
      try {
        if (!matched.has('sessionid') || !matched.has('ds_user_id')) {
          statuses.push({
            id: rule.id,
            label: rule.label,
            loggedIn: false,
            detail: '应用内登录未检测到 sessionid / ds_user_id'
          })
          continue
        }
        const homepage = await instagramHomepageReadyFromSession(loginSession(), 'builtin')
        statuses.push({
          id: rule.id,
          label: rule.label,
          loggedIn: homepage.ok,
          detail: homepage.detail
        })
      } catch (error) {
        statuses.push({
          id: rule.id,
          label: rule.label,
          loggedIn: false,
          detail: error instanceof Error ? error.message : String(error)
        })
      }
      continue
    }

    const missing = rule.requiredNames.filter((name) => !matched.has(name))
    const loggedIn = missing.length === 0
    statuses.push({
      id: rule.id,
      label: rule.label,
      loggedIn,
      detail: loggedIn
        ? `应用内已检测到 ${matched.size} 个关键 Cookie`
        : `应用内登录缺少 ${missing.join(' / ')}`
    })
  }
  return statuses
}

export function cookiesToNetscape(cookies: Cookie[]): string {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# https://curl.haxx.se/rfc/cookie_spec.html',
    '# This file was generated by Koubox'
  ]
  for (const cookie of cookies) {
    if (!cookie.name || cookie.value === undefined) continue
    const domain = cookie.domain ?? ''
    if (!domain) continue
    const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE'
    const path = cookie.path ?? '/'
    const secure = cookie.secure ? 'TRUE' : 'FALSE'
    const expiry = cookie.expirationDate ? Math.floor(cookie.expirationDate) : 0
    lines.push(`${domain}\t${flag}\t${path}\t${secure}\t${expiry}\t${cookie.name}\t${cookie.value}`)
  }
  return `${lines.join('\n')}\n`
}

export async function buildLoginCookieStatus(
  platformAuth: PlatformAuthConfig = defaultPlatformAuth(),
  proxy = '',
  onlyPlatformId?: YtdlpCookiePlatformId
): Promise<YtdlpCookieStatus> {
  const cookies = await readLoginCookies()
  const platforms = await platformStatuses(cookies, platformAuth, proxy, onlyPlatformId)
  return {
    exported: false,
    cookieCount: cookies.length,
    platforms
  }
}

export async function resolvePlatformAuthentication(
  platformId: YtdlpCookiePlatformId,
  auth: PlatformAuthEntry
): Promise<AuthenticatedCookieFile> {
  try {
    if (auth.mode === 'paste') {
      if (!auth.cookies.trim()) throw new Error(platformAuthMissingMessage(platformId, 'paste', 'empty-paste'))
      return createTemporaryPlatformCookieFile({
        platformId,
        source: 'paste',
        cookieText: auth.cookies,
        validatePastedCookies: true
      })
    }

    const selected = platformCookies(await readLoginCookies(), platformId)
    const names = cookieNamesForPlatform(selected, platformRule(platformId))
    const missing = platformRule(platformId).requiredNames.filter((name) => !names.has(name))
    if (missing.length > 0) {
      throw new Error(platformAuthMissingMessage(platformId, 'builtin', selected.length ? 'builtin-incomplete' : 'no-builtin-export'))
    }
    return createTemporaryPlatformCookieFile({
      platformId,
      source: 'builtin',
      cookieText: cookiesToNetscape(selected),
      userAgent: loginSession().getUserAgent(),
    })
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : `${platformLabel(platformId)} 登录解析失败`)
  }
}
