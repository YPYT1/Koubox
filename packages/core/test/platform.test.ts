import { describe, expect, it } from 'vitest'
import {
  assertPastedPlatformCookies,
  detectPlatform,
  filterNetscapeCookiesForPlatform,
  pastedPlatformCookiesReady,
  platformBuiltinCookiesFilename,
  toUserTaskMessage
} from '@koubox/shared'
import { canonicalPlatformDownloadUrl, platformYtdlpCompatibilityAttempts, selectedPlatformCookieFilename } from '../src/tasks.js'

describe('shared platform detection', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abc', 'YouTube'],
    ['https://www.tiktok.com/@creator/video/1', 'TikTok'],
    ['https://www.instagram.com/reel/abc', 'Instagram'],
    ['https://www.facebook.com/watch/?v=abc', 'Facebook'],
  ])('detects %s as %s', (url, expected) => {
    expect(detectPlatform(url)).toBe(expected)
  })
})

describe('platform cookie isolation', () => {
  const mixedCookies = [
    '# Netscape HTTP Cookie File',
    '.youtube.com\tTRUE\t/\tTRUE\t4102444800\tSID\tyt-sid',
    '.google.com\tTRUE\t/\tTRUE\t4102444800\tHSID\tyt-hsid',
    '.google.com\tTRUE\t/\tTRUE\t4102444800\tSSID\tyt-ssid',
    '.google.com\tTRUE\t/\tTRUE\t4102444800\tAPISID\tyt-apisid',
    '.google.com\tTRUE\t/\tTRUE\t4102444800\tSAPISID\tyt-sapisid',
    '.instagram.com\tTRUE\t/\tTRUE\t4102444800\tsessionid\tig-session',
    '.instagram.com\tTRUE\t/\tTRUE\t4102444800\tds_user_id\t12345',
    '.tiktok.com\tTRUE\t/\tTRUE\t4102444800\tsessionid\ttt-session',
    '.tiktok.com\tTRUE\t/\tTRUE\t4102444800\tsid_tt\ttt-sid',
    '.facebook.com\tTRUE\t/\tTRUE\t4102444800\tc_user\t67890',
    '.facebook.com\tTRUE\t/\tTRUE\t4102444800\txs\tfb-xs'
  ].join('\n')

  it('uses a distinct builtin file for every platform', () => {
    expect(platformBuiltinCookiesFilename('youtube')).toBe('youtube-builtin-cookies.txt')
    expect(platformBuiltinCookiesFilename('tiktok')).toBe('tiktok-builtin-cookies.txt')
    expect(platformBuiltinCookiesFilename('instagram')).toBe('instagram-builtin-cookies.txt')
    expect(platformBuiltinCookiesFilename('facebook')).toBe('facebook-builtin-cookies.txt')
  })

  it('filters a mixed legacy export without leaking another platform cookies', () => {
    const youtube = filterNetscapeCookiesForPlatform(mixedCookies, 'youtube')
    expect(youtube).toContain('\tSID\tyt-sid')
    expect(youtube).not.toContain('ig-session')

    const instagram = filterNetscapeCookiesForPlatform(mixedCookies, 'instagram')
    expect(instagram).toContain('\tsessionid\tig-session')
    expect(instagram).not.toContain('yt-sid')

    const tiktok = filterNetscapeCookiesForPlatform(mixedCookies, 'tiktok')
    expect(tiktok).toContain('\tsid_tt\ttt-sid')
    expect(tiktok).not.toContain('fb-xs')

    const facebook = filterNetscapeCookiesForPlatform(mixedCookies, 'facebook')
    expect(facebook).toContain('\txs\tfb-xs')
    expect(facebook).not.toContain('tt-session')
  })

  it.each(['youtube', 'tiktok', 'instagram', 'facebook'] as const)('accepts a complete isolated %s cookie file', (platformId) => {
    const isolated = filterNetscapeCookiesForPlatform(mixedCookies, platformId)
    expect(() => assertPastedPlatformCookies(platformId, isolated)).not.toThrow()
  })

  it('does not describe field-only TikTok cookie validation as an effective login', () => {
    const isolated = filterNetscapeCookiesForPlatform(mixedCookies, 'tiktok')
    const status = pastedPlatformCookiesReady('tiktok', isolated)
    expect(status.ok).toBe(true)
    expect(status.detail).toContain('格式完整')
    expect(status.detail).toContain('尚未验证')
    expect(status.detail).not.toContain('有效')
  })

  it('rejects required cookie fields with an empty value', () => {
    const emptySid = mixedCookies.replace('\tSID\tyt-sid', '\tSID\t')
    expect(() => assertPastedPlatformCookies('youtube', emptySid)).toThrow(/SID/)
  })

  it('rejects expired required cookie fields', () => {
    const expired = mixedCookies.replaceAll('4102444800', '1')
    expect(() => assertPastedPlatformCookies('youtube', expired)).toThrow(/SID/)
  })

  it('uses the configured authentication mode in YouTube error guidance', () => {
    const raw = '[youtube] abc: tv_downgraded player response playability status: UNPLAYABLE. The page needs to be reloaded'
    expect(toUserTaskMessage(raw, { platformId: 'youtube', mode: 'builtin' })).toContain('应用内登录')
    expect(toUserTaskMessage(raw, { platformId: 'youtube', mode: 'builtin' })).not.toContain('插件重新导出')
    expect(toUserTaskMessage(raw, { platformId: 'youtube', mode: 'paste' })).toContain('重新导出')
  })

  it('does not tell an Instagram builtin user to paste cookies', () => {
    const raw = '[Instagram] login required: cookie rejected'
    const message = toUserTaskMessage(raw, { platformId: 'instagram', mode: 'builtin' })
    expect(message).toContain('应用内登录')
    expect(message).not.toContain('重新导出')
  })
})

