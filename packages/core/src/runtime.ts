import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { GpuStatus, KouboxConfig, ModelCheck, PlatformAuthConfig, PlatformAuthMode, RuntimeStatus, VendorToolCheck, YtdlpCookiePlatformId, YtdlpCookieSource } from '@koubox/shared'
import { defaultPlatformAuth } from '@koubox/shared'

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

export class RuntimeStore {
  constructor(
    private readonly file: string,
    private readonly defaults: KouboxConfig,
    private readonly pinBundledPaths = false
  ) {}

  private applyPinned(config: KouboxConfig): KouboxConfig {
    if (!this.pinBundledPaths) return config
    // 只锁定工具链路径；模型目录允许用户改到外置 models（增量更新包不含 models）
    return {
      ...config,
      ytdlpDirectory: this.defaults.ytdlpDirectory,
      ffmpegDirectory: this.defaults.ffmpegDirectory,
      pythonExecutable: this.defaults.pythonExecutable
    }
  }

  read(): KouboxConfig {
    if (!existsSync(this.file)) return this.write(this.defaults)
    const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<KouboxConfig>
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
    if (!config.translationTargetLanguage) config.translationTargetLanguage = this.defaults.translationTargetLanguage
    if (!config.asrLanguage) config.asrLanguage = this.defaults.asrLanguage
    if (typeof config.openOutputOnComplete !== 'boolean') config.openOutputOnComplete = this.defaults.openOutputOnComplete
    if (typeof config.ytdlpProxy !== 'string') config.ytdlpProxy = this.defaults.ytdlpProxy
    const parsedSource = parsed.ytdlpCookieSource as YtdlpCookieSource | 'chrome' | 'edge' | undefined
    if (parsedSource === 'chrome' || parsedSource === 'edge') {
      config.ytdlpCookieSource = 'builtin'
    }
    if (config.ytdlpCookieSource !== 'builtin' && config.ytdlpCookieSource !== 'none' && config.ytdlpCookieSource !== 'file') {
      config.ytdlpCookieSource = this.defaults.ytdlpCookieSource
    }
    if (typeof config.ytdlpCookiesPath !== 'string') config.ytdlpCookiesPath = this.defaults.ytdlpCookiesPath
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
    const normalized = this.applyPinned(config)
    if (usesLegacyAsrModel || this.pinBundledPaths) return this.write(normalized)
    return normalized
  }

  write(next: KouboxConfig): KouboxConfig {
    const pinned = this.applyPinned(next)
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

function executableResponds(executable: string, versionArgument: string): boolean {
  if (!existsSync(executable)) return false
  const probe = spawnSync(executable, [versionArgument], { encoding: 'utf8', windowsHide: true })
  return probe.status === 0
}

function inspectVendorTool(
  directory: string,
  executableName: string,
  versionArgument: string,
  expectedFiles: string[]
): VendorToolCheck {
  const executable = join(directory, executableName)
  const foundFiles = expectedFiles.filter((file) => existsSync(join(directory, file)))
  const missingFiles = expectedFiles.filter((file) => !existsSync(join(directory, file)))
  return {
    ready: executableResponds(executable, versionArgument),
    directory,
    executable,
    expectedFiles,
    foundFiles,
    missingFiles
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
} {
  return {
    ytdlpDirectory: config.ytdlpDirectory,
    ffmpegDirectory: config.ffmpegDirectory,
    ytdlpExecutable: join(config.ytdlpDirectory, 'yt-dlp.exe'),
    ffmpegExecutable: join(config.ffmpegDirectory, 'ffmpeg.exe')
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

export function getRuntimeStatus(config: KouboxConfig): RuntimeStatus {
  const modelPaths = resolveModelPaths(config)
  const vendorPaths = resolveVendorPaths(config)
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
      ytdlp: inspectVendorTool(vendorPaths.ytdlpDirectory, 'yt-dlp.exe', '--version', ytdlpExpectedFiles),
      ffmpeg: inspectVendorTool(vendorPaths.ffmpegDirectory, 'ffmpeg.exe', '-version', ffmpegExpectedFiles)
    }
  }
}
