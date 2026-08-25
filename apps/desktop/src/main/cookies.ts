import { BrowserWindow, session, type Cookie, type Session } from 'electron'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  filterNetscapeCookiesForPlatform,
  pastedPlatformCookiesReady,
  PLATFORM_COOKIE_RULES,
  platformBuiltinCookiesFilename,
  type PlatformAuthConfig,
  type YtdlpCookiePlatformId,
  type YtdlpCookiePlatformStatus,
  type YtdlpCookieStatus
} from '@koubox/shared'

const INSTAGRAM_PROBE_PARTITION = 'persist:koubox-instagram-probe'

export function loginPartition(platformId: YtdlpCookiePlatformId): string {
  return `persist:koubox-login-${platformId}`
}

export function loginSession(platformId: YtdlpCookiePlatformId) {
  return session.fromPartition(loginPartition(platformId))
}

export function normalizeProxyRules(proxy: string): string | null {
  const trimmed = proxy.trim()
  if (!trimmed) return null
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

export async function applyLoginSessionProxy(platformId: YtdlpCookiePlatformId, proxy: string): Promise<void> {
  await applyLoginSessionProxyTo(loginSession(platformId), proxy)
}

export async function readLoginCookies(platformId: YtdlpCookiePlatformId): Promise<Cookie[]> {
  return loginSession(platformId).cookies.get({})
}

export function platformBuiltinCookiePath(cookieDirectory: string, platformId: YtdlpCookiePlatformId): string {
  return join(cookieDirectory, platformBuiltinCookiesFilename(platformId))
}

function platformRule(platformId: YtdlpCookiePlatformId) {
  const rule = PLATFORM_COOKIE_RULES.find((item) => item.id === platformId)
  if (!rule) throw new Error(`未知平台：${platformId}`)
  return rule
}

function cookiesForPlatform(cookies: Cookie[], platformId: YtdlpCookiePlatformId): Cookie[] {
  const rule = platformRule(platformId)
  return cookies.filter((cookie) => Boolean(cookie.name && cookie.value && rule.domainTest.test(cookieDomain(cookie))))
}

export function migrateLegacyLoginCookies(cookieDirectory: string): void {
  const legacyFile = join(cookieDirectory, 'ytdlp-cookies.txt')
  if (!existsSync(legacyFile)) return
  const legacyText = readFileSync(legacyFile, 'utf8')
  for (const rule of PLATFORM_COOKIE_RULES) {
    const target = platformBuiltinCookiePath(cookieDirectory, rule.id)
    if (existsSync(target)) continue
    const filtered = filterNetscapeCookiesForPlatform(legacyText, rule.id)
    if (filtered.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).length > 0) {
      writeFileSync(target, filtered, 'utf8')
    }
  }
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
  cookieDirectory: string,
  platformAuth: PlatformAuthConfig,
  proxy: string
): Promise<YtdlpCookiePlatformStatus[]> {
  const statuses: YtdlpCookiePlatformStatus[] = []
  for (const rule of PLATFORM_COOKIE_RULES) {
    const auth = platformAuth[rule.id]
    if (auth.mode === 'paste') {
      try {
        if (!auth.cookies.trim()) {
          statuses.push({
            id: rule.id,
            label: rule.label,
            mode: auth.mode,
            loggedIn: false,
            liveVerified: false,
            saved: false,
            cookieCount: 0,
            detail: '已选粘贴 Cookie，但尚未粘贴内容'
          })
          continue
        }
        if (rule.id === 'instagram') {
          const homepage = await instagramPastedCookiesReady(auth.cookies, proxy)
          statuses.push({
            id: rule.id,
            label: rule.label,
            mode: auth.mode,
            loggedIn: homepage.ok,
            liveVerified: homepage.ok,
            saved: true,
            cookieCount: auth.cookies.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).length,
            detail: homepage.detail
          })
          continue
        }
        const ready = pastedPlatformCookiesReady(rule.id, auth.cookies)
        statuses.push({
          id: rule.id,
          label: rule.label,
          mode: auth.mode,
          loggedIn: ready.ok,
          liveVerified: false,
          saved: true,
          cookieCount: auth.cookies.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).length,
          detail: ready.detail
        })
      } catch (error) {
        statuses.push({
          id: rule.id,
          label: rule.label,
          mode: auth.mode,
          loggedIn: false,
          liveVerified: false,
          saved: Boolean(auth.cookies.trim()),
          cookieCount: 0,
          detail: error instanceof Error ? error.message : String(error)
        })
      }
      continue
    }

    const liveCookies = cookiesForPlatform(await readLoginCookies(rule.id), rule.id)
    const exportedFile = platformBuiltinCookiePath(cookieDirectory, rule.id)
    const saved = existsSync(exportedFile)
    const exportedText = saved ? readFileSync(exportedFile, 'utf8') : ''
    const exportedNames = pastedPlatformCookiesReady(rule.id, exportedText)
    const loggedIn = saved && exportedNames.ok
    statuses.push({
      id: rule.id,
      label: rule.label,
      mode: auth.mode,
      loggedIn,
      liveVerified: false,
      saved,
      savedAt: saved ? statSync(exportedFile).mtime.toISOString() : undefined,
      cookieCount: liveCookies.length,
      detail: loggedIn
        ? `应用内 Cookie 已单独保存且格式完整（${liveCookies.length} 个当前会话 Cookie）；实际任务链接尚未验证`
        : liveCookies.length > 0
          ? '已检测到应用内会话，请点击“保存应用内登录”'
          : saved
            ? exportedNames.detail
            : '尚未保存该平台的应用内登录'
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
  const now = Date.now() / 1000
  for (const cookie of cookies) {
    if (!cookie.name || !cookie.value || /[\t\r\n]/.test(cookie.value)) continue
    if (cookie.expirationDate && cookie.expirationDate <= now) continue
    const domain = cookie.domain ?? ''
    if (!domain) continue
    const flag = cookie.hostOnly ? 'FALSE' : 'TRUE'
    const path = cookie.path ?? '/'
    const secure = cookie.secure ? 'TRUE' : 'FALSE'
    const expiry = cookie.expirationDate ? Math.floor(cookie.expirationDate) : 0
    lines.push(`${domain}\t${flag}\t${path}\t${secure}\t${expiry}\t${cookie.name}\t${cookie.value}`)
  }
  return `${lines.join('\n')}\n`
}

export async function buildLoginCookieStatus(
  cookieDirectory: string,
  platformAuth: PlatformAuthConfig = {
    youtube: { mode: 'builtin', cookies: '' },
    tiktok: { mode: 'builtin', cookies: '' },
    instagram: { mode: 'paste', cookies: '' },
    facebook: { mode: 'builtin', cookies: '' }
  },
  proxy = ''
): Promise<YtdlpCookieStatus> {
  const platforms = await platformStatuses(cookieDirectory, platformAuth, proxy)
  const exportedPlatforms = platforms.filter((item) => item.saved)
  const exportedAt = exportedPlatforms.map((item) => item.savedAt).filter(Boolean).sort().at(-1)
  return {
    exported: exportedPlatforms.length > 0,
    exportedAt,
    cookieCount: platforms.reduce((total, item) => total + item.cookieCount, 0),
    platforms
  }
}

export async function exportLoginCookies(
  cookieDirectory: string,
  platformId: YtdlpCookiePlatformId,
  platformAuth: PlatformAuthConfig,
  proxy = ''
): Promise<YtdlpCookieStatus> {
  const rule = platformRule(platformId)
  const cookies = cookiesForPlatform(await readLoginCookies(platformId), platformId)
  const names = cookieNamesForPlatform(cookies, rule)
  const missing = rule.requiredNames.filter((name) => !names.has(name))
  if (missing.length > 0) {
    throw new Error(`${rule.label} 应用内登录不完整：缺少 ${missing.join(' / ')}。请先在登录窗口完成登录。`)
  }
  writeFileSync(platformBuiltinCookiePath(cookieDirectory, platformId), cookiesToNetscape(cookies), 'utf8')
  return buildLoginCookieStatus(cookieDirectory, platformAuth, proxy)
}
