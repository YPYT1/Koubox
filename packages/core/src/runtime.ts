import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { GpuStatus, KouboxConfig, ModelCheck, RuntimeStatus } from '@koubox/shared'

const asrModelFiles = [
  'README.md', 'added_tokens.json', 'config.json', 'generation_config.json',
  'merges.txt', 'model.safetensors', 'normalizer.json', 'preprocessor_config.json',
  'special_tokens_map.json', 'tokenizer_config.json', 'tokenizer.json', 'vocab.json'
]

const translationModelFiles = [
  'chat_template.jinja', 'config.json', 'configuration.json', 'generation_config.json',
  'model.safetensors', 'special_tokens_map.json', 'tokenizer_config.json', 'tokenizer.json',
  'README_CN.md', 'LICENSE.txt'
]

export class RuntimeStore {
  constructor(private readonly file: string, private readonly defaults: KouboxConfig) {}

  read(): KouboxConfig {
    if (!existsSync(this.file)) return this.write(this.defaults)
    const config = { ...this.defaults, ...JSON.parse(readFileSync(this.file, 'utf8')) as Partial<KouboxConfig> }
    if (basename(config.modelsDirectory).toLowerCase() === 'model' && !existsSync(config.modelsDirectory) && existsSync(this.defaults.modelsDirectory)) {
      config.modelsDirectory = this.defaults.modelsDirectory
      return this.write(config)
    }
    return config
  }

  write(next: KouboxConfig): KouboxConfig {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(next, null, 2), 'utf8')
    return next
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

function inspectModel(id: string, label: string, directory: string, requiredFiles: string[]): ModelCheck {
  const missingFiles = requiredFiles.filter((file) => !existsSync(join(directory, file)))
  const configured = existsSync(directory)
  return {
    id,
    label,
    directory,
    format: 'transformers',
    configured,
    ready: configured && missingFiles.length === 0,
    expectedFiles: requiredFiles.length,
    foundFiles: requiredFiles.length - missingFiles.length,
    missingFiles
  }
}

function embeddedExecutableAvailable(executable: string, versionArgument: string): boolean {
  if (!existsSync(executable)) return false
  const probe = spawnSync(executable, [versionArgument], { encoding: 'utf8', windowsHide: true })
  return probe.status === 0
}

export function getRuntimeStatus(config: KouboxConfig, vendorDirectory: string): RuntimeStatus {
  const asrDirectory = join(config.modelsDirectory, 'whisperlargev3turbo')
  return {
    healthy: true,
    startedAt: new Date().toISOString(),
    gpu: detectGpu(),
    models: [
      inspectModel('asr', 'Whisper Large v3 Turbo', asrDirectory, asrModelFiles),
      inspectModel('translation', 'HYMT21.8B', join(config.modelsDirectory, 'HYMT21.8B'), translationModelFiles)
    ],
    vendor: {
      ytdlp: embeddedExecutableAvailable(join(vendorDirectory, 'yt-dlp', 'yt-dlp.exe'), '--version'),
      ffmpeg: embeddedExecutableAvailable(join(vendorDirectory, 'ffmpeg', 'bin', 'ffmpeg.exe'), '-version')
    }
  }
}
