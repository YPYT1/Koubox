import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { BUNDLED_YTDLP_VERSION, createYtdlpUpdateManager } from '../src/ytdlp-update.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function hash(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function fixture(options?: { badDigest?: boolean; rejectVersion?: string }) {
  const root = mkdtempSync(join(tmpdir(), 'koubox-ytdlp-update-'))
  roots.push(root)
  const bundled = join(root, 'bundled.exe')
  const deno = join(root, 'deno.exe')
  const updateDirectory = join(root, 'updates')
  writeFileSync(bundled, 'bundled')
  writeFileSync(deno, 'deno')
  let latest = '2026.08.26.120000'
  const binaries = new Map<string, Uint8Array>()
  binaries.set(latest, new TextEncoder().encode(`binary-${latest}`))

  const fetcher = async (url: string): Promise<Response> => {
    const tag = url.match(/releases\/tags\/([^/]+)$/)?.[1]
    const version = tag ? decodeURIComponent(tag) : latest
    if (url.startsWith('https://api.github.com/')) {
      const data = binaries.get(version) ?? new TextEncoder().encode(`binary-${version}`)
      binaries.set(version, data)
      const digest = options?.badDigest ? '0'.repeat(64) : hash(data)
      return Response.json({
        tag_name: version,
        assets: [{
          name: 'yt-dlp.exe',
          browser_download_url: `https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/${version}/yt-dlp.exe`,
          digest: `sha256:${digest}`
        }]
      })
    }
    const downloadVersion = url.match(/releases\/download\/([^/]+)/)?.[1] ?? latest
    return new Response(new TextDecoder().decode(binaries.get(downloadVersion) ?? new Uint8Array()), { status: 200 })
  }

  const manager = createYtdlpUpdateManager({
    bundledExecutable: bundled,
    denoExecutable: deno,
    updateDirectory,
    bundledSha256: hash(new TextEncoder().encode('bundled')),
    denoSha256: hash(new TextEncoder().encode('deno')),
    fetcher,
    versionOf: (path) => {
      if (path === bundled) return BUNDLED_YTDLP_VERSION
      if (!existsSync(path)) return undefined
      const contents = readFileSync(path, 'utf8')
      return contents.match(/^binary-(.+)$/)?.[1]
    },
    validateExecutable: (_path, version) => {
      if (version === options?.rejectVersion) throw new Error('validation rejected')
    }
  })

  return {
    manager,
    setLatest(version: string) {
      latest = version
      binaries.set(version, new TextEncoder().encode(`binary-${version}`))
    }
  }
}

describe('yt-dlp nightly update manager', () => {
  it('checks the nightly channel only when requested', async () => {
    const { manager } = fixture()
    expect(manager.status()).toMatchObject({ currentVersion: BUNDLED_YTDLP_VERSION, updateAvailable: false })
    await expect(manager.check()).resolves.toMatchObject({
      latestVersion: '2026.08.26.120000',
      updateAvailable: true,
      channel: 'nightly'
    })
  })

  it('rejects a binary whose SHA-256 does not match the official release digest', async () => {
    const { manager } = fixture({ badDigest: true })
    await expect(manager.install('2026.08.26.120000')).rejects.toThrow('SHA-256 校验失败')
    expect(manager.resolveActive().source).toBe('bundled')
  })

  it('installs an update, preserves it when the next validation fails, and restores bundled', async () => {
    const rejected = '2026.08.27.120000'
    const { manager, setLatest } = fixture({ rejectVersion: rejected })
    await expect(manager.install('2026.08.26.120000')).resolves.toMatchObject({
      currentVersion: '2026.08.26.120000',
      currentSource: 'user-update'
    })

    setLatest(rejected)
    await expect(manager.install(rejected)).rejects.toThrow('validation rejected')
    expect(manager.status()).toMatchObject({
      currentVersion: '2026.08.26.120000',
      currentSource: 'user-update'
    })

    await expect(manager.restore()).resolves.toMatchObject({
      currentVersion: BUNDLED_YTDLP_VERSION,
      currentSource: 'bundled'
    })
  })

  it('deletes a corrupted user update and immediately falls back to bundled', async () => {
    const { manager } = fixture()
    await manager.install('2026.08.26.120000')
    const active = manager.resolveActive()
    expect(active.source).toBe('user-update')
    writeFileSync(active.executable, 'corrupted')

    expect(manager.resolveActive()).toMatchObject({ source: 'bundled' })
    expect(existsSync(active.executable)).toBe(false)
  })
})
