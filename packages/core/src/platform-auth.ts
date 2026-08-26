import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertPastedPlatformCookies,
  PLATFORM_COOKIE_RULES,
  type DownloadableVideoPlatform,
  type YtdlpCookiePlatformId
} from '@koubox/shared'
import type { AuthenticatedCookieFile } from './video-download.js'

const platformNames: Record<YtdlpCookiePlatformId, DownloadableVideoPlatform> = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  facebook: 'Facebook'
}

function filterNetscapeCookies(platformId: YtdlpCookiePlatformId, text: string): string {
  const rule = PLATFORM_COOKIE_RULES.find((item) => item.id === platformId)
  if (!rule) throw new Error(`未知平台：${platformId}`)
  const lines = text.split(/\r?\n/).filter((raw) => {
    let line = raw.trim()
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) return false
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
    const parts = line.split('\t')
    const domain = (parts[0] ?? '').replace(/^\./, '')
    return parts.length >= 7 && rule.domainTest.test(domain)
  })
  return ['# Netscape HTTP Cookie File', '# Temporary Koubox platform cookie copy', ...lines].join('\n') + '\n'
}

/**
 * Creates the only cookie file yt-dlp is allowed to receive. The caller-owned
 * source text is never passed to yt-dlp, so yt-dlp may rewrite this temporary
 * copy without changing persisted platform authentication.
 */
export function createTemporaryPlatformCookieFile(options: {
  platformId: YtdlpCookiePlatformId
  source: AuthenticatedCookieFile['source']
  cookieText: string
  userAgent?: string
  validatePastedCookies?: boolean
}): AuthenticatedCookieFile {
  if (options.validatePastedCookies) {
    assertPastedPlatformCookies(options.platformId, options.cookieText)
  }
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'koubox-platform-auth-'))
  const path = join(temporaryDirectory, `${options.platformId}.cookies.txt`)
  try {
    writeFileSync(path, filterNetscapeCookies(options.platformId, options.cookieText), 'utf8')
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true })
    throw error
  }
  return {
    path,
    platform: platformNames[options.platformId],
    source: options.source,
    userAgent: options.userAgent,
    cleanup: () => rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}
