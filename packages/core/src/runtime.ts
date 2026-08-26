import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { GpuStatus, KouboxConfig, ModelCheck, PlatformAuthConfig, PlatformAuthMode, RuntimeStatus, VendorToolCheck, YtdlpCookiePlatformId } from '@koubox/shared'
import { defaultPlatformAuth, normalizeKouboxConfigPaths } from '@koubox/shared'
import { inspectYtdlpRuntime } from './ytdlp-update.js'

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
  return normalized.endsWith(`/koubox/vendor/${suffix}`)
}

export class RuntimeStore {
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

  read(): KouboxConfig {
    if (!existsSync(this.file)) return this.write(this.defaults)
    const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<KouboxConfig>
    const legacy = parsed as Partial<KouboxConfig> & Record<string, unknown>
    const hasLegacyBrowserAuthFields = 'ytdlpCookieSource' in legacy || 'ytdlpCookiesPath' in legacy || 'platformBrowserProfiles' in legacy
    const config = { ...this.defaults, ...parsed }
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
    if (usesLegacyAsrModel || migratedLegacyVendorPaths || hasLegacyBrowserAuthFields || downloadRuntimePathsChanged || this.pinBundledPaths) return this.write(normalized)
    return normalized
  }

  write(next: KouboxConfig): KouboxConfig {
    const pinned = normalizeKouboxConfigPaths(this.applyPinned(next))
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(pinned, null, 2), 'utf8')
    return pinned
  }
}

export function detectGpu(): GpuStatus {
  const result = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0 || !result.stdout.trim()) {
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

function inspectModel(
  id: string,
  label: string,
  directory: string,
  requiredFiles: string[],
  format: ModelCheck['format'] = 'transformers'
): ModelCheck {
  const missingFiles = requiredFiles.filter((file) => !existsSync(join(directory, file)))
  const configured = existsSync(directory)
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
  if (!existsSync(executable)) return undefined
  const probe = spawnSync(executable, [versionArgument], { encoding: 'utf8', windowsHide: true })
  if (probe.status !== 0) return undefined
  return (probe.stdout || probe.stderr).trim().split(/\r?\n/)[0] || undefined
}

function inspectVendorTool(
  directory: string,
  executableName: string,
  versionArgument: string,
  expectedFiles: string[]
): VendorToolCheck {
  const executable = join(directory, executableName)
  const version = executableVersion(executable, versionArgument)
  const foundFiles = expectedFiles.filter((file) => existsSync(join(directory, file)))
  const missingFiles = expectedFiles.filter((file) => !existsSync(join(directory, file)))
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
  activeYtdlp?: { executable: string; source: 'bundled' | 'user-update'; channel: 'nightly' }
): RuntimeStatus {
  const modelPaths = resolveModelPaths(config)
  const vendorPaths = resolveVendorPaths(config)
  const activeYtdlpExecutable = activeYtdlp?.executable ?? vendorPaths.ytdlpExecutable
  const ytdlpRuntime = inspectYtdlpRuntime(activeYtdlpExecutable, vendorPaths.denoExecutable)
  return {
    healthy: true,
    startedAt: new Date().toISOString(),
    gpu: detectGpu(),
    models: [
      inspectModel('asr', 'Faster-Whisper Large v3（FP16）', modelPaths.asr, asrModelFiles, 'ctranslate2'),
      inspectModel('translation', 'Hy-MT2-1.8B', modelPaths.translation, translationModelFiles),
      inspectDemucs(modelPaths.demucs)
    ],
    vendor: {
      ytdlp: {
        ...inspectVendorTool(
          dirname(activeYtdlpExecutable),
          'yt-dlp.exe',
          '--version',
          ytdlpExpectedFiles
        ),
        channel: activeYtdlp?.channel ?? 'nightly',
        source: activeYtdlp?.source ?? 'bundled',
        ejsVersion: ytdlpRuntime.ejsVersion,
        jsRuntimeVersion: ytdlpRuntime.jsRuntimeVersion,
        // 只要 version 和 jsRuntimeVersion 存在就认为 ready
        // ejsVersion 只在用 --simulate 时才能检测到，不作为 ready 的必要条件
        ready: Boolean(ytdlpRuntime.version && ytdlpRuntime.jsRuntimeVersion)
      },
      ffmpeg: inspectVendorTool(vendorPaths.ffmpegDirectory, 'ffmpeg.exe', '-version', ffmpegExpectedFiles),
      deno: inspectVendorTool(config.denoDirectory, 'deno.exe', '--version', denoExpectedFiles)
    }
  }
}