describe('platform yt-dlp compatibility', () => {
  it.each(['youtube', 'tiktok', 'instagram', 'facebook'] as const)('keeps both %s authentication sources isolated', (platformId) => {
    expect(selectedPlatformCookieFilename(platformId, 'paste')).toBe(`${platformId}-cookies.txt`)
    expect(selectedPlatformCookieFilename(platformId, 'builtin')).toBe(`${platformId}-builtin-cookies.txt`)
  })

  it('uses the verified desktop browser fingerprint for TikTok only', () => {
    expect(platformYtdlpCompatibilityAttempts('tiktok')).toEqual([
      ['--impersonate', 'Chrome-145:Macos-26'],
      ['--impersonate', 'Chrome-131:Macos-14'],
      ['--impersonate', 'Edge-101:Windows-10']
    ])
    expect(platformYtdlpCompatibilityAttempts('youtube')).toEqual([[]])
    expect(platformYtdlpCompatibilityAttempts('instagram')).toEqual([[]])
    expect(platformYtdlpCompatibilityAttempts('facebook')).toEqual([[]])
  })

  it('removes TikTok tracking parameters without changing other platform URLs', () => {
    const tiktok = 'https://www.tiktok.com/@name/video/123?q=%23tag&t=456'
    expect(canonicalPlatformDownloadUrl(tiktok, 'tiktok')).toBe('https://www.tiktok.com/@name/video/123')
    const youtube = 'https://www.youtube.com/watch?v=abc&t=10'
    expect(canonicalPlatformDownloadUrl(youtube, 'youtube')).toBe(youtube)
  })

  it('explains the TikTok webpage/challenge failure instead of blaming generic settings', () => {
    const raw = '[TikTok] Unable to extract universal data for rehydration'
    const message = toUserTaskMessage(raw, { platformId: 'tiktok', mode: 'paste' })
    expect(message).toContain('TikTok')
    expect(message).toContain('浏览器模拟')
    expect(message).not.toContain('请检查视频链接、网络')
  })
})
