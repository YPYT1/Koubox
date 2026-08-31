import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { freemem, totalmem } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { GpuStatus, KouboxConfig, ModelCheck, PlatformAuthConfig, PlatformAuthMode, RuntimeStatus, SystemMemoryStatus, VendorToolCheck, YtdlpCookiePlatformId } from '@koubox/shared'
import { defaultPlatformAuth, normalizeKouboxConfigPaths } from '@koubox/shared'
import { createLogger } from '@koubox/shared/logger'
import { inspectYtdlpRuntime, type ActiveYtdlpRuntime } from './ytdlp-update.js'

const log = createLogger('runtime')
const executableVersionCache = new Map<string, string>()

/** 实时图表轮询用：短缓存内复用上次 nvidia-smi 结果，避免每秒起子进程 */
export const GPU_RUNTIME_PROBE_MAX_AGE_MS = 2500

let gpuProbeCache: { at: number; value: GpuStatus } | undefined

const asrModelFiles = [
  'config.json', 'model.bin', 'preprocessor_config.json', 'tokenizer.json', 'vocabulary.json'
]

const legacyAsrModelDirectory = 'whisperlargev3turbo'
const fasterWhisperAsrModelDirectory = 'faster-whisper-large-v3'

const translationModelFiles = [
  'chat_template.jinja', 'config.json', 'configuration.json', 'generation_config.json',
  'model.safetensors', 'special_tokens_map.json', 'tokenizer_config.json', 'tokenizer.json',
  'README_CN.md', 'LICENSE.txt'
]

const ytdlpExpectedFiles = ['yt-dlp.exe']
const denoExpectedFiles = ['deno.exe']

// 与 scripts/pack/manifests/pack-manifest.json 的 ffmpegExpectedFiles 保持一致。
const ffmpegExpectedFiles = [
  'ffmpeg.exe',
  'ffprobe.exe',
  'ffplay.exe',
  'avcodec-62.dll',
  'avdevice-62.dll',
  'avfilter-11.dll',
  'avformat-62.dll',
  'avutil-60.dll',
  'swresample-6.dll',
  'swscale-9.dll'
]

function isLegacyDevelopmentVendorPath(directory: string, suffix: 'yt-dlp' | 'ffmpeg/bin'): boolean {
  const normalized = directory.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalized.endsWith(`/koubox/vendor/${suffix}`) || normalized.endsWith(`/koubox-exp-platform-fetch/vendor/${suffix}`)
}

function migrateLegacyDevelopmentModelPath(directory: string, modelsDirectory: string): string {
  const match = directory.match(/^d:[\\/]project[\\/]koubox[\\/]models(?:[\\/](.*))?$/i)
  if (!match) return directory
  if (!match[1]) return modelsDirectory
  return join(modelsDirectory, ...match[1].split(/[\\/]+/))
}

export class RuntimeStore {
  private cached?: { signature: string; config: KouboxConfig }

  constructor(
    private readonly file: string,
    private readonly defaults: KouboxConfig,
    private readonly pinBundledPaths = false
  ) {}

  private applyPinned(config: KouboxConfig): KouboxConfig {
    // 总是锁定下载工具路径（yt-dlp、deno）
    const bundledDownloadTools = {
      ...config,
      ytdlpDirectory: this.defaults.ytdlpDirectory,
      denoDirectory: this.defaults.denoDirectory
    }
    // 打包后：额外锁定 ffmpeg 和 Python，但允许用户自定义模型路径
    if (!this.pinBundledPaths) return bundledDownloadTools
    return {
      ...bundledDownloadTools,
      ffmpegDirectory: this.defaults.ffmpegDirectory,
      pythonExecutable: this.defaults.pythonExecutable
    }
  }

  private fileSignature(): string | undefined {
    if (!existsSync(this.file)) return undefined
    const stat = statSync(this.file)
    return `${stat.size}|${stat.mtimeMs}|${stat.ctimeMs}`
  }

  private remember(config: KouboxConfig): KouboxConfig {
    const signature = this.fileSignature()
    const snapshot = structuredClone(config)
    if (signature) this.cached = { signature, config: snapshot }
    else this.cached = undefined
    return structuredClone(snapshot)
  }

