import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { YtdlpUpdateStatus } from '@koubox/shared'
import { createLogger } from '@koubox/shared/logger'

const log = createLogger('ytdlp')

export const BUNDLED_YTDLP_VERSION = '2026.08.25.233329'
export const BUNDLED_YTDLP_SHA256 = '05d3bd5d2ae149256ebf9f2840b5a8daf6e6f1a2f9a346eb60e1fd906ba06ba8'
export const BUNDLED_DENO_VERSION = '2.9.5'
export const BUNDLED_DENO_SHA256 = '98f8c2a2d470e4ccb04c935c86ff8050817d877762aec5eaeeb9e409ccb3b9fd'
const RELEASE_REPOSITORY = 'yt-dlp/yt-dlp-nightly-builds'
const EJS_PROBE_URL = 'https://www.youtube.com/watch?v=BaW_jenozKc'

type Release = {
  tag_name: string
  assets: Array<{ name: string; browser_download_url: string; digest?: string }>
}

type ActiveMetadata = { version: string; sha256: string; filename: string; installedAt: string }
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

function commandOutput(executable: string, args: string[]): { status: number | null; output: string } {
  const startedAt = Date.now()
  log.debug('外部命令开始', { executable, args })
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 50_000 })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  log.debug('外部命令完成', {
    executable,
    args,
    durationMs: Date.now() - startedAt,
    exitCode: result.status,
    signal: result.signal,
    outputBytes: output.length,
    timedOut: result.error?.message?.includes('ETIMEDOUT') ?? false
  })
  return { status: result.status, output }
}

function defaultVersionOf(executable: string): string | undefined {
  if (!existsSync(executable)) return undefined
  const result = commandOutput(executable, ['--version'])
  return result.status === 0 ? result.output.split(/\r?\n/)[0]?.trim() : undefined
}

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export type YtdlpRuntimeInspection = {
  version?: string
  ejsVersion?: string
  denoVersion?: string
  jsRuntimeVersion?: string
  providerReady: boolean
  output: string
}

export type ActiveYtdlpRuntime = {
  executable: string
  source: 'bundled' | 'user-update'
  channel: 'nightly'
  runtimeInspection?: YtdlpRuntimeInspection
}

function inspectYtdlpRuntimeWithKnownVersion(
  executable: string,
  denoExecutable: string,
  probeProvider = false,
  knownVersion?: string
): YtdlpRuntimeInspection {
  const startedAt = Date.now()
  log.debug('yt-dlp 运行时检查开始', { executable, denoExecutable, probeProvider })
  const version = knownVersion ?? defaultVersionOf(executable)
  const deno = existsSync(denoExecutable) ? commandOutput(denoExecutable, ['--version']) : { status: null, output: '' }
  const denoVersion = deno.status === 0 ? deno.output.split(/\r?\n/)[0]?.trim() || undefined : undefined
  const jsRuntimeVersion = denoVersion?.match(/^deno\s+([^\s]+)/)?.[1]
  if (!version) {
    log.debug('yt-dlp 运行时检查结束：版本不可用', { durationMs: Date.now() - startedAt, executable, denoExecutable })
    return { version, denoVersion, jsRuntimeVersion, providerReady: false, output: '' }
  }
  const diagnostics = commandOutput(executable, [
    '--ignore-config', '--verbose', '--js-runtimes', `deno:${denoExecutable}`,
    ...(probeProvider ? ['--simulate', '--skip-download', EJS_PROBE_URL] : ['--list-extractors'])
  ])
  const ejsVersion = diagnostics.output.match(/\byt_dlp_ejs-([^,\s]+)/i)?.[1]
  const runtimeDetected = diagnostics.output.match(/\bJS runtimes:\s*[^\r\n]*\bdeno-([^,\s]+)/i)?.[1]
  const providerReady = probeProvider
    ? /JS Challenge Providers:[^\r\n]*\bdeno\b/i.test(diagnostics.output)
    : Boolean(runtimeDetected)
  const result = {
    version,
    ejsVersion,
    denoVersion,
    jsRuntimeVersion: runtimeDetected ?? jsRuntimeVersion,
    providerReady,
    output: diagnostics.output
  }
  log.debug('yt-dlp 运行时检查结束', {
    durationMs: Date.now() - startedAt,
    executable,
    denoExecutable,
    version: result.version,
    ejsVersion: result.ejsVersion,
    denoVersion: result.denoVersion,
    jsRuntimeVersion: result.jsRuntimeVersion,
    providerReady: result.providerReady,
    diagnosticsBytes: result.output.length
  })
  return result
}

export function inspectYtdlpRuntime(
  executable: string,
  denoExecutable: string,
  probeProvider = false
): YtdlpRuntimeInspection {
  return inspectYtdlpRuntimeWithKnownVersion(executable, denoExecutable, probeProvider)
}

