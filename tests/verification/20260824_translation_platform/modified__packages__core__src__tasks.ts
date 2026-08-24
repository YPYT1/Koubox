import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { detectGpu } from './runtime.js'
import { alignKnownText } from './align.js'
import { transcriptToSrt } from './srt.js'
import type {
  KouboxConfig,
  RequirementTwoMode,
  TaskArtifacts,
  TaskError,
  TaskEvent,
  TaskSnapshot,
  Transcript,
  TranslationTargetLanguage
} from '@koubox/shared'
import { detectPlatform, toUserTaskMessage, normalizeProxyUrl } from '@koubox/shared'
import { createLogger, getLoggerEnv } from '@koubox/shared/logger'

const log = createLogger('tasks')

type TaskManagerOptions = {
  getConfig(): KouboxConfig
  resolveVendor(): { ytdlpExecutable: string; ffmpegExecutable: string }
  projectDirectory: string
  pythonProjectDirectory: string
  bundledPythonExecutable?: string
  taskIndexFile: string
}

type ModelPaths = { asr: string; translation: string }

type TaskRecord = {
  task: TaskSnapshot
  listeners: Set<(event: TaskEvent) => void>
  processes: Set<ChildProcess>
  cancelled: boolean
}

type QueuedJob = {
  record: TaskRecord
  modelPaths: ModelPaths
  kind: 'req1' | 'req2'
}

type WorkerMessage = {
  type: string
  stage?: string
  percent?: number
  message?: string
  code?: string
  language?: string
  segments?: Transcript['segments']
  text?: string
  translatedLines?: string[]
  correctedLines?: string[]
  vocalsPath?: string
}

function now(): string { return new Date().toISOString() }

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function killProcessTree(child: ChildProcess): void {
  if (!child.pid || child.killed) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
  else child.kill('SIGTERM')
}

function splitExtraArgs(value: string): string[] {
  const args: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of value.matchAll(pattern)) {
    args.push(match[1] ?? match[2] ?? match[3])
  }
  return args
}

function shouldSkipTranslation(sourceLanguage: string | undefined, target: TranslationTargetLanguage): boolean {
  const src = (sourceLanguage ?? '').toLowerCase().replace('_', '-')
  if (target === 'zh-Hans') {
    return src === 'zh' || src === 'zh-hans' || src === 'zh-cn' || src === 'chinese' || src.startsWith('zh-hans')
  }
  if (target === 'zh-Hant') {
    return src === 'zh-hant' || src === 'zh-tw' || src === 'zh-hk' || src.startsWith('zh-hant')
  }
  if (target === 'en') return src === 'en' || src === 'english' || src.startsWith('en-')
  if (target === 'ja') return src === 'ja' || src === 'japanese' || src.startsWith('ja-')
  if (target === 'ko') return src === 'ko' || src === 'korean' || src.startsWith('ko-')
  return false
}

function isTranslationTargetLanguage(value: unknown): value is TranslationTargetLanguage {
  return value === 'zh-Hans' || value === 'zh-Hant' || value === 'en' || value === 'ja' || value === 'ko'
}

function splitProcessLines(text: string): string[] {
  return text.split(/\r|\n/).map((line) => line.trim()).filter(Boolean)
}

function formatCommandError(stderr: string, commandName: string): string {
  const text = stderr.trim()
  if (!text) return `${commandName} 执行失败。`
  return toUserTaskMessage(text)
}