  read(): KouboxConfig {
    const startedAt = Date.now()
    const fileExists = existsSync(this.file)
    const signature = fileExists ? this.fileSignature() : undefined
    if (signature && this.cached?.signature === signature) {
      log.debug('配置读取命中缓存', { file: this.file, durationMs: Date.now() - startedAt })
      return structuredClone(this.cached.config)
    }
    log.debug('配置读取开始', { file: this.file, fileExists, pinBundledPaths: this.pinBundledPaths })
    if (!fileExists) {
      const created = this.write(this.defaults)
      log.debug('配置读取完成', { file: this.file, durationMs: Date.now() - startedAt, created: true })
      return created
    }
    const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<KouboxConfig>
    const legacy = parsed as Partial<KouboxConfig> & Record<string, unknown>
    const hasLegacyBrowserAuthFields = 'ytdlpCookieSource' in legacy || 'ytdlpCookiesPath' in legacy || 'platformBrowserProfiles' in legacy
    const config = { ...this.defaults, ...parsed }
    const migratedModelsDirectory = migrateLegacyDevelopmentModelPath(config.modelsDirectory, this.defaults.modelsDirectory)
    const migratedAsrModelDirectory = migrateLegacyDevelopmentModelPath(config.asrModelDirectory, this.defaults.modelsDirectory)
    const migratedTranslationModelDirectory = migrateLegacyDevelopmentModelPath(config.translationModelDirectory, this.defaults.modelsDirectory)
    const migratedDemucsModelDirectory = migrateLegacyDevelopmentModelPath(config.demucsModelDirectory, this.defaults.modelsDirectory)
    const migratedLegacyModelPaths =
      migratedModelsDirectory !== config.modelsDirectory ||
      migratedAsrModelDirectory !== config.asrModelDirectory ||
      migratedTranslationModelDirectory !== config.translationModelDirectory ||
      migratedDemucsModelDirectory !== config.demucsModelDirectory
    config.modelsDirectory = migratedModelsDirectory
    config.asrModelDirectory = migratedAsrModelDirectory
    config.translationModelDirectory = migratedTranslationModelDirectory
    config.demucsModelDirectory = migratedDemucsModelDirectory
    if (basename(config.modelsDirectory).toLowerCase() === 'model' && !existsSync(config.modelsDirectory) && existsSync(this.defaults.modelsDirectory)) {
      config.modelsDirectory = this.defaults.modelsDirectory
    }
    const usesLegacyAsrModel = basename(config.asrModelDirectory).toLowerCase() === legacyAsrModelDirectory
    if (!config.asrModelDirectory || usesLegacyAsrModel) {
      config.asrModelDirectory = join(config.modelsDirectory, fasterWhisperAsrModelDirectory)
    }
    if (!config.translationModelDirectory) config.translationModelDirectory = join(config.modelsDirectory, 'HYMT21.8B')
    if (!config.demucsModelDirectory) config.demucsModelDirectory = join(config.modelsDirectory, 'demucs')
    if (!config.ytdlpDirectory) config.ytdlpDirectory = this.defaults.ytdlpDirectory
    if (!config.ffmpegDirectory) config.ffmpegDirectory = this.defaults.ffmpegDirectory
    if (!config.denoDirectory) config.denoDirectory = this.defaults.denoDirectory
    // Development builds used to persist tools from the sibling Koubox checkout.
    // Migrate only that legacy vendor layout; keep any other user-selected path.
    const migrateLegacyYtdlpPath = isLegacyDevelopmentVendorPath(config.ytdlpDirectory, 'yt-dlp')
    const migrateLegacyFfmpegPath = isLegacyDevelopmentVendorPath(config.ffmpegDirectory, 'ffmpeg/bin')
    const migratedLegacyVendorPaths = migrateLegacyYtdlpPath || migrateLegacyFfmpegPath
    if (migrateLegacyYtdlpPath) config.ytdlpDirectory = this.defaults.ytdlpDirectory
    if (migrateLegacyFfmpegPath) config.ffmpegDirectory = this.defaults.ffmpegDirectory
    if (!config.translationTargetLanguage) config.translationTargetLanguage = this.defaults.translationTargetLanguage
    if (!config.asrLanguage) config.asrLanguage = this.defaults.asrLanguage
    if (typeof config.openOutputOnComplete !== 'boolean') config.openOutputOnComplete = this.defaults.openOutputOnComplete
    if (typeof config.ytdlpProxy !== 'string') config.ytdlpProxy = this.defaults.ytdlpProxy
    config.ytdlpPlatformAuth = normalizePlatformAuth(
      (parsed as { ytdlpPlatformAuth?: unknown }).ytdlpPlatformAuth,
      this.defaults.ytdlpPlatformAuth,
      (parsed as { ytdlpInstagramCookies?: unknown }).ytdlpInstagramCookies
    )
    if (config.ytdlpMaxHeight !== 0 && config.ytdlpMaxHeight !== 1080 && config.ytdlpMaxHeight !== 720 && config.ytdlpMaxHeight !== 480) {
      config.ytdlpMaxHeight = this.defaults.ytdlpMaxHeight
    }
    if (typeof config.ytdlpExtraArgs !== 'string') config.ytdlpExtraArgs = this.defaults.ytdlpExtraArgs
    if (!Number.isFinite(config.maxConcurrentTasks) || config.maxConcurrentTasks < 1) {
      config.maxConcurrentTasks = this.defaults.maxConcurrentTasks
    }
    if (!Number.isFinite(config.translationTemperature)) config.translationTemperature = this.defaults.translationTemperature
    if (!Number.isFinite(config.translationMaxNewTokens) || config.translationMaxNewTokens < 1) {
      config.translationMaxNewTokens = this.defaults.translationMaxNewTokens
    }
    if (!Number.isFinite(config.translationTopP)) config.translationTopP = this.defaults.translationTopP
    if (!Number.isFinite(config.whisperChunkLengthS) || config.whisperChunkLengthS < 1) {
      config.whisperChunkLengthS = this.defaults.whisperChunkLengthS
    }
    if (typeof config.pythonExecutable !== 'string') config.pythonExecutable = this.defaults.pythonExecutable
    if (typeof config.debugMode !== 'boolean') config.debugMode = this.defaults.debugMode
    const normalized = normalizeKouboxConfigPaths(this.applyPinned(config))
    const downloadRuntimePathsChanged = normalized.ytdlpDirectory !== config.ytdlpDirectory || normalized.denoDirectory !== config.denoDirectory
    delete (normalized as KouboxConfig & Record<string, unknown>).ytdlpCookieSource
    delete (normalized as KouboxConfig & Record<string, unknown>).ytdlpCookiesPath
    delete (normalized as KouboxConfig & Record<string, unknown>).platformBrowserProfiles
    if (usesLegacyAsrModel || migratedLegacyModelPaths || migratedLegacyVendorPaths || hasLegacyBrowserAuthFields || downloadRuntimePathsChanged || this.pinBundledPaths) {
      const persisted = this.write(normalized)
      log.debug('配置读取完成并回写迁移结果', {
        file: this.file,
        durationMs: Date.now() - startedAt,
        migratedLegacyModelPaths,
        migratedLegacyVendorPaths,
        hasLegacyBrowserAuthFields,
        downloadRuntimePathsChanged,
        pinBundledPaths: this.pinBundledPaths
      })
      return persisted
    }
    log.debug('配置读取完成', { file: this.file, durationMs: Date.now() - startedAt })
    return this.remember(normalized)
  }