function releaseAsset(release: Release): { version: string; url: string; sha256: string } {
  const asset = release.assets.find((item) => item.name === 'yt-dlp.exe')
  const expectedHash = asset?.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase()
  if (!asset || !expectedHash) throw new Error('GitHub nightly release 缺少 yt-dlp.exe 或 SHA-256。')
  const assetUrl = new URL(asset.browser_download_url)
  if (assetUrl.protocol !== 'https:' || assetUrl.hostname !== 'github.com' || !assetUrl.pathname.startsWith(`/${RELEASE_REPOSITORY}/releases/download/`)) {
    throw new Error('GitHub nightly release 返回了非官方 yt-dlp.exe 地址。')
  }
  return { version: release.tag_name, url: asset.browser_download_url, sha256: expectedHash }
}

export function createYtdlpUpdateManager(options: {
  bundledExecutable: string
  updateDirectory: string
  denoExecutable: string
  bundledSha256?: string
  denoSha256?: string
  fetcher?: Fetcher
  versionOf?: (executable: string) => string | undefined
  validateExecutable?: (
    executable: string,
    expectedVersion: string,
    probeProvider: boolean,
    knownVersion?: string
  ) => YtdlpRuntimeInspection | void
}) {
  const fetcher = options.fetcher ?? fetch
  const versionOf = options.versionOf ?? defaultVersionOf
  const bundledSha256 = options.bundledSha256 ?? BUNDLED_YTDLP_SHA256
  const denoSha256 = options.denoSha256 ?? BUNDLED_DENO_SHA256
  const metadataFile = join(options.updateDirectory, 'active.json')
  const validationCache = new Map<string, YtdlpRuntimeInspection | undefined>()

  const validateExecutable = options.validateExecutable ?? ((executable: string, expectedVersion: string, probeProvider: boolean, knownVersion?: string): YtdlpRuntimeInspection => {
    if (!existsSync(options.denoExecutable)) throw new Error(`Deno 运行时不存在：${options.denoExecutable}`)
    const actualDenoHash = fileDigest(options.denoExecutable)
    if (actualDenoHash !== denoSha256) throw new Error(`Deno SHA-256 校验失败：${actualDenoHash}`)
    const inspected = inspectYtdlpRuntimeWithKnownVersion(executable, options.denoExecutable, probeProvider, knownVersion)
    if (inspected.version !== expectedVersion) {
      throw new Error(`yt-dlp 版本校验失败：期望 ${expectedVersion}，实际 ${inspected.version ?? '无法运行'}`)
    }
    if (inspected.jsRuntimeVersion !== BUNDLED_DENO_VERSION) {
      throw new Error(`Deno 运行时检测失败：要求 ${BUNDLED_DENO_VERSION}，实际 ${inspected.jsRuntimeVersion ?? '未检测到'}`)
    }
    // EJS 只在 --list-extractors 时不显示，启动验证时不强制要求
    // 只在 probeProvider=true 时才要求 EJS 和 Provider 就绪
    if (probeProvider) {
      if (!inspected.ejsVersion) throw new Error('yt-dlp 可执行文件未检测到内置 yt-dlp-ejs。')
      if (!inspected.providerReady) throw new Error('yt-dlp 未能启用 Deno JS Challenge Provider。')
    }
    return inspected
  })

  const validateCandidate = (executable: string, expectedVersion: string, expectedHash: string, probeProvider = false): YtdlpRuntimeInspection | undefined => {
    if (!existsSync(executable)) throw new Error(`yt-dlp 文件不存在：${executable}`)
    const stat = statSync(executable)
    const denoIdentity = existsSync(options.denoExecutable)
      ? (() => {
          const denoStat = statSync(options.denoExecutable)
          return `${denoStat.size}|${denoStat.mtimeMs}|${denoStat.ctimeMs}`
        })()
      : 'missing'
    const cacheKey = `${executable}|${stat.size}|${stat.mtimeMs}|${stat.ctimeMs}|${expectedVersion}|${expectedHash}|${probeProvider}|${options.denoExecutable}|${denoIdentity}|${denoSha256}`
    if (validationCache.has(cacheKey)) return validationCache.get(cacheKey)
    const actualHash = fileDigest(executable)
    if (actualHash !== expectedHash) throw new Error(`yt-dlp SHA-256 校验失败：${actualHash}`)
    const actualVersion = versionOf(executable)
    if (actualVersion !== expectedVersion) {
      throw new Error(`yt-dlp 版本校验失败：期望 ${expectedVersion}，实际 ${actualVersion ?? '无法运行'}`)
    }
    const runtimeInspection = validateExecutable(executable, expectedVersion, probeProvider, actualVersion) ?? undefined
    validationCache.set(cacheKey, runtimeInspection)
    return runtimeInspection
  }

  const readActiveMetadata = (): ActiveMetadata | undefined => {
    try {
      const parsed = JSON.parse(readFileSync(metadataFile, 'utf8')) as ActiveMetadata
      if (!parsed.version || !parsed.sha256 || !parsed.filename || basename(parsed.filename) !== parsed.filename) return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  const bundled = (): ActiveYtdlpRuntime => {
    const runtimeInspection = validateCandidate(options.bundledExecutable, BUNDLED_YTDLP_VERSION, bundledSha256)
    return { executable: options.bundledExecutable, source: 'bundled', channel: 'nightly', runtimeInspection }
  }

  const resolveActive = (): ActiveYtdlpRuntime => {
    const metadata = readActiveMetadata()
    if (metadata) {
      const executable = join(options.updateDirectory, metadata.filename)
      try {
        const runtimeInspection = validateCandidate(executable, metadata.version, metadata.sha256)
        return { executable, source: 'user-update', channel: 'nightly', runtimeInspection }
      } catch {
        rmSync(options.updateDirectory, { recursive: true, force: true })
      }
    }
    if (existsSync(metadataFile)) rmSync(options.updateDirectory, { recursive: true, force: true })
    return bundled()
  }

  const currentStatus = (): YtdlpUpdateStatus => {
    const active = resolveActive()
    return {
      channel: 'nightly',
      currentVersion: active.runtimeInspection?.version ?? versionOf(active.executable) ?? BUNDLED_YTDLP_VERSION,
      currentSource: active.source,
      updateAvailable: false
    }
  }

  const request = async (url: string): Promise<Response> => {
    const response = await fetcher(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Koubox-yt-dlp-updater' }
    })
    if (!response.ok) throw new Error(`GitHub 请求失败：HTTP ${response.status}`)
    return response
  }

  const fetchRelease = async (version?: string) => {
    const suffix = version ? `tags/${encodeURIComponent(version)}` : 'latest'
    const response = await request(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/${suffix}`)
    const release = releaseAsset(await response.json() as Release)
    if (version && release.version !== version) throw new Error(`GitHub release 版本不匹配：期望 ${version}，实际 ${release.version}`)
    return release
  }

  return {
    resolveActive,
    status: currentStatus,
    async check(): Promise<YtdlpUpdateStatus> {
      const latest = await fetchRelease()
      const current = currentStatus()
      return {
        ...current,
        latestVersion: latest.version,
        updateAvailable: latest.version !== current.currentVersion,
        checkedAt: new Date().toISOString(),
        downloadUrl: latest.url,
        sha256: latest.sha256
      }
    },
    async install(version: string): Promise<YtdlpUpdateStatus> {
      const release = await fetchRelease(version)
      const data = new Uint8Array(await (await request(release.url)).arrayBuffer())
      const actualHash = digest(data)
      if (actualHash !== release.sha256) throw new Error(`yt-dlp SHA-256 校验失败：${actualHash}`)

      mkdirSync(options.updateDirectory, { recursive: true })
      const safeVersion = release.version.replace(/[^a-zA-Z0-9._-]/g, '_')
      const installId = `${process.pid}-${Date.now()}`
      const filename = `yt-dlp-${safeVersion}-${installId}.exe`
      const finalExecutable = join(options.updateDirectory, filename)
      const temporary = join(options.updateDirectory, `${filename}.tmp`)
      const metadataTemporary = join(options.updateDirectory, `active.${installId}.tmp.json`)
      const metadataPrevious = join(options.updateDirectory, `active.${installId}.previous.json`)
      writeFileSync(temporary, data)
      let metadataMoved = false
      let activated = false
      try {
        validateCandidate(temporary, release.version, release.sha256, true)
        renameSync(temporary, finalExecutable)
        writeFileSync(metadataTemporary, JSON.stringify({
          version: release.version,
          sha256: release.sha256,
          filename,
          installedAt: new Date().toISOString()
        } satisfies ActiveMetadata, null, 2), 'utf8')
        if (existsSync(metadataFile)) {
          renameSync(metadataFile, metadataPrevious)
          metadataMoved = true
        }
        renameSync(metadataTemporary, metadataFile)
        activated = true
        if (existsSync(metadataPrevious)) rmSync(metadataPrevious, { force: true })
      } catch (error) {
        if (existsSync(temporary)) rmSync(temporary, { force: true })
        if (existsSync(metadataTemporary)) rmSync(metadataTemporary, { force: true })
        if (!activated && metadataMoved && !existsSync(metadataFile) && existsSync(metadataPrevious)) {
          renameSync(metadataPrevious, metadataFile)
        }
        if (!activated && existsSync(finalExecutable)) rmSync(finalExecutable, { force: true })
        throw error
      }
      for (const name of readdirSync(options.updateDirectory)) {
        if (name.startsWith('yt-dlp-') && name.endsWith('.exe') && name !== filename) {
          try { rmSync(join(options.updateDirectory, name), { force: true }) } catch { /* stale executable cleanup is best-effort */ }
        }
      }
      return currentStatus()
    },
    async restore(): Promise<YtdlpUpdateStatus> {
      if (existsSync(options.updateDirectory)) rmSync(options.updateDirectory, { recursive: true, force: true })
      return currentStatus()
    }
  }
}
