import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, delimiter } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { detectGpu } from './runtime.js'
import { assertValidTranscript, transcriptToSrt } from './srt.js'
import { downloadVideo, verifyDownloadedMedia, type PublicMediaResolution } from './video-download.js'
import type {
  AsrLanguage,
  KouboxConfig,
  PlatformAuthEntry,
  RequirementTwoMode,
  SpeechRateMode,
  TaskArtifacts,
  TaskError,
  TaskEvent,
  TaskSnapshot,
  TaskStage,
  Transcript,
  TranslationTargetLanguage
} from '@koubox/shared'
import {
  asrAlignmentFallbackNoticeMessage,
  asrFallbackNoticeMessage,
  asrResourceErrorUserMessage,
  detectPlatform,
  isAsrAlignmentQualityError,
  isAsrResourceError,
  platformAuthIdFromUrlPlatform,
  req1UsesSeparateVocals,
  toUserTaskMessage,
  normalizeOsPath,
  normalizeProxyUrl,
  LOCAL_VIDEO_EXTENSIONS
} from '@koubox/shared'
import { createLogger, getLoggerEnv } from '@koubox/shared/logger'
import type { AuthenticatedCookieFile } from './video-download.js'
import {
  AsrResourceExhaustedError,
  runAsrExecutionPlan,
  type AsrExecutionPlan,
  type ResolvedAsrModel
} from './asr-execution.js'

const log = createLogger('tasks')

type TaskManagerOptions = {
  getConfig(): KouboxConfig
  resolveVendor(): { ytdlpExecutable: string; ffmpegExecutable: string; denoExecutable: string }
  projectDirectory: string
  pythonProjectDirectory: string
  bundledPythonExecutable?: string
  /** Worker hard timeout override, mainly for tests. Production uses operation-specific defaults. */
  workerTimeoutMs?: number
  taskIndexFile: string
  downloadTikTokPublic?(url: string, directory: string, fileStem: string, onLine?: (line: string) => void): Promise<string>
  resolveTikTokBrowserMedia?(url: string, proxy: string, signal?: AbortSignal): Promise<PublicMediaResolution>
  resolveFacebookAnonymousMedia?(url: string, proxy: string, signal?: AbortSignal): Promise<PublicMediaResolution>
  resolvePlatformAuthentication?(
    platformId: 'youtube' | 'tiktok' | 'instagram' | 'facebook',
    auth: PlatformAuthEntry
  ): Promise<AuthenticatedCookieFile>
}

type ModelPaths = { asrPlan: AsrExecutionPlan; translation: string }

type TaskRecord = {
  task: TaskSnapshot
  listeners: Set<(event: TaskEvent) => void>
  processes: Set<ChildProcess>
  cancelled: boolean
  slotReleased: boolean
  abortController: AbortController
}

type QueuedJob = {
  record: TaskRecord
  modelPaths?: ModelPaths
  kind: 'req1' | 'req2' | 'download' | 'video-audio' | 'vocal-separation' | 'speech-to-text'
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
  lineIndex?: number
  totalLines?: number
  translatedLines?: string[]
  correctedLines?: string[]
  vocalsPath?: string
  diagnostics?: {
    speechRateTriggered?: boolean
    [key: string]: unknown
  }
}

const WORKER_TIMEOUT_MS: Record<'asr' | 'precise_srt' | 'translate' | 'separate', number> = {
  asr: 30 * 60_000,
  precise_srt: 60 * 60_000,
  translate: 30 * 60_000,
  separate: 45 * 60_000
}

const WORKER_DIAGNOSTIC_MAX_CHARS = 64 * 1024

function now(): string { return new Date().toISOString() }

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function createWorkerTaskError(message: string, code?: string): Error & { code: string; taskError: TaskError } {
  const userMessage = toUserTaskMessage(message)
  const workerCode = code?.trim() || 'WORKER_FAILED'
  return Object.assign(new Error(userMessage), {
    code: workerCode,
    taskError: { code: workerCode, message: userMessage }
  })
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid || child.killed) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
  else child.kill('SIGTERM')
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

function appendDiagnosticTail(current: string, chunk: string): string {
  const combined = current + chunk
  return combined.length <= WORKER_DIAGNOSTIC_MAX_CHARS
    ? combined
    : combined.slice(-WORKER_DIAGNOSTIC_MAX_CHARS)
}

function isWorkerProtocolNoise(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { type?: string }
    return typeof parsed.type === 'string' && parsed.type !== 'error'
  } catch {
    return false
  }
}

function workerProcessError(stderr: string, stdoutBuffer = ''): string {
  const lines = [stdoutBuffer, stderr]
    .flatMap((source) => source.trim().split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return '本地模型运行失败，请查看日志。'
  const oom = lines.find((line) => isAsrResourceError(line))
  if (oom) return oom
  const noise = /deprecated|FutureWarning|UserWarning|\[transformers\]/i
  const meaningful = lines.filter((line) => !noise.test(line) && !isWorkerProtocolNoise(line))
  return meaningful.at(-1) ?? '本地模型运行失败，请查看日志。'
}

function workerErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error ?? '')
  const taskError = (error as { taskError?: TaskError }).taskError
  return taskError?.message ?? (error instanceof Error ? error.message : String(error))
}

function isWorkerResourceError(error: unknown): boolean {
  return isAsrResourceError(workerErrorMessage(error))
}

function isWorkerAlignmentQualityError(error: unknown): boolean {
  const taskError = error && typeof error === 'object'
    ? (error as { taskError?: TaskError }).taskError
    : undefined
  if (taskError?.code === 'PRECISE_SRT_ALIGNMENT_INCOMPLETE') return true
  return isAsrAlignmentQualityError(workerErrorMessage(error))
}