  write(next: KouboxConfig): KouboxConfig {
    const pinned = normalizeKouboxConfigPaths(this.applyPinned(next))
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(pinned, null, 2), 'utf8')
    return this.remember(pinned)
  }
}

export function detectGpu(options?: { maxAgeMs?: number }): GpuStatus {
  const maxAgeMs = options?.maxAgeMs ?? 0
  if (maxAgeMs > 0 && gpuProbeCache && Date.now() - gpuProbeCache.at < maxAgeMs) {
    return gpuProbeCache.value
  }
  const value = probeGpu()
  if (maxAgeMs > 0) gpuProbeCache = { at: Date.now(), value }
  return value
}

function probeGpu(): GpuStatus {
  const startedAt = Date.now()
  const result = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0 || !result.stdout.trim()) {
    log.warn('GPU 检测失败', { durationMs: Date.now() - startedAt, exitCode: result.status })
    return { available: false, message: '未检测到可用的 NVIDIA GPU；下载和抽音可继续，ASR 与翻译需要 GPU。' }
  }
  const [name, total, used, free] = result.stdout.trim().split('\n')[0].split(',').map((item) => item.trim())
  return {
    available: true,
    name,
    totalMemoryMiB: Number(total),
    usedMemoryMiB: Number(used),
    freeMemoryMiB: Number(free),
    message: 'NVIDIA GPU 已就绪'
  }
}

export function detectSystemMemory(): SystemMemoryStatus {
  const totalMemoryMiB = Math.round(totalmem() / 1024 / 1024)
  const freeMemoryMiB = Math.round(freemem() / 1024 / 1024)
  return {
    totalMemoryMiB,
    freeMemoryMiB,
    usedMemoryMiB: totalMemoryMiB - freeMemoryMiB
  }
}

