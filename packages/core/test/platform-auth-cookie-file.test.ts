import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createTemporaryPlatformCookieFile } from '../src/platform-auth.js'

const roots: string[] = []
const row = (domain: string, name: string, value: string) =>
  `${domain}\tTRUE\t/\tTRUE\t0\t${name}\t${value}`

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('temporary platform cookie copies', () => {
  it('isolates yt-dlp mutations from persisted cookie text and filters other platforms', async () => {
    const persisted = [
      row('.youtube.com', 'SID', 'sid-value'),
      row('.youtube.com', 'HSID', 'hsid-value'),
      row('.youtube.com', 'SSID', 'ssid-value'),
      row('.youtube.com', 'APISID', 'apisid-value'),
      row('.youtube.com', 'SAPISID', 'sapisid-value'),
      row('.facebook.com', 'c_user', 'foreign-value')
    ].join('\n')
    const authentication = createTemporaryPlatformCookieFile({
      platformId: 'youtube',
      source: 'paste',
      cookieText: persisted,
      validatePastedCookies: true
    })
    expect(readFileSync(authentication.path, 'utf8')).not.toContain('facebook.com')

    writeFileSync(authentication.path, 'yt-dlp rewrote this file', 'utf8')
    expect(persisted).toContain('sid-value')
    expect(persisted).toContain('foreign-value')

    await authentication.cleanup()
    expect(existsSync(authentication.path)).toBe(false)
  })
})
