import { session, type Cookie } from 'electron'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import type { YtdlpCookiePlatformId, YtdlpCookiePlatformStatus, YtdlpCookieStatus } from '@koubox/shared'

export const LOGIN_PARTITION = 'persist:koubox-ytdlp-login'

const PLATFORM_RULES: Array<{
  id: YtdlpCookiePlatformId
  label: string
  domains: RegExp
  names: string[]
}> = [
  {
    id: 'youtube',
    label: 'YouTube',
    domains: /(?:^|\.)(youtube\.com|google\.com)$/i,
    names: ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO']
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    domains: /(?:^|\.)tiktok\.com$/i,
    names: ['sessionid', 'sid_tt', 'sid_guard', 'ttwid']
  },
  {
    id: 'instagram',
    label: 'Instagram',
    domains: /(?:^|\.)instagram\.com$/i,
    names: ['sessionid', 'ds_user_id']
  },
  {
    id: 'facebook',
    label: 'Facebook',
    domains: /(?:^|\.)(facebook\.com|fb\.com)$/i,
    names: ['c_user', 'xs']
  }
]

export function loginSession() {
  return session.fromPartition(LOGIN_PARTITION)
}

export function normalizeProxyRules(proxy: string): string | null {
  const trimmed = proxy.trim()
  if (!trimmed) return null
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

export async function applyLoginSessionProxy(proxy: string): Promise<void> {
  const loginSess = loginSession()
  const proxyRules = normalizeProxyRules(proxy)
  if (!proxyRules) {
    await loginSess.setProxy({ mode: 'direct' })
    return
  }
  await loginSess.setProxy({ proxyRules, proxyBypassRules: '<local>' })
}

export async function readLoginCookies(): Promise<Cookie[]> {
  return loginSession().cookies.get({})
}

function cookieDomain(cookie: Cookie): string {
  return (cookie.domain ?? '').replace(/^\./, '').toLowerCase()
}

function cookieNamesForPlatform(cookies: Cookie[], rule: (typeof PLATFORM_RULES)[number]): Set<string> {
  const names = new Set<string>()
  for (const cookie of cookies) {
    if (!cookie.name || !cookie.value) continue
    if (!rule.domains.test(cookieDomain(cookie))) continue
    if (!rule.names.includes(cookie.name)) continue
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
  return html.match(/"viewerId"\s*:\s*"(\d+)"/)?.[1] ?? html.match(/"viewerId"\s*:\s*(\d+)/)?.[1]
}

async function instagramHomepageReady(): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await loginSession().fetch('https://www.instagram.com/', {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
      }
    })
    const html = await response.text()
    if (instagramCheckpoint(response.url, html)) {
      return { ok: false, detail: 'Instagram 仍在验证或封禁页，未进入个人主页' }
    }
    const viewerId = instagramViewerId(html)
    if (!viewerId) {
      return { ok: false, detail: '未进入 Instagram 个人主页' }
    }
    return { ok: true, detail: `已进入 Instagram 个人主页（用户 ${viewerId}）` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`无法打开 Instagram 主页确认登录：${message}`)
  } finally {
    clearTimeout(timer)
  }
}

async function platformStatuses(cookies: Cookie[]): Promise<YtdlpCookiePlatformStatus[]> {
  const statuses: YtdlpCookiePlatformStatus[] = []
  for (const rule of PLATFORM_RULES) {
    const matched = cookieNamesForPlatform(cookies, rule)
    if (rule.id === 'instagram') {
      if (!matched.has('sessionid') || !matched.has('ds_user_id')) {
        statuses.push({
          id: rule.id,
          label: rule.label,
          loggedIn: false,
          detail: '未进入 Instagram 个人主页（缺少 sessionid / ds_user_id）'
        })
        continue
      }
      const homepage = await instagramHomepageReady()
      statuses.push({
        id: rule.id,
        label: rule.label,
        loggedIn: homepage.ok,
        detail: homepage.detail
      })
      continue
    }
    const loggedIn = matched.size > 0
    statuses.push({
      id: rule.id,
      label: rule.label,
      loggedIn,
      detail: loggedIn ? `已检测到 ${matched.size} 个登录 cookie` : '未检测到登录 cookie'
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

export async function buildLoginCookieStatus(exportedFile?: string): Promise<YtdlpCookieStatus> {
  const cookies = await readLoginCookies()
  const platforms = await platformStatuses(cookies)
  let exported = false
  let exportedAt: string | undefined
  if (exportedFile && existsSync(exportedFile)) {
    exported = true
    exportedAt = statSync(exportedFile).mtime.toISOString()
  }
  return {
    exported,
    exportedAt,
    cookieCount: cookies.length,
    platforms
  }
}

export async function exportLoginCookies(exportedFile: string): Promise<YtdlpCookieStatus> {
  const cookies = await readLoginCookies()
  if (cookies.length === 0) throw new Error('登录窗口中没有任何 cookie。请先打开登录窗口并完成登录。')
  writeFileSync(exportedFile, cookiesToNetscape(cookies), 'utf8')
  return buildLoginCookieStatus(exportedFile)
}