function inspectModel(
  id: string,
  label: string,
  directory: string,
  requiredFiles: string[],
  format: ModelCheck['format'] = 'transformers'
): ModelCheck {
  const startedAt = Date.now()
  const missingFiles = requiredFiles.filter((file) => !existsSync(join(directory, file)))
  const configured = existsSync(directory)
  log.debug('模型检查完成', { id, directory, durationMs: Date.now() - startedAt, configured, ready: configured && missingFiles.length === 0, foundFiles: requiredFiles.length - missingFiles.length, expectedFiles: requiredFiles.length })
  return {
    id,
    label,
    directory,
    format,
    configured,
    ready: configured && missingFiles.length === 0,
    expectedFiles: requiredFiles.length,
    foundFiles: requiredFiles.length - missingFiles.length,
    missingFiles
  }
}

function executableVersion(executable: string, versionArgument: string): string | undefined {
  const startedAt = Date.now()
  if (!existsSync(executable)) {
    log.debug('工具版本检测跳过：文件不存在', { executable, versionArgument, durationMs: Date.now() - startedAt })
    return undefined
  }
  const stat = statSync(executable)
  const cacheKey = `${executable}|${versionArgument}|${stat.size}|${stat.mtimeMs}|${stat.ctimeMs}`
  const cached = executableVersionCache.get(cacheKey)
  if (cached) {
    log.debug('工具版本检测命中缓存', { executable, versionArgument, durationMs: Date.now() - startedAt, version: cached })
    return cached
  }
  const probe = spawnSync(executable, [versionArgument], { encoding: 'utf8', windowsHide: true })
  const version = probe.status === 0 ? (probe.stdout || probe.stderr).trim().split(/\r?\n/)[0] || undefined : undefined
  if (version) executableVersionCache.set(cacheKey, version)
  log.debug('工具版本检测完成', { executable, versionArgument, durationMs: Date.now() - startedAt, exitCode: probe.status, version })
  return version
}

function inspectVendorTool(
  directory: string,
  executableName: string,
  versionArgument: string,
  expectedFiles: string[],
  knownVersion?: string
): VendorToolCheck {
  const startedAt = Date.now()
  const executable = join(directory, executableName)
  const version = knownVersion ?? executableVersion(executable, versionArgument)
  const foundFiles = expectedFiles.filter((file) => existsSync(join(directory, file)))
  const missingFiles = expectedFiles.filter((file) => !existsSync(join(directory, file)))
  log.debug('运行工具检查完成', { executable, directory, durationMs: Date.now() - startedAt, ready: Boolean(version), foundFiles: foundFiles.length, expectedFiles: expectedFiles.length, missingFiles })
  return {
    ready: Boolean(version),
    directory,
    executable,
    expectedFiles,
    foundFiles,
    missingFiles,
    version
  }
}

function inspectDemucs(directory: string): ModelCheck {
  const startedAt = Date.now()
  const configured = Boolean(directory)
  const expected = ['955717e8-8726e21a.th']
  const missingFiles = expected.filter((name) => {
    if (!existsSync(directory)) return true
    const walk = (dir: string): boolean => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory() && walk(full)) return true
        if (entry.isFile() && entry.name === name) return true
      }
      return false
    }
    return !walk(directory)
  })
  log.debug('Demucs 模型检查完成', { directory, durationMs: Date.now() - startedAt, ready: missingFiles.length === 0, missingFiles })
  return {
    id: 'demucs',
    label: 'Demucs htdemucs',
    directory,
    format: 'transformers',
    ready: missingFiles.length === 0,
    configured,
    expectedFiles: expected.length,
    foundFiles: expected.length - missingFiles.length,
    missingFiles
  }
}

export function resolveModelPaths(config: KouboxConfig): { asr: string; translation: string; demucs: string } {
  return {
    asr: config.asrModelDirectory || join(config.modelsDirectory, fasterWhisperAsrModelDirectory),
    translation: config.translationModelDirectory || join(config.modelsDirectory, 'HYMT21.8B'),
    demucs: config.demucsModelDirectory || join(config.modelsDirectory, 'demucs')
  }
}

export function resolveVendorPaths(config: KouboxConfig): {
  ytdlpDirectory: string
  ffmpegDirectory: string
  ytdlpExecutable: string
  ffmpegExecutable: string
  denoExecutable: string
} {
  return {
    ytdlpDirectory: config.ytdlpDirectory,
    ffmpegDirectory: config.ffmpegDirectory,
    ytdlpExecutable: join(config.ytdlpDirectory, 'yt-dlp.exe'),
    ffmpegExecutable: join(config.ffmpegDirectory, 'ffmpeg.exe'),
    denoExecutable: join(config.denoDirectory, 'deno.exe')
  }
}