function dateStamp(value = new Date()): string {
  const y = value.getFullYear()
  const m = String(value.getMonth() + 1).padStart(2, '0')
  const d = String(value.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

function nextSequence(prefix: string, outputDirectory: string, existingIds: string[]): number {
  let max = 0
  const consider = (name: string) => {
    if (!name.startsWith(prefix)) return
    const rest = name.slice(prefix.length)
    const numPart = rest.split(/[_.]/)[0]
    const n = Number(numPart)
    if (Number.isFinite(n)) max = Math.max(max, n)
  }
  for (const id of existingIds) consider(id)
  if (existsSync(outputDirectory)) {
    for (const name of readdirSync(outputDirectory)) consider(name)
  }
  return max + 1
}

function allocateTaskId(kind: 'req1' | 'req2', url: string, outputDirectory: string, existingIds: string[]): string {
  const detected = kind === 'req1' ? detectPlatform(url) : 'Audio'
  // Keep the existing task-id casing for compatibility with saved output folders.
  const platform = detected === 'YouTube' ? 'Youtube' : detected === 'TikTok' ? 'Tiktok' : detected
  const prefix = `${platform}_${dateStamp()}_`
  const seq = nextSequence(prefix, outputDirectory, existingIds)
  return `${prefix}${String(seq).padStart(3, '0')}`
}

export class TaskManager {
  private readonly records = new Map<string, TaskRecord>()
  private readonly queue: QueuedJob[] = []
  private runningCount = 0

  constructor(private readonly options: TaskManagerOptions) {}

  private recordsDirectory(): string {
    return join(dirname(this.options.taskIndexFile), 'records')
  }

  private recordFile(taskIdValue: string): string {
    return join(this.recordsDirectory(), `${taskIdValue}.json`)
  }

  restore(outputDirectory: string): void {
    mkdirSync(this.recordsDirectory(), { recursive: true })
    if (existsSync(this.recordsDirectory())) {
      for (const name of readdirSync(this.recordsDirectory())) {
        if (!name.endsWith('.json')) continue
        this.restoreTask(join(this.recordsDirectory(), name))
      }
    }
    if (existsSync(this.options.taskIndexFile)) {
      try {
        const taskFiles = JSON.parse(readFileSync(this.options.taskIndexFile, 'utf8')) as string[]
        for (const taskFile of taskFiles) this.restoreTask(taskFile)
      } catch { /* A malformed index must not stop the desktop application. */ }
    }
    const root = resolve(outputDirectory)
    if (!existsSync(root)) return
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || (!entry.name.startsWith('req1-') && !entry.name.startsWith('req2-'))) continue
      try {
        const taskFile = join(root, entry.name, 'task.json')
        if (!existsSync(taskFile)) continue
        this.restoreTask(taskFile)
      } catch { /* Ignore unrelated or malformed task directories. */ }
    }
  }

  list(): TaskSnapshot[] { return [...this.records.values()].map((record) => this.clone(record.task)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }

  startRequirementOne(url: string, outputDirectory: string, modelPaths: ModelPaths): TaskSnapshot {
    const outputRoot = resolve(outputDirectory)
    mkdirSync(outputRoot, { recursive: true })
    const id = allocateTaskId('req1', url, outputRoot, [...this.records.keys()])
    const taskDir = join(outputRoot, id)
    mkdirSync(taskDir, { recursive: true })
    const task: TaskSnapshot = {
      taskId: id,
      kind: 'req1',
      status: 'queued',
      stage: 'queued',
      percent: 0,
      message: '任务已排队',
      url,
      outputDirectory: taskDir,
      taskDirectory: taskDir,
      artifacts: {},
      createdAt: now(),
      updatedAt: now()
    }
    const record: TaskRecord = { task, listeners: new Set(), processes: new Set(), cancelled: false }
    this.records.set(id, record)
    this.persist(record)
    this.enqueue({ record, modelPaths, kind: 'req1' })
    return this.clone(task)
  }

  startRequirementTwo(audioPath: string, sourceText: string, outputDirectory: string, modelPaths: ModelPaths): TaskSnapshot {
    const outputRoot = resolve(outputDirectory)
    mkdirSync(outputRoot, { recursive: true })
    const id = allocateTaskId('req2', audioPath, outputRoot, [...this.records.keys()])
    const taskDir = join(outputRoot, id)
    mkdirSync(taskDir, { recursive: true })
    const mode: RequirementTwoMode = sourceText.trim() ? 'align' : 'asr-only'
    const task: TaskSnapshot = {
      taskId: id,
      kind: 'req2',
      mode,
      status: 'queued',
      stage: 'queued',
      percent: 0,
      message: mode === 'align' ? '精准对齐任务已排队' : '音频识别任务已排队',
      url: resolve(audioPath),
      sourceText: sourceText.trim() || undefined,
      outputDirectory: taskDir,
      taskDirectory: taskDir,
      artifacts: {},
      createdAt: now(),
      updatedAt: now()
    }
    const record: TaskRecord = { task, listeners: new Set(), processes: new Set(), cancelled: false }
    this.records.set(id, record)
    this.persist(record)
    this.enqueue({ record, modelPaths, kind: 'req2' })
    return this.clone(task)
  }

  get(taskIdValue: string): TaskSnapshot | undefined {
    const record = this.records.get(taskIdValue)
    return record ? this.clone(record.task) : undefined
  }

  subscribe(taskIdValue: string, listener: (event: TaskEvent) => void): () => void {
    const record = this.records.get(taskIdValue)
    if (!record) return () => undefined
    record.listeners.add(listener)
    listener({ type: 'snapshot', task: this.clone(record.task) })
    return () => record.listeners.delete(listener)
  }

  cancel(taskIdValue: string): TaskSnapshot | undefined {
    const record = this.records.get(taskIdValue)
    if (!record || ['complete', 'error', 'cancelled'].includes(record.task.status)) return record ? this.clone(record.task) : undefined
    record.cancelled = true
    const queuedIndex = this.queue.findIndex((job) => job.record.task.taskId === taskIdValue)
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1)
    for (const child of record.processes) killProcessTree(child)
    this.update(record, { status: 'cancelled', stage: 'cancelled', message: '任务已取消' })
    return this.clone(record.task)
  }

  remove(taskIdValue: string): void {
    const record = this.records.get(taskIdValue)
    if (!record) throw new Error('任务不存在。')
    if (record.task.status === 'running' || record.task.status === 'queued') {
      throw new Error('任务进行中，无法删除记录。')
    }
    this.records.delete(taskIdValue)
    const path = this.recordFile(taskIdValue)
    if (existsSync(path)) unlinkSync(path)
    mkdirSync(dirname(this.options.taskIndexFile), { recursive: true })
    const files = [...this.records.values()].map((item) => this.recordFile(item.task.taskId))
    writeFileSync(this.options.taskIndexFile, JSON.stringify(files, null, 2), 'utf8')
  }

  async translate(taskIdValue: string, modelPaths: ModelPaths, targetLanguage?: TranslationTargetLanguage): Promise<TaskSnapshot> {
    const record = this.records.get(taskIdValue)
    if (!record) throw new Error('任务不存在。')
    if (!record.task.transcript) throw new Error('ASR 尚未完成，暂时没有可翻译的原文。')
    if (record.task.status === 'cancelled') throw new Error('任务已取消。')
    if (record.task.status === 'running') throw new Error('任务仍在处理，不能开始翻译。')
    if (record.task.taskDirectory === '') throw new Error('任务目录无效。')

    const config = this.options.getConfig()
    const target = targetLanguage ?? config.translationTargetLanguage
    const sourceLines = record.task.transcript.segments.map((segment) => segment.text.trim()).filter(Boolean)
    const sourceText = sourceLines.join('\n')
    if (!sourceText) throw new Error('原文为空，无法翻译。')
    const gpu = detectGpu()
    if (!gpu.available) throw this.failWithCode(record, 'GPU_REQUIRED', '当前没有可用的 NVIDIA GPU，无法执行翻译。')

    if (shouldSkipTranslation(record.task.language, target)) {
      this.writeTranslation(record, sourceText, target)
      this.update(record, { status: 'complete', stage: 'complete', percent: 100, message: '原文已是目标语言，无需翻译。' })
      return this.clone(record.task)
    }

    this.update(record, { status: 'running', stage: 'translation', percent: 0, message: '正在加载本地翻译模型' })
    try {
      const response = await this.runWorker(record, 'translate', {
        modelDirectory: modelPaths.translation,
        text: sourceText,
        lines: sourceLines,
        sourceLanguage: record.task.language ?? '',
        targetLanguage: target,
        temperature: config.translationTemperature,
        maxNewTokens: config.translationMaxNewTokens,
        topP: config.translationTopP
      }, (message) => {
        if (message.type === 'progress') this.update(record, { percent: Math.max(1, Math.min(99, message.percent ?? 0)), message: message.message ?? '正在翻译' })
      })
      if (response.type !== 'translation' || !Array.isArray(response.translatedLines)) {
        throw new Error('翻译运行器没有返回严格逐句译文数组。')
      }
      const translatedLines = response.translatedLines.map((line) => String(line).trim())
      if (translatedLines.length !== sourceLines.length || translatedLines.some((line) => !line)) {
        throw new Error(`译文行数与原文不一致：原文 ${sourceLines.length} 行，译文 ${translatedLines.length} 行。`)
      }
      if (response.correctedLines && response.correctedLines.length !== sourceLines.length) {
        throw new Error(`日语校正行数与原文不一致：原文 ${sourceLines.length} 行，校正 ${response.correctedLines.length} 行。`)
      }
      if (response.correctedLines && record.task.transcript) {
        let lineIndex = 0
        const merged = record.task.transcript.segments.map((segment) => {
          if (!segment.text.trim()) return segment
          const nextText = response.correctedLines![lineIndex]
          lineIndex += 1
          return { ...segment, text: nextText }
        })
        this.writeTranscript(record, { language: record.task.transcript.language, segments: merged })
      }
      this.writeTranslation(record, translatedLines.join('\n'), target, translatedLines)
      this.update(record, { status: 'complete', stage: 'complete', percent: 100, message: '翻译完成' })
      return this.clone(record.task)
    } catch (error) {
      if (record.cancelled) throw error
      this.fail(record, 'TRANSLATION_FAILED', errorMessage(error))
      throw error
    }
  }

  export(taskIdValue: string, targetDirectory: string): TaskArtifacts {
    const record = this.records.get(taskIdValue)
    if (!record) throw new Error('任务不存在。')
    const destination = join(resolve(targetDirectory), record.task.taskId)
    mkdirSync(destination, { recursive: true })
    const copied: TaskArtifacts = {}
    for (const [key, source] of Object.entries(record.task.artifacts) as Array<[keyof TaskArtifacts, string | undefined]>) {
      if (!source || !existsSync(source)) continue
      if (key === 'transcript' || key === 'translation') continue
      const target = join(destination, basename(source))
      copyFileSync(source, target)
      copied[key] = target
    }
    return copied
  }

  private enqueue(job: QueuedJob): void {
    this.queue.push(job)
    this.pumpQueue()
  }

  private pumpQueue(): void {
    const max = Math.max(1, Math.floor(this.options.getConfig().maxConcurrentTasks))
    while (this.runningCount < max && this.queue.length > 0) {
      const job = this.queue.shift()
      if (!job || job.record.cancelled) continue
      this.runningCount += 1
      const run = job.kind === 'req1'
        ? this.executeRequirementOne(job.record, job.modelPaths)
        : this.executeRequirementTwo(job.record, job.modelPaths)
      void run.finally(() => {
        this.runningCount = Math.max(0, this.runningCount - 1)
        this.pumpQueue()
      })
    }
  }

  private async executeRequirementOne(record: TaskRecord, modelPaths: ModelPaths): Promise<void> {
    const { task } = record
    const root = resolve(task.outputDirectory)
    mkdirSync(root, { recursive: true })
    log.info('任务开始', { taskId: task.taskId, url: task.url })
    try {
      this.update(record, { status: 'running', stage: 'download', percent: 1, message: '正在下载视频' })
      const video = await this.download(record, root, task.taskId)
      record.task.artifacts.video = video
      this.persist(record)
      this.update(record, { stage: 'extract-audio', percent: 28, message: '正在提取原音频' })
      const audio = await this.extractAudio(record, video, join(root, `${task.taskId}.wav`))
      record.task.artifacts.audio = audio
      this.persist(record)
      const gpu = detectGpu()
      if (!gpu.available) throw this.failWithCode(record, 'GPU_REQUIRED', '视频和音频已保存，但当前没有可用的 NVIDIA GPU，无法执行人声分离与语音识别。')
      this.update(record, { stage: 'separate-vocals', percent: 36, message: '正在分离人声（去除背景音乐）' })
      const vocals = await this.separateVocals(record, audio, join(root, `${task.taskId}_人声.wav`))
      record.task.artifacts.vocals = vocals
      this.persist(record)
      await this.performAsr(record, audio, modelPaths.asr, 55)
      this.update(record, { status: 'complete', stage: 'complete', percent: 100, message: '原文识别完成' })
    } catch (error) {
      if (record.cancelled) return
      if (isTaskError(error)) this.fail(record, error.taskError.code, error.taskError.message)
      else this.fail(record, 'PIPELINE_FAILED', errorMessage(error))
      log.error('任务失败', { taskId: record.task.taskId, error: errorMessage(error) })
    }
  }

  private async executeRequirementTwo(record: TaskRecord, modelPaths: ModelPaths): Promise<void> {
    const { task } = record
    const root = resolve(task.outputDirectory)
    mkdirSync(root, { recursive: true })
    try {
      if (!existsSync(task.url)) throw this.failWithCode(record, 'AUDIO_NOT_FOUND', '选择的音频文件不存在。')
      const sourceAudio = join(root, `${task.taskId}_source${extname(task.url).toLowerCase() || '.audio'}`)
      copyFileSync(task.url, sourceAudio)
      record.task.artifacts.sourceAudio = sourceAudio
      this.update(record, { status: 'running', stage: 'extract-audio', percent: 8, message: '正在转换音频' })
      const audio = await this.extractAudio(record, sourceAudio, join(root, `${task.taskId}.wav`))
      record.task.artifacts.audio = audio
      this.persist(record)
      const gpu = detectGpu()
      if (!gpu.available) throw this.failWithCode(record, 'GPU_REQUIRED', '音频已保存，但当前没有可用的 NVIDIA GPU，无法执行语音识别。')
      await this.performAsr(record, audio, modelPaths.asr, 35)
      let finalTranscript = record.task.transcript
      if (!finalTranscript) throw new Error('ASR 未返回有效字幕。')
      if (task.mode === 'align' && task.sourceText) {
        this.update(record, { stage: 'align', percent: 84, message: '正在按原文整理时间轴' })
        finalTranscript = alignKnownText(task.sourceText, finalTranscript)
        this.writeTranscript(record, finalTranscript)
      }
      this.update(record, { stage: 'export-srt', percent: 92, message: '正在导出 SRT' })
      const srtPath = join(root, `${task.taskId}.srt`)
      writeFileSync(srtPath, transcriptToSrt(finalTranscript), 'utf8')
      record.task.artifacts.srt = srtPath
      this.persist(record)
      this.update(record, { status: 'complete', stage: 'complete', percent: 100, message: 'SRT 已生成' })
    } catch (error) {
      if (record.cancelled) return
      if (isTaskError(error)) this.fail(record, error.taskError.code, error.taskError.message)
      else this.fail(record, 'PIPELINE_FAILED', errorMessage(error))
      log.error('任务失败', { taskId: record.task.taskId, error: errorMessage(error) })
    }
  }

  private async performAsr(record: TaskRecord, audio: string, asrModelDirectory: string, startPercent: number): Promise<void> {
    const config = this.options.getConfig()
    this.update(record, { stage: 'asr', percent: startPercent, message: '正在加载语音识别模型' })
    const response = await this.runWorker(record, 'asr', {
      modelDirectory: asrModelDirectory,
      audioPath: audio,
      language: config.asrLanguage,
      chunkLengthS: config.whisperChunkLengthS
    }, (message) => {
      if (message.type === 'progress') this.update(record, { percent: Math.max(startPercent + 1, Math.min(82, message.percent ?? 0)), message: message.message ?? '正在识别音频' })
    })
    if (response.type !== 'transcript' || !response.segments) throw new Error('ASR 运行器没有返回带时间戳的原文。')
    this.writeTranscript(record, { language: response.language, segments: response.segments })
  }

  private writeTranscript(record: TaskRecord, transcript: Transcript): void {
    const textPath = join(record.task.outputDirectory, `${record.task.taskId}_原文案.txt`)
    writeFileSync(textPath, transcript.segments.map((segment) => segment.text.trim()).filter(Boolean).join('\n'), 'utf8')
    record.task.transcript = transcript
    record.task.language = transcript.language
    record.task.artifacts.transcriptText = textPath
    delete record.task.artifacts.transcript
    this.persist(record)
  }

  private async download(record: TaskRecord, directory: string, fileStem: string): Promise<string> {
    const vendor = this.options.resolveVendor()
    const executable = vendor.ytdlpExecutable
    if (!existsSync(executable)) throw new Error(`yt-dlp 不存在：${executable}`)
    if (!existsSync(vendor.ffmpegExecutable)) throw new Error(`ffmpeg 不存在：${vendor.ffmpegExecutable}`)
    const config = this.options.getConfig()
    const tempStem = `_dl_${fileStem}`
    const args = [
      '--newline',
      '--no-playlist',
      '--no-warnings',
      '--ffmpeg-location',
      dirname(vendor.ffmpegExecutable),
      '--merge-output-format',
      'mp4',
      '-o',
      join(directory, `${tempStem}.%(ext)s`)
    ]
    if (config.ytdlpProxy.trim()) {
      const proxy = normalizeProxyUrl(config.ytdlpProxy)
      if (proxy) args.push('--proxy', proxy)
    }
    if (config.ytdlpCookieSource === 'builtin') {
      const exportedCookies = join(dirname(this.options.taskIndexFile), 'ytdlp-cookies.txt')
      if (!existsSync(exportedCookies)) {
        throw new Error('尚未保存登录状态。请在「全局设置 → 下载（yt-dlp）」打开登录窗口，登录后点击「保存登录状态」。')
      }
      args.push('--cookies', exportedCookies)
    } else if (config.ytdlpCookieSource === 'file') {
      const cookiesPath = config.ytdlpCookiesPath.trim()
      if (!cookiesPath) throw new Error('登录来源为 Cookies 文件，但未选择文件。请在「全局设置 → 下载（yt-dlp）」中选择 cookies.txt。')
      if (!existsSync(cookiesPath)) throw new Error(`Cookies 文件不存在：${cookiesPath}`)
      args.push('--cookies', cookiesPath)
    }
    if (config.ytdlpMaxHeight > 0) {
      args.push('-f', `bv*[height<=${config.ytdlpMaxHeight}]+ba/b[height<=${config.ytdlpMaxHeight}]/best[height<=${config.ytdlpMaxHeight}]`)
    } else {
      args.push('-f', 'bv*+ba/b')
    }
    if (config.ytdlpExtraArgs.trim()) args.push(...splitExtraArgs(config.ytdlpExtraArgs.trim()))
    args.push(record.task.url)
    await this.runCommand(record, executable, args, (line) => {
      const percent = line.match(/(\d+(?:\.\d+)?)%/)
      if (percent) {
        this.update(record, {
          percent: Math.min(28, Math.max(1, Number(percent[1]) * 0.28)),
          message: `正在下载视频 ${percent[1]}%`
        })
        return
      }
      if (/Extracting URL/i.test(line)) {
        this.update(record, { percent: 2, message: '正在解析视频链接…' })
        return
      }
      if (/Downloading webpage|Downloading android|Downloading m3u8|Downloading player/i.test(line)) {
        this.update(record, { percent: 4, message: '正在获取视频信息…' })
        return
      }
      if (/\[download\]\s+Destination:/i.test(line)) {
        this.update(record, { percent: 8, message: '开始下载视频文件…' })
      }
    }, 'yt-dlp')
    const file = readdirSync(directory).find((name) => !name.endsWith('.part') && !name.endsWith('.ytdl') && name.startsWith(`${tempStem}.`))
    if (!file) throw new Error('yt-dlp 已结束，但没有找到下载的视频文件。')
    const downloaded = join(directory, file)
    const finalExt = extname(file).toLowerCase() || '.mp4'
    const finalPath = join(directory, `${fileStem}${finalExt === '.mp4' ? '.mp4' : finalExt}`)
    if (downloaded !== finalPath) {
      if (existsSync(finalPath)) throw new Error(`目标视频文件已存在：${finalPath}`)
      renameSync(downloaded, finalPath)
    }
    return finalPath
  }

  private async separateVocals(record: TaskRecord, audioPath: string, vocalsPath: string): Promise<string> {
    const config = this.options.getConfig()
    const modelsDirectory = config.demucsModelDirectory || join(config.modelsDirectory, 'demucs')
    mkdirSync(modelsDirectory, { recursive: true })
    const response = await this.runWorker(record, 'separate', {
      audioPath,
      vocalsPath,
      modelsDirectory,
      modelName: 'htdemucs'
    }, (message) => {
      if (message.type === 'progress') {
        this.update(record, {
          percent: Math.max(36, Math.min(54, message.percent ?? 36)),
          message: message.message ?? '正在分离人声'
        })
      }
    }, { TORCH_HOME: modelsDirectory })
    if (response.type !== 'separated' || !response.vocalsPath) throw new Error('人声分离没有返回有效文件。')
    if (!existsSync(response.vocalsPath)) throw new Error('人声文件未生成。')
    return response.vocalsPath
  }

  private async extractAudio(
    record: TaskRecord,
    inputPath: string,
    audioPath: string
  ): Promise<string> {
    const executable = this.options.resolveVendor().ffmpegExecutable
    if (!existsSync(executable)) throw new Error(`FFmpeg 不存在：${executable}`)
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputPath,
      '-vn'
    ]
    args.push('-c:a', 'pcm_s24le', audioPath)
    await this.runCommand(record, executable, args)
    if (!existsSync(audioPath)) throw new Error('FFmpeg 已结束，但没有找到抽取的音频文件。')
    return audioPath
  }

  private runCommand(
    record: TaskRecord,
    command: string,
    args: string[],
    onLine?: (line: string) => void,
    commandLabel?: string
  ): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, { cwd: this.options.projectDirectory, windowsHide: true })
      record.processes.add(child)
      let stderr = ''
      const consume = (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        stderr += text
        for (const line of splitProcessLines(text)) onLine?.(line)
      }
      child.stdout?.on('data', consume); child.stderr?.on('data', consume)
      child.once('error', (error) => { record.processes.delete(child); reject(error) })
      child.once('close', (code) => {
        record.processes.delete(child)
        if (record.cancelled) return reject(new Error('任务已取消。'))
        if (code === 0) resolvePromise()
        else reject(new Error(formatCommandError(stderr, commandLabel ?? basename(command))))
      })
    })
  }

  private resolvePythonCommand(): { command: string; prefix: string[] } {
    const configured = this.options.getConfig().pythonExecutable.trim()
    if (configured && existsSync(configured)) {
      return { command: configured, prefix: ['-m', 'koubox_runtime'] }
    }
    const venvPython = join(this.options.pythonProjectDirectory, '.venv', 'Scripts', 'python.exe')
    if (existsSync(venvPython)) {
      return { command: venvPython, prefix: ['-m', 'koubox_runtime'] }
    }
    if (this.options.bundledPythonExecutable && existsSync(this.options.bundledPythonExecutable)) {
      return { command: this.options.bundledPythonExecutable, prefix: ['-m', 'koubox_runtime'] }
    }
    return { command: 'uv', prefix: ['run', '--project', this.options.pythonProjectDirectory, 'python', '-m', 'koubox_runtime'] }
  }

  private workerEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
    const proxy = normalizeProxyUrl(this.options.getConfig().ytdlpProxy)
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1', ...getLoggerEnv(), ...extra }
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
      delete env[key]
    }
    if (proxy) {
      env.HTTP_PROXY = proxy
      env.HTTPS_PROXY = proxy
    }
    return env
  }

  private runWorker(
    record: TaskRecord,
    operation: 'asr' | 'translate' | 'separate',
    payload: Record<string, unknown>,
    onMessage: (message: WorkerMessage) => void,
    envExtra?: Record<string, string>
  ): Promise<WorkerMessage> {
    const python = this.resolvePythonCommand()
    log.info(`启动 worker: ${operation}`, { command: python.command, prefix: python.prefix })
    const child = spawn(python.command, [...python.prefix], {
      cwd: this.options.projectDirectory,
      windowsHide: true,
      env: this.workerEnv(envExtra)
    })
    record.processes.add(child)
    return new Promise((resolvePromise, reject) => {
      let buffer = ''
      let final: WorkerMessage | undefined
      let stderr = ''
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const message = JSON.parse(line) as WorkerMessage
            if (message.type === 'error') return reject(Object.assign(new Error(message.message ?? '本地模型运行失败。'), { code: message.code }))
            onMessage(message)
            if (message.type === 'transcript' || message.type === 'translation' || message.type === 'separated') final = message
          } catch { /* Ignore non-protocol stdout noise. */ }
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      child.once('error', (error) => { record.processes.delete(child); reject(error) })
      child.once('close', (code) => {
        record.processes.delete(child)
        if (record.cancelled) return reject(new Error('任务已取消。'))
        if (code !== 0) {
          log.error(`worker 退出失败: ${operation}`, { code, stderr: stderr.trim() })
          return reject(new Error(stderr.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '本地模型运行器退出失败。'))
        }
        if (!final) return reject(new Error('本地模型运行器没有返回结果。'))
        resolvePromise(final)
      })
      child.stdin?.write(`${JSON.stringify({ operation, ...payload })}\n`)
      child.stdin?.end()
    })
  }

  private writeTranslation(record: TaskRecord, text: string, language: TranslationTargetLanguage, lines?: string[]): void {
    const textPath = join(record.task.outputDirectory, `${record.task.taskId}_翻译.txt`)
    writeFileSync(textPath, text, 'utf8')
    record.task.translation = text
    record.task.translationLines = lines ?? text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    record.task.artifacts.translationText = textPath
    delete record.task.artifacts.translation
    this.persist(record)
  }

  private failWithCode(record: TaskRecord, code: string, message: string): Error & { taskError: TaskError } {
    const error = Object.assign(new Error(message), { taskError: { code, message } })
    return error
  }

  private fail(record: TaskRecord, code: string, message: string): void {
    const userMessage = toUserTaskMessage(message)
    log.error('任务阶段失败', { taskId: record.task.taskId, code, message: userMessage })
    this.update(record, { status: 'error', stage: 'error', message: userMessage, error: { code, message: userMessage } })
  }

  private update(record: TaskRecord, patch: Partial<TaskSnapshot>): void {
    Object.assign(record.task, patch, { updatedAt: now() }); this.persist(record)
    const event: TaskEvent = { type: 'snapshot', task: this.clone(record.task) }
    for (const listener of [...record.listeners]) {
      try {
        listener(event)
      } catch {
        record.listeners.delete(listener)
      }
    }
  }

  private restoreTask(taskFile: string): void {
    try {
      if (!existsSync(taskFile)) return
      const task = JSON.parse(readFileSync(taskFile, 'utf8')) as TaskSnapshot
      if (!task.taskId || !task.taskDirectory) return
      if (this.records.has(task.taskId)) return
      task.kind ??= task.taskId.startsWith('req2-') || task.taskId.startsWith('Audio_') ? 'req2' : 'req1'
      if (task.status === 'running' || task.status === 'queued') {
        task.status = 'error'; task.stage = 'error'; task.message = '应用退出导致任务中断。'; task.error = { code: 'INTERRUPTED', message: task.message }; task.updatedAt = now()
        writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf8')
      }
      this.records.set(task.taskId, { task, listeners: new Set(), processes: new Set(), cancelled: false })
    } catch { /* Ignore malformed task records. */ }
  }

  private persist(record: TaskRecord): void {
    const path = this.recordFile(record.task.taskId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(record.task, null, 2), 'utf8')
    mkdirSync(dirname(this.options.taskIndexFile), { recursive: true })
    const files = [...this.records.values()].map((item) => this.recordFile(item.task.taskId))
    writeFileSync(this.options.taskIndexFile, JSON.stringify(files, null, 2), 'utf8')
  }
  private clone(task: TaskSnapshot): TaskSnapshot { return JSON.parse(JSON.stringify(task)) as TaskSnapshot }
}

function isTaskError(error: unknown): error is { taskError: TaskError } { return Boolean(error && typeof error === 'object' && 'taskError' in error) }

export { isTranslationTargetLanguage }