function parseWorkerFailure(stderr: string, stdoutBuffer = ''): { message: string; code?: string } {
  for (const source of [stdoutBuffer, stderr]) {
    const lines = source.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]) as { type?: string; code?: string; message?: string }
        if (parsed.type === 'error' && parsed.message) {
          return { message: parsed.message, code: parsed.code }
        }
      } catch { /* Ignore non-protocol stdout noise. */ }
    }
  }
  const codeMatch = stderr.match(/"code"\s*:\s*"([^"]+)"/) ?? stdoutBuffer.match(/"code"\s*:\s*"([^"]+)"/)
  return { message: workerProcessError(stderr, stdoutBuffer), code: codeMatch?.[1] }
}

function initialAsrExecution(plan: AsrExecutionPlan): NonNullable<TaskSnapshot['asrExecution']> {
  return {
    selectedModel: plan.selectedModel,
    effectiveModel: plan.primary.id,
    fallbackUsed: false
  }
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

function allocateTaskId(
  kind: 'req1' | 'req2' | 'download' | 'video-audio' | 'vocal-separation' | 'speech-to-text',
  url: string,
  outputDirectory: string,
  existingIds: string[]
): string {
  const detected = kind === 'req1' || kind === 'download' || kind === 'video-audio' ? detectPlatform(url) : 'Audio'
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

  private createRecord(task: TaskSnapshot, restored = false): TaskRecord {
    return {
      task,
      listeners: new Set(),
      processes: new Set(),
      cancelled: false,
      slotReleased: restored,
      abortController: new AbortController()
    }
  }

  private releaseJobSlot(record: TaskRecord): void {
    if (record.slotReleased) return
    record.slotReleased = true
    this.runningCount = Math.max(0, this.runningCount - 1)
    this.pumpQueue()
  }

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
        for (const taskFile of taskFiles) this.restoreTask(normalizeOsPath(taskFile))
      } catch { /* A malformed index must not stop the desktop application. */ }
    }
    const root = resolve(normalizeOsPath(outputDirectory))
    if (!existsSync(root)) return
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || (!entry.name.startsWith('req1-') && !entry.name.startsWith('req2-') && !entry.name.startsWith('download-'))) continue
      try {
        const taskFile = join(root, entry.name, 'task.json')
        if (!existsSync(taskFile)) continue
        this.restoreTask(taskFile)
      } catch { /* Ignore unrelated or malformed task directories. */ }
    }
  }

  list(): TaskSnapshot[] { return [...this.records.values()].map((record) => this.clone(record.task)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }

  startRequirementOne(
    source: string,
    outputDirectory: string,
    modelPaths: ModelPaths,
    sourceMode: 'url' | 'local' = 'url',
    separateVocals = false
  ): TaskSnapshot {
    const outputRoot = resolve(normalizeOsPath(outputDirectory))
    mkdirSync(outputRoot, { recursive: true })
    const resolvedSource = sourceMode === 'local' ? resolve(normalizeOsPath(source)) : source.trim()
    const id = allocateTaskId('req1', resolvedSource, outputRoot, [...this.records.keys()])
    const taskDir = join(outputRoot, id)
    mkdirSync(taskDir, { recursive: true })
    const task: TaskSnapshot = {
      taskId: id,
      kind: 'req1',
      sourceMode,
      separateVocals,
      asrExecution: initialAsrExecution(modelPaths.asrPlan),
      status: 'queued',
      stage: 'queued',
      percent: 0,
      message: sourceMode === 'local' ? '本地视频任务已排队' : '任务已排队',
      url: resolvedSource,
      outputDirectory: taskDir,
      taskDirectory: taskDir,
      artifacts: {},
      createdAt: now(),
      updatedAt: now()
    }
    const record = this.createRecord(task)
    this.records.set(id, record)
    this.persist(record)
    this.enqueue({ record, modelPaths, kind: 'req1' })
    return this.clone(task)
  }

  startRequirementTwo(
    audioPath: string,
    sourceText: string,
    outputDirectory: string,
    modelPaths: ModelPaths,
    requestedLanguage: AsrLanguage = 'auto',
    speechRateMode: SpeechRateMode = 'auto'
  ): TaskSnapshot {
    const outputRoot = resolve(normalizeOsPath(outputDirectory))
    mkdirSync(outputRoot, { recursive: true })
    const resolvedAudio = resolve(normalizeOsPath(audioPath))
    const id = allocateTaskId('req2', resolvedAudio, outputRoot, [...this.records.keys()])
    const taskDir = join(outputRoot, id)
    mkdirSync(taskDir, { recursive: true })
    const mode: RequirementTwoMode = sourceText.trim() ? 'align' : 'asr-only'
    const effectiveSpeechRateMode = mode === 'asr-only' ? speechRateMode : 'off'
    const task: TaskSnapshot = {
      taskId: id,
      kind: 'req2',
      mode,
      requestedLanguage,
      speechRateMode: effectiveSpeechRateMode,
      asrExecution: initialAsrExecution(modelPaths.asrPlan),
      status: 'queued',
      stage: 'queued',
      percent: 0,
      message: mode === 'align' ? '精准对齐任务已排队' : '音频识别任务已排队',
      url: resolvedAudio,
      sourceText: sourceText.trim() || undefined,
      outputDirectory: taskDir,
      taskDirectory: taskDir,
      artifacts: {},
      createdAt: now(),
      updatedAt: now()
    }
    const record = this.createRecord(task)
    this.records.set(id, record)
    this.persist(record)
    this.enqueue({ record, modelPaths, kind: 'req2' })
    return this.clone(task)
  }

  startDownload(url: string, outputDirectory: string): TaskSnapshot {
    const outputRoot = resolve(normalizeOsPath(outputDirectory))
    mkdirSync(outputRoot, { recursive: true })
    const id = allocateTaskId('download', url, outputRoot, [...this.records.keys()])
    const taskDir = join(outputRoot, id)
    mkdirSync(taskDir, { recursive: true })
    const task: TaskSnapshot = {
      taskId: id,
      kind: 'download',
      status: 'queued',
      stage: 'queued',
      percent: 0,
      message: '下载任务已排队',
      url,
      outputDirectory: taskDir,
      taskDirectory: taskDir,
      artifacts: {},
      createdAt: now(),
      updatedAt: now()
    }
    const record = this.createRecord(task)
    this.records.set(id, record)
    this.persist(record)
    this.enqueue({ record, kind: 'download' })
    return this.clone(task)
  }

  startVideoAudio(
    source: string,
    outputDirectory: string,
    sourceMode: 'url' | 'local' = 'url'
  ): TaskSnapshot {
    const outputRoot = resolve(normalizeOsPath(outputDirectory))
    mkdirSync(outputRoot, { recursive: true })
    const resolvedSource = sourceMode === 'local' ? resolve(normalizeOsPath(source)) : source.trim()
    const id = allocateTaskId('video-audio', resolvedSource, outputRoot, [...this.records.keys()])
    const taskDir = join(outputRoot, id)
    mkdirSync(taskDir, { recursive: true })
    const task: TaskSnapshot = {
      taskId: id,
      kind: 'video-audio',
      sourceMode,
      status: 'queued',
      stage: 'queued',
      percent: 0,
      message: sourceMode === 'local' ? '本地视频任务已排队' : '音频提取任务已排队',
      url: resolvedSource,
      outputDirectory: taskDir,
      taskDirectory: taskDir,
      artifacts: {},
      createdAt: now(),
      updatedAt: now()
    }
    const record = this.createRecord(task)
    this.records.set(id, record)
    this.persist(record)
    this.enqueue({ record, kind: 'video-audio' })
    return this.clone(task)
  }

  startVocalSeparation(audioPath: string, outputDirectory: string): TaskSnapshot {
    const outputRoot = resolve(normalizeOsPath(outputDirectory))
    mkdirSync(outputRoot, { recursive: true })
    const resolvedAudio = resolve(normalizeOsPath(audioPath))
    const id = allocateTaskId('vocal-separation', resolvedAudio, outputRoot, [...this.records.keys()])
    const taskDir = join(outputRoot, id)
    mkdirSync(taskDir, { recursive: true })
    const task: TaskSnapshot = {
      taskId: id,
      kind: 'vocal-separation',
      status: 'queued',
      stage: 'queued',
      percent: 0,
      message: '去除背景音乐任务已排队',
      url: resolvedAudio,
      outputDirectory: taskDir,
      taskDirectory: taskDir,
      artifacts: {},
      createdAt: now(),
      updatedAt: now()
    }
    const record = this.createRecord(task)
    this.records.set(id, record)
    this.persist(record)
    this.enqueue({ record, kind: 'vocal-separation' })
    return this.clone(task)
  }

  startSpeechToText(mediaPath: string, outputDirectory: string, modelPaths: ModelPaths): TaskSnapshot {
    const outputRoot = resolve(normalizeOsPath(outputDirectory))
    mkdirSync(outputRoot, { recursive: true })
    const resolvedMedia = resolve(normalizeOsPath(mediaPath))
    const id = allocateTaskId('speech-to-text', resolvedMedia, outputRoot, [...this.records.keys()])
    const taskDir = join(outputRoot, id)
    mkdirSync(taskDir, { recursive: true })
    const task: TaskSnapshot = {
      taskId: id,
      kind: 'speech-to-text',
      asrExecution: initialAsrExecution(modelPaths.asrPlan),
      status: 'queued',
      stage: 'queued',
      percent: 0,
      message: '语音转文字任务已排队',
      url: resolvedMedia,
      outputDirectory: taskDir,
      taskDirectory: taskDir,
      artifacts: {},
      createdAt: now(),
      updatedAt: now()
    }
    const record = this.createRecord(task)
    this.records.set(id, record)
    this.persist(record)
    this.enqueue({ record, modelPaths, kind: 'speech-to-text' })
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
    const wasRunning = record.task.status === 'running'
    record.cancelled = true
    record.abortController.abort()
    const queuedIndex = this.queue.findIndex((job) => job.record.task.taskId === taskIdValue)
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1)
    for (const child of [...record.processes]) killProcessTree(child)
    if (wasRunning) this.releaseJobSlot(record)
    this.update(record, { status: 'cancelled', stage: 'cancelled', message: '任务已取消' })
    return this.clone(record.task)
  }

  remove(taskIdValue: string, options?: { deleteFiles?: boolean }): void {
    const record = this.records.get(taskIdValue)
    if (!record) throw new Error('任务不存在。')
    if (record.task.status === 'running' || record.task.status === 'queued') {
      throw new Error('任务进行中，无法删除记录。')
    }
    const taskDirectory = record.task.taskDirectory || record.task.outputDirectory
    this.records.delete(taskIdValue)
    const path = this.recordFile(taskIdValue)
    if (existsSync(path)) unlinkSync(path)
    mkdirSync(dirname(this.options.taskIndexFile), { recursive: true })
    const files = [...this.records.values()].map((item) => this.recordFile(item.task.taskId))
    writeFileSync(this.options.taskIndexFile, JSON.stringify(files, null, 2), 'utf8')
    if (options?.deleteFiles) this.deleteTaskDirectory(taskIdValue, taskDirectory)
  }

  private deleteTaskDirectory(taskIdValue: string, taskDirectory: string): void {
    const resolved = resolve(normalizeOsPath(taskDirectory))
    if (!resolved || !existsSync(resolved)) return
    if (basename(resolved) !== taskIdValue) {
      throw new Error('任务目录校验失败，已中止删除文件。')
    }
    rmSync(resolved, { recursive: true, force: true })
  }

  /** Wipe in-memory tasks and on-disk task index/records. Does not delete output media folders. */
  clearAllRecords(): void {
    for (const id of [...this.records.keys()]) {
      const record = this.records.get(id)
      if (!record) continue
      if (record.task.status === 'running' || record.task.status === 'queued') {
        record.cancelled = true
        record.abortController.abort()
        for (const child of [...record.processes]) killProcessTree(child)
      }
    }
    this.queue.length = 0
    this.records.clear()
    this.runningCount = 0
    const recordsDir = this.recordsDirectory()
    if (existsSync(recordsDir)) {
      for (const name of readdirSync(recordsDir)) {
        if (!name.endsWith('.json')) continue
        try { unlinkSync(join(recordsDir, name)) } catch { /* ignore locked record */ }
      }
    }
    mkdirSync(dirname(this.options.taskIndexFile), { recursive: true })
    writeFileSync(this.options.taskIndexFile, '[]', 'utf8')
  }

  hasActiveTasks(): boolean {
    return this.runningCount > 0 || this.queue.length > 0
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
      await this.performTranslation(record, modelPaths.translation, target, sourceLines, sourceText)
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
    const destination = join(resolve(normalizeOsPath(targetDirectory)), record.task.taskId)
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
        ? this.executeRequirementOne(job.record, job.modelPaths!)
        : job.kind === 'req2'
          ? this.executeRequirementTwo(job.record, job.modelPaths!)
          : job.kind === 'video-audio'
            ? this.executeVideoAudio(job.record)
            : job.kind === 'vocal-separation'
              ? this.executeVocalSeparation(job.record)
              : job.kind === 'speech-to-text'
                ? this.executeSpeechToText(job.record, job.modelPaths!)
                : this.executeDownloadOnly(job.record)
      void run.finally(() => {
        this.releaseJobSlot(job.record)
      })
    }
  }

  private resolveSourceMode(task: TaskSnapshot): 'url' | 'local' {
    return task.sourceMode ?? (/^https?:\/\//i.test(task.url) ? 'url' : 'local')
  }

  private async probeVideoHasAudio(filePath: string): Promise<boolean> {
    const media = await verifyDownloadedMedia(
      filePath,
      this.options.resolveVendor().ffmpegExecutable,
      { requireAudio: false }
    )
    return Boolean(media.audioCodec)
  }

  private async acquireVideo(
    record: TaskRecord,
    root: string,
    taskId: string,
    sourceMode: 'url' | 'local'
  ): Promise<{ path: string; hasAudio: boolean }> {
    if (sourceMode === 'local') {
      this.update(record, { status: 'running', stage: 'download', percent: 1, message: '正在读取本地视频' })
      const sourcePath = resolve(record.task.url)
      if (!existsSync(sourcePath)) throw this.failWithCode(record, 'VIDEO_NOT_FOUND', '选择的本地视频不存在。')
      return { path: sourcePath, hasAudio: await this.probeVideoHasAudio(sourcePath) }
    }
    this.update(record, { status: 'running', stage: 'download', percent: 1, message: '正在下载视频' })
    return this.download(record, root, taskId)
  }

  private async executeRequirementOne(record: TaskRecord, modelPaths: ModelPaths): Promise<void> {
    const { task } = record
    const root = resolve(task.outputDirectory)
    mkdirSync(root, { recursive: true })
    const sourceMode = this.resolveSourceMode(task)
    log.info('任务开始', { taskId: task.taskId, url: task.url, sourceMode, separateVocals: task.separateVocals === true })
    try {
      const { path: video, hasAudio } = await this.acquireVideo(record, root, task.taskId, sourceMode)
      if (sourceMode === 'url') {
        record.task.artifacts.video = video
        this.persist(record)
      }
      if (!hasAudio) {
        this.update(record, {
          status: 'complete',
          stage: 'complete',
          percent: 100,
          message: sourceMode === 'local'
            ? '本地视频中没有音轨，无法继续识别。'
            : '视频已下载，但影片中没有音轨，无法继续识别。'
        })
        return
      }
      this.update(record, { stage: 'extract-audio', percent: 28, message: '正在提取原音频' })
      const audio = await this.extractAudio(record, video, join(root, `${task.taskId}.wav`))
      record.task.artifacts.audio = audio
      if (!req1UsesSeparateVocals(task)) this.clearReq1VocalsArtifact(record, root)
      this.persist(record)
      const gpu = detectGpu()
      if (!gpu.available) {
        const gpuWork = req1UsesSeparateVocals(task) ? '去除背景音乐与语音识别' : '语音识别'
        throw this.failWithCode(record, 'GPU_REQUIRED', `视频和音频已保存，但当前没有可用的 NVIDIA GPU，无法执行${gpuWork}。`)
      }
      if (req1UsesSeparateVocals(task)) {
        this.update(record, { stage: 'separate-vocals', percent: 36, message: '正在去除背景音乐（加载模型 / 分离人声）' })
        const vocals = await this.separateVocals(record, audio, join(root, `${task.taskId}_人声.wav`))
        record.task.artifacts.vocals = vocals
        this.persist(record)
      } else {
        this.update(record, { stage: 'asr', percent: 32, message: '正在准备语音识别…' })
      }
      await this.performAsr(record, audio, modelPaths, req1UsesSeparateVocals(task) ? 55 : 36)
      // const target = this.options.getConfig().translationTargetLanguage
      // this.update(record, { stage: 'translation', percent: 84, message: '正在翻译文案' })
      // const sourceLines = (record.task.transcript?.segments ?? []).map((segment) => segment.text.trim()).filter(Boolean)
      // const sourceText = sourceLines.join('\n')
      // if (!sourceText) throw new Error('原文为空，无法翻译。')
      // await this.performTranslation(record, modelPaths.translation, target, sourceLines, sourceText)
      this.update(record, { status: 'complete', stage: 'complete', percent: 100, message: '原文识别完成' })
    } catch (error) {
      if (record.cancelled) return
      if (isTaskError(error)) this.fail(record, error.taskError.code, error.taskError.message)
      else this.fail(record, 'PIPELINE_FAILED', errorMessage(error))
      log.error('任务失败', { taskId: record.task.taskId, error: errorMessage(error) })
    }
  }

  private async executeVideoAudio(record: TaskRecord): Promise<void> {
    const { task } = record
    const root = resolve(task.outputDirectory)
    mkdirSync(root, { recursive: true })
    const sourceMode = this.resolveSourceMode(task)
    try {
      const { path: video, hasAudio } = await this.acquireVideo(record, root, task.taskId, sourceMode)
      if (sourceMode === 'url') {
        record.task.artifacts.video = video
        this.persist(record)
      }
      if (!hasAudio) {
        this.update(record, {
          status: 'complete',
          stage: 'complete',
          percent: 100,
          message: sourceMode === 'local'
            ? '本地视频中没有音轨，无法提取音频。'
            : '视频已下载，但影片中没有音轨，无法提取音频。'
        })
        return
      }
      this.update(record, { stage: 'extract-audio', percent: 65, message: '正在提取原音频' })
      const audio = await this.extractAudio(record, video, join(root, `${task.taskId}.wav`))
      record.task.artifacts.audio = audio
      this.persist(record)
      this.update(record, { status: 'complete', stage: 'complete', percent: 100, message: '音频提取完成' })
    } catch (error) {
      if (record.cancelled) return
      if (isTaskError(error)) this.fail(record, error.taskError.code, error.taskError.message)
      else this.fail(record, 'PIPELINE_FAILED', errorMessage(error))
      log.error('音频提取任务失败', { taskId: record.task.taskId, error: errorMessage(error) })
    }
  }

  private async executeVocalSeparation(record: TaskRecord): Promise<void> {
    const { task } = record
    const root = resolve(task.outputDirectory)
    mkdirSync(root, { recursive: true })
    const sourcePath = resolve(task.url)
    const tempAudio = join(root, `.${task.taskId}.processing.wav`)
    try {
      if (!existsSync(sourcePath)) throw this.failWithCode(record, 'AUDIO_NOT_FOUND', '选择的音频文件不存在。')
      this.update(record, { status: 'running', stage: 'download', percent: 5, message: '正在读取本地音频' })
      this.update(record, { stage: 'extract-audio', percent: 15, message: '正在转换音频' })
      const audio = await this.extractAudio(record, sourcePath, tempAudio)
      const gpu = detectGpu()
      if (!gpu.available) {
        throw this.failWithCode(record, 'GPU_REQUIRED', '当前没有可用的 NVIDIA GPU，无法执行去除背景音乐。')
      }
      this.update(record, { stage: 'separate-vocals', percent: 25, message: '正在去除背景音乐（加载模型 / 分离人声）' })
      const vocals = await this.separateVocals(record, audio, join(root, `${task.taskId}_人声.wav`), { min: 25, max: 95 })
      record.task.artifacts = { vocals }
      this.persist(record)
      this.update(record, { status: 'complete', stage: 'complete', percent: 100, message: '去除背景音乐完成' })
    } catch (error) {
      if (record.cancelled) return
      if (isTaskError(error)) this.fail(record, error.taskError.code, error.taskError.message)
      else this.fail(record, 'PIPELINE_FAILED', errorMessage(error))
      log.error('去除背景音乐任务失败', { taskId: record.task.taskId, error: errorMessage(error) })
    } finally {
      if (existsSync(tempAudio)) unlinkSync(tempAudio)
    }
  }

  private isLocalVideoPath(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase().replace(/^\./, '')
    return (LOCAL_VIDEO_EXTENSIONS as readonly string[]).includes(ext)
  }

  private async executeSpeechToText(record: TaskRecord, modelPaths: ModelPaths): Promise<void> {
    const { task } = record
    const root = resolve(task.outputDirectory)
    mkdirSync(root, { recursive: true })
    const sourcePath = resolve(task.url)
    const tempAudio = join(root, `.${task.taskId}.processing.wav`)
    try {
      const isVideo = this.isLocalVideoPath(sourcePath)
      if (!existsSync(sourcePath)) {
        throw this.failWithCode(
          record,
          isVideo ? 'VIDEO_NOT_FOUND' : 'AUDIO_NOT_FOUND',
          isVideo ? '选择的本地视频不存在。' : '选择的音频文件不存在。'
        )
      }
      this.update(record, {
        status: 'running',
        stage: 'download',
        percent: 5,
        message: isVideo ? '正在读取本地视频' : '正在读取本地音频'
      })
      this.update(record, { stage: 'extract-audio', percent: 15, message: isVideo ? '正在提取音频' : '正在转换音频' })
      const audio = await this.extractAudio(record, sourcePath, tempAudio)
      const gpu = detectGpu()
      if (!gpu.available) {
        throw this.failWithCode(record, 'GPU_REQUIRED', '当前没有可用的 NVIDIA GPU，无法执行语音识别。')
      }
      await this.performAsr(record, audio, modelPaths, 25)
      const transcriptText = record.task.artifacts.transcriptText
      record.task.artifacts = transcriptText ? { transcriptText } : {}
      this.persist(record)
      this.update(record, { status: 'complete', stage: 'complete', percent: 100, message: '语音转文字完成' })
    } catch (error) {
      if (record.cancelled) return
      if (isTaskError(error)) this.fail(record, error.taskError.code, error.taskError.message)
      else this.fail(record, 'PIPELINE_FAILED', errorMessage(error))
      log.error('语音转文字任务失败', { taskId: record.task.taskId, error: errorMessage(error) })
    } finally {
      if (existsSync(tempAudio)) unlinkSync(tempAudio)
    }
  }

  private async executeDownloadOnly(record: TaskRecord): Promise<void> {
    const root = resolve(record.task.outputDirectory)
    mkdirSync(root, { recursive: true })
    try {
      this.update(record, { status: 'running', stage: 'download', percent: 1, message: '正在解析并下载视频…' })
      const { path: video, hasAudio } = await this.download(record, root, record.task.taskId)
      record.task.artifacts.video = video
      this.persist(record)
      this.update(record, {
        status: 'complete',
        stage: 'complete',
        percent: 100,
        message: hasAudio
          ? '视频下载完成（原始媒体流未转码）'
          : '视频已下载，但影片中没有音轨。'
      })
    } catch (error) {
      if (record.cancelled) return
      this.fail(record, 'DOWNLOAD_FAILED', errorMessage(error))
      log.error('下载任务失败', { taskId: record.task.taskId, error: errorMessage(error) })
    }
  }

  private async executeRequirementTwo(record: TaskRecord, modelPaths: ModelPaths): Promise<void> {
    const { task } = record
    const root = resolve(task.outputDirectory)
    mkdirSync(root, { recursive: true })
    const sourcePath = resolve(task.url)
    const tempAudio = join(root, `.${task.taskId}.processing.wav`)
    const isVideo = this.isLocalVideoPath(sourcePath)
    try {
      if (!existsSync(sourcePath)) {
        throw this.failWithCode(
          record,
          isVideo ? 'VIDEO_NOT_FOUND' : 'AUDIO_NOT_FOUND',
          isVideo ? '选择的本地视频不存在。' : '选择的音频文件不存在。'
        )
      }
      this.update(record, {
        status: 'running',
        stage: 'extract-audio',
        percent: 8,
        message: isVideo ? '正在提取音频' : '正在转换音频'
      })
      const audio = await this.extractAudio(record, sourcePath, tempAudio)
      const gpu = detectGpu()
      if (!gpu.available) throw this.failWithCode(record, 'GPU_REQUIRED', '音频已处理，但当前没有可用的 NVIDIA GPU，无法执行语音识别。')
      const finalTranscript = await this.performPreciseSrt(
        record,
        audio,
        modelPaths
      )
      this.update(record, { stage: 'export-srt', percent: 92, message: '正在导出 SRT' })
      assertValidTranscript(finalTranscript)
      const srtPath = join(root, `${task.taskId}.srt`)
      writeFileSync(srtPath, transcriptToSrt(finalTranscript), 'utf8')
      record.task.artifacts = { srt: srtPath }
      this.persist(record)
      this.update(record, { status: 'complete', stage: 'complete', percent: 100, message: 'SRT 已生成' })
    } catch (error) {
      if (record.cancelled) return
      if (isTaskError(error)) this.fail(record, error.taskError.code, error.taskError.message)
      else this.fail(record, 'PIPELINE_FAILED', errorMessage(error))
      log.error('任务失败', { taskId: record.task.taskId, error: errorMessage(error) })
    } finally {
      if (existsSync(tempAudio)) unlinkSync(tempAudio)
    }
  }

  private async performPreciseSrt(
    record: TaskRecord,
    audio: string,
    modelPaths: ModelPaths
  ): Promise<Transcript> {
    const { task } = record
    const requestedLanguage = task.requestedLanguage ?? 'auto'
    const speechRateMode = task.speechRateMode ?? 'auto'
    const runOnce = async (model: ResolvedAsrModel, isFallback: boolean) => {
      this.update(record, {
        stage: isFallback ? 'retry-asr' : 'asr',
        percent: 35,
        message: isFallback ? asrFallbackNoticeMessage() : '正在加载精准 SRT 模型'
      })
      const response = await this.runWorker(record, 'precise_srt', {
        modelDirectory: model.directory,
        computeType: model.computeType,
        audioPath: audio,
        mode: task.mode ?? 'asr-only',
        sourceText: task.mode === 'align' ? task.sourceText : undefined,
        language: requestedLanguage,
        speechRateMode,
        ffmpegExecutable: this.options.resolveVendor().ffmpegExecutable
      }, (message) => {
        if (message.type !== 'progress') return
        const workerStages: TaskStage[] = ['asr', 'retry-asr', 'align', 'segment', 'export-srt']
        let stage = workerStages.includes(message.stage as TaskStage)
          ? message.stage as TaskStage
          : record.task.stage
        if (isFallback && stage === 'asr') stage = 'retry-asr'
        this.update(record, {
          stage,
          percent: Math.max(36, Math.min(91, message.percent ?? 36)),
          message: message.message ?? '正在生成精准 SRT'
        })
      })
      if (response.type !== 'transcript' || !response.segments) {
        throw new Error('精准 SRT 运行器没有返回最终字幕。')
      }
      return response
    }

    const response = await this.executeAsrPlan(record, modelPaths.asrPlan, 36, runOnce)

    if (response.type !== 'transcript' || !response.segments) {
      throw new Error('精准 SRT 运行器没有返回最终字幕。')
    }

    const detectedLanguage = response.language === 'zh'
      ? requestedLanguage === 'zh-Hant' ? 'zh-Hant' : 'zh-Hans'
      : response.language === 'en' || response.language === 'ja' || response.language === 'ko'
        ? response.language
        : undefined
    if (!detectedLanguage) throw new Error(`精准 SRT 返回了不支持的语言：${response.language ?? 'unknown'}`)
    record.task.detectedLanguage = detectedLanguage
    record.task.speechRateTriggered = Boolean(response.diagnostics?.speechRateTriggered)
    record.task.preciseSrtDiagnostics = {
      multirateSpanCount: optionalFiniteNumber(response.diagnostics?.multirateSpanCount),
      correctionCount: optionalFiniteNumber(response.diagnostics?.correctionCount),
      unresolvedLowConfidenceCount: optionalFiniteNumber(response.diagnostics?.unresolvedLowConfidenceCount),
      speechRateUnitsPerSecond: optionalFiniteNumber(response.diagnostics?.speechRateUnitsPerSecond),
      speechRateThreshold: optionalFiniteNumber(response.diagnostics?.speechRateThreshold),
      wallTimeS: optionalFiniteNumber(response.diagnostics?.wallTimeS)
    }
    const transcript = { language: detectedLanguage, segments: response.segments }
    this.rememberTranscript(record, transcript)
    this.persist(record)
    log.info('精准 SRT 诊断摘要', {
      taskId: task.taskId,
      requestedLanguage,
      detectedLanguage,
      speechRateMode,
      diagnostics: response.diagnostics ?? {}
    })
    return transcript
  }

  private async performAsr(record: TaskRecord, audio: string, modelPaths: ModelPaths, startPercent: number): Promise<void> {
    const config = this.options.getConfig()
    const runOnce = async (model: ResolvedAsrModel, isFallback: boolean) => {
      this.update(record, {
        stage: isFallback ? 'retry-asr' : 'asr',
        percent: startPercent,
        message: isFallback ? asrFallbackNoticeMessage() : '正在加载语音识别模型'
      })
      const response = await this.runWorker(record, 'asr', {
        modelDirectory: model.directory,
        computeType: model.computeType,
        audioPath: audio,
        language: config.asrLanguage,
        chunkLengthS: config.whisperChunkLengthS
      }, (message) => {
        if (message.type === 'progress') {
          this.update(record, {
            stage: isFallback ? 'retry-asr' : 'asr',
            percent: Math.max(startPercent + 1, Math.min(82, message.percent ?? 0)),
            message: message.message ?? '正在识别音频'
          })
        }
      })
      if (response.type !== 'transcript' || !response.segments) {
        throw new Error('ASR 运行器没有返回带时间戳的原文。')
      }
      return response
    }

    const response = await this.executeAsrPlan(record, modelPaths.asrPlan, startPercent, runOnce)

    if (response.type !== 'transcript' || !response.segments) {
      throw new Error('ASR 运行器没有返回带时间戳的原文。')
    }

    this.writeTranscript(record, { language: response.language, segments: response.segments })
  }

  private async executeAsrPlan<T>(
    record: TaskRecord,
    plan: AsrExecutionPlan,
    fallbackPercent: number,
    runAttempt: (model: ResolvedAsrModel, isFallback: boolean) => Promise<T>
  ): Promise<T> {
    try {
      const result = await runAsrExecutionPlan(plan, {
        runAttempt,
        isResourceError: isWorkerResourceError,
        isAlignmentQualityError: isWorkerAlignmentQualityError,
        onFallback: (_from, to, reason) => {
          const notice = reason === 'alignment-quality'
            ? asrAlignmentFallbackNoticeMessage()
            : asrFallbackNoticeMessage()
          this.update(record, {
            stage: 'retry-asr',
            percent: fallbackPercent,
            message: notice,
            asrExecution: {
              selectedModel: plan.selectedModel,
              effectiveModel: to.id,
              fallbackUsed: true,
              fallbackReason: reason,
              notice
            }
          })
        }
      })
      return result.value
    } catch (error) {
      if (error instanceof AsrResourceExhaustedError) {
        throw createWorkerTaskError(asrResourceErrorUserMessage(error.modelId), 'ASR_OOM')
      }
      throw error
    }
  }

  private async performTranslation(
    record: TaskRecord,
    translationModelDirectory: string,
    target: TranslationTargetLanguage,
    sourceLines: string[],
    sourceText: string
  ): Promise<void> {
    if (shouldSkipTranslation(record.task.language, target)) {
      this.writeTranslation(record, sourceText, target, sourceLines)
      return
    }
    const config = this.options.getConfig()
    const response = await this.runWorker(record, 'translate', {
      modelDirectory: translationModelDirectory,
      text: sourceText,
      lines: sourceLines,
      sourceLanguage: record.task.language ?? '',
      targetLanguage: target,
      temperature: config.translationTemperature,
      maxNewTokens: config.translationMaxNewTokens,
      topP: config.translationTopP
    }, (message) => {
      if (message.type === 'progress') this.update(record, { percent: Math.max(1, Math.min(99, message.percent ?? 0)), message: message.message ?? '正在翻译' })
      if (message.type === 'translation-line' && typeof message.lineIndex === 'number' && typeof message.text === 'string') {
        const currentLines = [...(record.task.translationLines ?? [])]
        currentLines[message.lineIndex] = message.text.trim()
        const visibleLines = currentLines.filter((line) => typeof line === 'string' && line.trim().length > 0)
        this.writeTranslation(record, visibleLines.join('\n'), target, visibleLines)
        this.update(record, {
          translation: visibleLines.join('\n'),
          translationLines: visibleLines,
          percent: Math.max(1, Math.min(99, message.percent ?? record.task.percent)),
          message: message.totalLines
            ? `正在翻译第 ${message.lineIndex + 1}/${message.totalLines} 句`
            : `正在翻译第 ${message.lineIndex + 1} 句`
        })
      }
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
  }

  private writeTranscript(record: TaskRecord, transcript: Transcript): void {
    const textPath = join(record.task.outputDirectory, `${record.task.taskId}_原文案.txt`)
    writeFileSync(textPath, transcript.segments.map((segment) => segment.text.trim()).filter(Boolean).join('\n'), 'utf8')
    this.rememberTranscript(record, transcript)
    record.task.artifacts.transcriptText = textPath
    this.persist(record)
  }

  private rememberTranscript(record: TaskRecord, transcript: Transcript): void {
    record.task.transcript = transcript
    record.task.language = transcript.language
    delete record.task.artifacts.transcript
  }

  private async download(record: TaskRecord, directory: string, fileStem: string): Promise<{ path: string; hasAudio: boolean }> {
    const config = this.options.getConfig()
    const result = await downloadVideo({
      url: record.task.url,
      directory,
      fileStem,
      vendor: this.options.resolveVendor(),
      config,
      requireAudio: false,
      isCancelled: () => record.cancelled,
      signal: record.abortController.signal,
      updateProgress: (percent, message) => this.update(record, { percent, message }),
      runCommand: (command, args, onLine, commandLabel) =>
        this.runCommand(record, command, args, onLine, commandLabel),
      downloadTikTokPublic: this.options.downloadTikTokPublic,
      resolveTikTokBrowserMedia: this.options.resolveTikTokBrowserMedia
        ? (url, proxy, signal) => this.options.resolveTikTokBrowserMedia!(url, proxy, signal)
        : undefined,
      resolveFacebookAnonymousMedia: this.options.resolveFacebookAnonymousMedia
        ? (url, proxy, signal) => this.options.resolveFacebookAnonymousMedia!(url, proxy, signal)
        : undefined,
      resolveAuthenticatedCookies: async (platform) => {
        const platformId = platformAuthIdFromUrlPlatform(platform)
        if (!platformId || !this.options.resolvePlatformAuthentication) return undefined
        return this.options.resolvePlatformAuthentication(platformId, config.ytdlpPlatformAuth[platformId])
      }
    })
    log.info('公共下载层完成', {
      taskId: record.task.taskId,
      platform: result.platform,
      strategy: result.strategy,
      videoCodec: result.media.videoCodec,
      audioCodec: result.media.audioCodec,
      width: result.media.width,
      height: result.media.height,
      hasAudio: Boolean(result.media.audioCodec)
    })
    return { path: result.path, hasAudio: Boolean(result.media.audioCodec) }
  }

  private clearReq1VocalsArtifact(record: TaskRecord, root: string): void {
    delete record.task.artifacts.vocals
    const vocalsPath = join(root, `${record.task.taskId}_人声.wav`)
    if (existsSync(vocalsPath)) unlinkSync(vocalsPath)
  }

  private async separateVocals(
    record: TaskRecord,
    audioPath: string,
    vocalsPath: string,
    progress: { min: number; max: number } = { min: 36, max: 54 }
  ): Promise<string> {
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
          percent: Math.max(progress.min, Math.min(progress.max, message.percent ?? progress.min)),
          message: message.message ?? '正在去除背景音乐'
        })
      }
    }, { TORCH_HOME: modelsDirectory })
    if (response.type !== 'separated' || !response.vocalsPath) throw new Error('去除背景音乐没有返回有效文件。')
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
        else {
          log.error('外部命令失败', { command, code, stderr: stderr.trim() })
          reject(new Error(formatCommandError(stderr, commandLabel ?? basename(command))))
        }
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
    const runtimeSrc = join(this.options.pythonProjectDirectory, 'src')
    if (existsSync(runtimeSrc)) {
      env.PYTHONPATH = env.PYTHONPATH ? `${runtimeSrc}${delimiter}${env.PYTHONPATH}` : runtimeSrc
    }
    const torchLib = join(this.options.pythonProjectDirectory, 'Lib', 'site-packages', 'torch', 'lib')
    if (existsSync(torchLib)) {
      env.PATH = env.PATH ? `${torchLib}${delimiter}${env.PATH}` : torchLib
    }
    const ffmpegBin = dirname(this.options.resolveVendor().ffmpegExecutable)
    if (existsSync(ffmpegBin)) {
      env.PATH = env.PATH ? `${ffmpegBin}${delimiter}${env.PATH}` : ffmpegBin
    }
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
    operation: 'asr' | 'precise_srt' | 'translate' | 'separate',
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
      let stdoutTail = ''
      let final: WorkerMessage | undefined
      let stderrTail = ''
      let settled = false
      let stdoutEnded = !child.stdout
      let exitCode: number | null = null
      const timeoutMs = Math.max(1, this.options.workerTimeoutMs ?? WORKER_TIMEOUT_MS[operation])
      const finishReject = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(error)
      }
      const finishResolve = (message: WorkerMessage) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolvePromise(message)
      }
      const processStdoutLine = (line: string): boolean => {
        if (!line.trim()) return false
        try {
          const message = JSON.parse(line) as WorkerMessage
          if (message.type === 'error') {
            killProcessTree(child)
            record.processes.delete(child)
            finishReject(createWorkerTaskError(message.message ?? '本地模型运行失败。', message.code))
            return true
          }
          onMessage(message)
          if (message.type === 'transcript' || message.type === 'translation' || message.type === 'separated') final = message
        } catch { /* Ignore non-protocol stdout noise. */ }
        return false
      }
      const drainStdoutBuffer = (): void => {
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (processStdoutLine(line)) return
        }
      }
      const handleWorkerExit = (): void => {
        if (!stdoutEnded || exitCode === null || settled) return
        record.processes.delete(child)
        if (record.cancelled) return finishReject(new Error('任务已取消。'))
        if (buffer.trim() && processStdoutLine(buffer.trim())) {
          buffer = ''
          return
        }
        if (exitCode !== 0) {
          const failure = parseWorkerFailure(stderrTail, stdoutTail)
          log.error(`worker 退出失败: ${operation}`, {
            code: exitCode,
            stderr: stderrTail.trim(),
            stdout: stdoutTail.trim(),
            workerCode: failure.code
          })
          return finishReject(createWorkerTaskError(failure.message, failure.code ?? 'WORKER_FAILED'))
        }
        if (!final) {
          const failure = parseWorkerFailure(stderrTail, stdoutTail)
          return finishReject(createWorkerTaskError(failure.message, failure.code ?? 'WORKER_FAILED'))
        }
        finishResolve(final)
      }
      const timeout = setTimeout(() => {
        const message = `${operation} Worker 运行超时（${Math.ceil(timeoutMs / 60_000)} 分钟），已终止进程。`
        killProcessTree(child)
        record.processes.delete(child)
        finishReject(Object.assign(new Error(message), {
          code: 'WORKER_TIMEOUT',
          taskError: { code: 'WORKER_TIMEOUT', message }
        }))
      }, timeoutMs)
      timeout.unref()
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdoutTail = appendDiagnosticTail(stdoutTail, chunk)
        buffer += chunk
        drainStdoutBuffer()
      })
      child.stdout?.on('end', () => {
        stdoutEnded = true
        handleWorkerExit()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = appendDiagnosticTail(stderrTail, chunk.toString('utf8'))
      })
      child.once('error', (error) => { record.processes.delete(child); finishReject(error) })
      child.once('close', (code) => {
        exitCode = code ?? 1
        handleWorkerExit()
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
    log.error(`任务阶段失败: ${userMessage}`, { taskId: record.task.taskId, code, message })
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
      if (task.kind === 'req1' && task.separateVocals !== true && task.artifacts.vocals) {
        delete task.artifacts.vocals
      }
      if (task.status === 'running' || task.status === 'queued') {
        task.status = 'error'; task.stage = 'error'; task.message = '应用退出导致任务中断。'; task.error = { code: 'INTERRUPTED', message: task.message }; task.updatedAt = now()
        writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf8')
      }
      this.records.set(task.taskId, this.createRecord(task, true))
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

export { createWorkerTaskError, isTranslationTargetLanguage, parseWorkerFailure }