function asAuthMode(value: unknown, fallback: PlatformAuthMode): PlatformAuthMode {
  return value === 'paste' || value === 'builtin' ? value : fallback
}

function normalizePlatformAuth(
  raw: unknown,
  defaults: PlatformAuthConfig,
  legacyInstagramCookies: unknown
): PlatformAuthConfig {
  const next = defaultPlatformAuth()
  const ids: YtdlpCookiePlatformId[] = ['youtube', 'tiktok', 'instagram', 'facebook']
  for (const id of ids) {
    next[id] = {
      mode: defaults[id]?.mode ?? next[id].mode,
      cookies: typeof defaults[id]?.cookies === 'string' ? defaults[id].cookies : ''
    }
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, { mode?: unknown; cookies?: unknown }>
    for (const id of ids) {
      const entry = record[id]
      if (!entry || typeof entry !== 'object') continue
      next[id] = {
        mode: asAuthMode(entry.mode, next[id].mode),
        cookies: typeof entry.cookies === 'string' ? entry.cookies : next[id].cookies
      }
    }
  }
  if (!next.instagram.cookies.trim()) {
    if (typeof legacyInstagramCookies === 'string' && legacyInstagramCookies.trim()) {
      next.instagram.cookies = legacyInstagramCookies
      next.instagram.mode = 'paste'
    }
  }
  return next
}

export function getRuntimeStatus(
  config: KouboxConfig,
  activeYtdlp?: ActiveYtdlpRuntime
): RuntimeStatus {
  const startedAt = Date.now()
  log.debug('运行时状态检测开始', { modelsDirectory: config.modelsDirectory, asrModelDirectory: config.asrModelDirectory, translationModelDirectory: config.translationModelDirectory, demucsModelDirectory: config.demucsModelDirectory, ytdlpDirectory: config.ytdlpDirectory, ffmpegDirectory: config.ffmpegDirectory, denoDirectory: config.denoDirectory })
  const modelPaths = resolveModelPaths(config)
  const vendorPaths = resolveVendorPaths(config)
  const activeYtdlpExecutable = activeYtdlp?.executable ?? vendorPaths.ytdlpExecutable
  const ytdlpStartedAt = Date.now()
  const ytdlpRuntime = activeYtdlp?.runtimeInspection
    ?? inspectYtdlpRuntime(activeYtdlpExecutable, vendorPaths.denoExecutable)
  log.debug('yt-dlp 运行时诊断完成', { durationMs: Date.now() - ytdlpStartedAt, cached: Boolean(activeYtdlp?.runtimeInspection), executable: activeYtdlpExecutable, denoExecutable: vendorPaths.denoExecutable, version: ytdlpRuntime.version, ejsVersion: ytdlpRuntime.ejsVersion, jsRuntimeVersion: ytdlpRuntime.jsRuntimeVersion, providerReady: ytdlpRuntime.providerReady })
  const gpu = detectGpu()
  const models = [
    inspectModel('asr', 'Faster-Whisper Large v3（FP16）', modelPaths.asr, asrModelFiles, 'ctranslate2'),
    inspectModel('translation', 'Hy-MT2-1.8B', modelPaths.translation, translationModelFiles),
    inspectDemucs(modelPaths.demucs)
  ]
  const vendor = {
    ytdlp: {
      ...inspectVendorTool(dirname(activeYtdlpExecutable), 'yt-dlp.exe', '--version', ytdlpExpectedFiles, ytdlpRuntime.version),
      channel: activeYtdlp?.channel ?? 'nightly',
      source: activeYtdlp?.source ?? 'bundled',
      ejsVersion: ytdlpRuntime.ejsVersion,
      jsRuntimeVersion: ytdlpRuntime.jsRuntimeVersion,
      ready: Boolean(ytdlpRuntime.version && ytdlpRuntime.jsRuntimeVersion)
    },
    ffmpeg: inspectVendorTool(vendorPaths.ffmpegDirectory, 'ffmpeg.exe', '-version', ffmpegExpectedFiles),
    deno: inspectVendorTool(config.denoDirectory, 'deno.exe', '--version', denoExpectedFiles, ytdlpRuntime.denoVersion)
  }
  const result = { healthy: true, startedAt: new Date().toISOString(), gpu, models, vendor }
  log.debug('运行时状态检测完成', { durationMs: Date.now() - startedAt, healthy: result.healthy, modelsReady: models.filter((model) => model.ready).length, vendorReady: Object.values(vendor).filter((tool) => tool.ready).length })
  return result
}
