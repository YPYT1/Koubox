import { describe, expect, it } from 'vitest'
import { assertPastedPlatformCookies, defaultPlatformAuth, pastedPlatformCookiesReady } from '@koubox/shared'

const row = (domain: string, expiry: number, name: string, value = 'value') =>
  `${domain}\tTRUE\t/\tTRUE\t${expiry}\t${name}\t${value}`

describe('platform authentication config', () => {
  it('defaults all four platforms to pasted cookies', () => {
    expect(defaultPlatformAuth()).toEqual({
      youtube: { mode: 'paste', cookies: '' },
      tiktok: { mode: 'paste', cookies: '' },
      instagram: { mode: 'paste', cookies: '' },
      facebook: { mode: 'paste', cookies: '' }
    })
  })

  it('rejects cookies exported for another platform', () => {
    const facebook = [row('.facebook.com', 0, 'c_user'), row('.facebook.com', 0, 'xs')].join('\n')
    expect(() => assertPastedPlatformCookies('youtube', facebook)).toThrow('Cookie 平台错误')
  })

  it('distinguishes malformed Netscape content from missing fields', () => {
    expect(() => assertPastedPlatformCookies('youtube', 'SID=value; HSID=value')).toThrow('Cookie 格式错误')
    expect(() => assertPastedPlatformCookies('youtube', row('.youtube.com', 0, 'SID'))).toThrow('Cookie 不完整')
  })

  it('rejects an expired required cookie', () => {
    const expired = Math.floor(Date.now() / 1000) - 60
    const youtube = [
      row('.youtube.com', expired, 'SID'),
      row('.youtube.com', 0, 'HSID'),
      row('.youtube.com', 0, 'SSID'),
      row('.youtube.com', 0, 'APISID'),
      row('.youtube.com', 0, 'SAPISID')
    ].join('\n')
    expect(pastedPlatformCookiesReady('youtube', youtube)).toMatchObject({ ok: false })
  })
})
