import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { detectGpu } from './runtime.js'
import { alignKnownText } from './align.js'
import { transcriptToSrt } from './srt.js'
import type { RequirementTwoMode, TaskArtifacts, TaskError, TaskEvent, TaskSnapshot, Transcript } from '@koubox/shared'

type TaskManagerOptions = {
  vendorDirectory: string
  projectDirectory: string
  pythonProjectDirectory: string
  bundledPythonExecutable?: string
  taskIndexFile: string
}

type TaskRecord = {
  task: TaskSnapshot
  listeners: Set<(event: TaskEvent) => void>
  processes: Set<ChildProcess>
  cancelled: boolean
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
}

function now(): string { return new Date().toISOString() }

function taskId(kind: 'req1' | 'req2'): string {
  return `${kind}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function killProcessTree(child: ChildProcess): void {
  if (!child.pid || child.killed) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
  else child.kill('SIGTERM')
}

export class TaskManager {
  private readonly records = new Map<string, TaskRecord>()

  constructor(private readonly options: TaskManagerOptions) {}

  restore(outputDirectory: string): void {
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

  startRequirementOne(url: string, outputDirectory: string, modelsDirectory: string): TaskSnapshot {
    const id = taskId('req1')
    const taskDirectory = join(resolve(outputDirectory), id)
    const task: TaskSnapshot = {
      taskId: id,
      kind: 'req1',
      status: 'queued',
      stage: 'queued',
      percent: 0,
      message: '任务已排队',
      url,
      outputDirectory: resolve(outputDirectory),
      taskDirectory,
      artifacts: {},
      createdAt: now(),
      updatedAt: now()
    }
    const record: TaskRecord = { task, listeners: new Set(), processes: new Set(), cancelled: false }
    this.records.set(id, record)
    this.persist(record)
    void this.executeRequirementOne(record, modelsDirectory)
    return this.clone(task)
  }

  startRequirementTwo(audioPath: string, sourceText: string, outputDirectory: string, modelsDirectory: string): TaskSnapshot {
    const id = taskId('req2')
    const mode: RequirementTwoMode = sourceText.trim() ? 'align' : 'asr-only'
    const taskDirectory = join(resolve(outputDirectory), id)
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
      outputDirectory: resolve(outputDirectory),
      taskDirectory,
      artifacts: {},
      createdAt: now(),
      updatedAt: now()
    }
    const record: TaskRecord = { task, listeners: new Set(), processes: new Set(), cancelled: false }
    this.records.set(id, record)
    this.persist(record)
    void this.executeRequirementTwo(record, modelsDirectory)
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
    for (const child of record.processes) killProcessTree(child)
    this.update(record, { status: 'cancelled', stage: 'cancelled', message: '任务已取消' })
    return this.clone(record.task)
  }

  async translate(taskIdValue: string, modelsDirectory: string): Promise<TaskSnapshot> {
    const record = this.records.get(taskIdValue)
    if (!record) throw new Error('任务不存在。')
    if (!record.task.transcript) throw new Error('ASR 尚未完成，暂时没有可翻译的原文。')
    if (record.task.status === 'cancelled') throw new Error('任务已取消。')
    if (record.task.status === 'running') throw new Error('任务仍在处理，不能开始翻译。')
    if (record.task.taskDirectory === '') throw new Error('任务目录无效。')

    const sourceText = record.task.transcript.segments.map((segment) => segment.text.trim()).filter(Boolean).join('\n')
    if (!sourceText) throw new Error('原文为空，无法翻译。')
    const gpu = detectGpu()
    if (!gpu.available) throw this.failWithCode(record, 'GPU_REQUIRED', '当前没有可用的 NVIDIA GPU，无法执行翻译。')

    if (record.task.language?.toLowerCase().startsWith('zh')) {
      this.writeTranslation(record, sourceText)
      this.update(record, { status: 'complete', stage: 'complete', percent: 100, message: '原文已是中文，无需翻译。' })
      return this.clone(record.task)
    }

    this.update(record, { status: 'running', stage: 'translation', percent: 0, message: '正在加载本地翻译模型' })
    try {
      const response = await this.runWorker(record, 'translate', {
        modelDirectory: join(modelsDirectory, 'HYMT21.8B'),
        text: sourceText
      }, (message) => {
        if (message.type === 'progress') this.update(record, { percent: Math.max(1, Math.min(99, message.percent ?? 0)), message: message.message ?? '正在翻译' })
      })
      if (response.type !== 'translation' || !response.text) throw new Error('翻译运行器没有返回译文。')
      this.writeTranslation(record, response.text)
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
      const target = join(destination, basename(source))
      copyFileSync(source, target)
      copied[key] = target
    }
    return copied
  }

  private async executeRequirementOne(record: TaskRecord, modelsDirectory: string): Promise<void> {
    const { task } = record
    const sourceDirectory = join(task.taskDirectory, 'source')
    const mediaDirectory = join(task.taskDirectory, 'media')
    const textDirectory = join(task.taskDirectory, 'text')
    mkdirSync(sourceDirectory, { recursive: true }); mkdirSync(mediaDirectory, { recursive: true }); mkdirSync(textDirectory, { recursive: true })
    try {
      this.update(record, { status: 'running', stage: 'download', percent: 1, message: '正在下载视频' })
      const video = await this.download(record, sourceDirectory)
      record.task.artifacts.video = video
      this.persist(record)
      this.update(record, { stage: 'extract-audio', percent: 30, message: '正在提取音频' })
      const audio = await this.extractAudio(record, video, mediaDirectory)
      record.task.artifacts.audio = audio
      this.persist(record)
      const gpu = detectGpu()
      if (!gpu.available) throw this.failWithCode(record, 'GPU_REQUIRED', '视频和音频已保存，但当前没有可用的 NVIDIA GPU，无法执行语音识别。')
      await this.performAsr(record, audio, modelsDirectory, textDirectory, 42)
      this.update(record, { status: 'complete', stage: 'complete', percent: 100, message: '原文识别完成' })
    } catch (error) {
      if (record.cancelled) return
      if (isTaskError(error)) this.fail(record, error.taskError.code, error.taskError.message)
      else this.fail(record, 'PIPELINE_FAILED', errorMessage(error))
    }
  }

  private async executeRequirementTwo(record: TaskRecord, modelsDirectory: string): Promise<void> {
    const { task } = record
    const sourceDirectory = join(task.taskDirectory, 'source')
    const mediaDirectory = join(task.taskDirectory, 'media')
    const textDirectory = join(task.taskDirectory, 'text')
    mkdirSync(sourceDirectory, { recursive: true }); mkdirSync(mediaDirectory, { recursive: true }); mkdirSync(textDirectory, { recursive: true })
    try {
      if (!existsSync(task.url)) throw this.failWithCode(record, 'AUDIO_NOT_FOUND', '选择的音频文件不存在。')
      const sourceAudio = join(sourceDirectory, `input${extname(task.url).toLowerCase() || '.audio'}`)
      copyFileSync(task.url, sourceAudio)
      record.task.artifacts.sourceAudio = sourceAudio
      this.update(record, { status: 'running', stage: 'extract-audio', percent: 8, message: '正在转换音频' })
      const audio = await this.extractAudio(record, sourceAudio, mediaDirectory)
      record.task.artifacts.audio = audio
      this.persist(record)
      const gpu = detectGpu()
      if (!gpu.available) throw this.failWithCode(record, 'GPU_REQUIRED', '音频已保存，但当前没有可用的 NVIDIA GPU，无法执行语音识别。')
      await this.performAsr(record, audio, modelsDirectory, textDirectory, 35)
      let finalTranscript = record.task.transcript
      if (!finalTranscript) throw new Error('ASR 未返回有效字幕。')
      if (task.mode === 'align' && task.sourceText) {
        this.update(record, { stage: 'align', percent: 84, message: '正在按原文整理时间轴' })
        finalTranscript = alignKnownText(task.sourceText, finalTranscript)
        this.writeTranscript(record, finalTranscript, textDirectory)
      }
      this.update(record, { stage: 'export-srt', percent: 92, message: '正在导出 SRT' })
      const srtPath = join(textDirectory, 'subtitles.srt')
      writeFileSync(srtPath, transcriptToSrt(finalTranscript), 'utf8')
      record.task.artifacts.srt = srtPath
      this.persist(record)
      this.update(record, { status: 'complete', stage: 'complete', percent: 100, message: 'SRT 已生成' })
    } catch (error) {
      if (record.cancelled) return
      if (isTaskError(error)) this.fail(record, error.taskError.code, error.taskError.message)
      else this.fail(record, 'PIPELINE_FAILED', errorMessage(error))
    }
  }

  private async performAsr(record: TaskRecord, audio: string, modelsDirectory: string, textDirectory: string, startPercent: number): Promise<void> {
    this.update(record, { stage: 'asr', percent: startPercent, message: '正在加载语音识别模型' })
    const response = await this.runWorker(record, 'asr', {
      modelDirectory: join(modelsDirectory, 'whisperlargev3turbo'),
      audioPath: audio
    }, (message) => {
      if (message.type === 'progress') this.update(record, { percent: Math.max(startPercent + 1, Math.min(82, message.percent ?? 0)), message: message.message ?? '正在识别音频' })
    })
    if (response.type !== 'transcript' || !response.segments) throw new Error('ASR 运行器没有返回带时间戳的原文。')
    this.writeTranscript(record, { language: response.language, segments: response.segments }, textDirectory)
  }

  private writeTranscript(record: TaskRecord, transcript: Transcript, textDirectory: string): void {
    const transcriptPath = join(textDirectory, 'transcript.json')
    const transcriptTextPath = join(textDirectory, 'transcript.txt')
    writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2), 'utf8')
    writeFileSync(transcriptTextPath, transcript.segments.map((segment) => segment.text.trim()).filter(Boolean).join('\n'), 'utf8')
    record.task.transcript = transcript
    record.task.language = transcript.language
    record.task.artifacts.transcript = transcriptPath
    record.task.artifacts.transcriptText = transcriptTextPath
    this.persist(record)
  }

  private async download(record: TaskRecord, directory: string): Promise<string> {
    const executable = join(this.options.vendorDirectory, 'yt-dlp', 'yt-dlp.exe')
    if (!existsSync(executable)) throw new Error('项目内置 yt-dlp 不存在。')
    await this.runCommand(record, executable, ['--newline', '--no-playlist', '--no-warnings', '-o', join(directory, 'video.%(ext)s'), record.task.url], (line) => {
      const percent = line.match(/(\d+(?:\.\d+)?)%/)
      if (percent) this.update(record, { percent: Math.min(28, Math.max(1, Number(percent[1]) * 0.28)), message: `正在下载视频 ${percent[1]}%` })
    })
    const file = readdirSync(directory).find((name) => !name.endsWith('.part') && !name.endsWith('.ytdl') && name.startsWith('video.'))
    if (!file) throw new Error('yt-dlp 已结束，但没有找到下载的视频文件。')
    return join(directory, file)
  }

  private async extractAudio(record: TaskRecord, video: string, directory: string): Promise<string> {
    const executable = join(this.options.vendorDirectory, 'ffmpeg', 'bin', 'ffmpeg.exe')
    if (!existsSync(executable)) throw new Error('项目内置 FFmpeg 不存在。')
    const audio = join(directory, 'audio.wav')
    await this.runCommand(record, executable, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio])
    if (!existsSync(audio)) throw new Error('FFmpeg 已结束，但没有找到抽取的音频文件。')
    return audio
  }

  private runCommand(record: TaskRecord, command: string, args: string[], onLine?: (line: string) => void): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, { cwd: this.options.projectDirectory, windowsHide: true })
      record.processes.add(child)
      let stderr = ''
      const consume = (chunk: Buffer) => { const text = chunk.toString('utf8'); stderr += text; for (const line of text.split(/\r?\n/)) onLine?.(line) }
      child.stdout?.on('data', consume); child.stderr?.on('data', consume)
      child.once('error', (error) => { record.processes.delete(child); reject(error) })
      child.once('close', (code) => {
        record.processes.delete(child)
        if (record.cancelled) return reject(new Error('任务已取消。'))
        if (code === 0) resolvePromise()
        else reject(new Error(stderr.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? `${basename(command)} 执行失败。`))
      })
    })
  }

  private runWorker(record: TaskRecord, operation: 'asr' | 'translate', payload: Record<string, unknown>, onMessage: (message: WorkerMessage) => void): Promise<WorkerMessage> {
    const python = this.options.bundledPythonExecutable && existsSync(this.options.bundledPythonExecutable)
      ? { command: this.options.bundledPythonExecutable, prefix: ['-m', 'koubox_runtime'] }
      : { command: 'uv', prefix: ['run', '--project', this.options.pythonProjectDirectory, 'python', '-m', 'koubox_runtime'] }
    const child = spawn(python.command, [...python.prefix], { cwd: this.options.projectDirectory, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } })
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
            if (message.type === 'transcript' || message.type === 'translation') final = message
          } catch { /* Ignore non-protocol stdout noise. */ }
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      child.once('error', (error) => { record.processes.delete(child); reject(error) })
      child.once('close', (code) => {
        record.processes.delete(child)
        if (record.cancelled) return reject(new Error('任务已取消。'))
        if (code !== 0) return reject(new Error(stderr.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '本地模型运行器退出失败。'))
        if (!final) return reject(new Error('本地模型运行器没有返回结果。'))
        resolvePromise(final)
      })
      child.stdin?.write(`${JSON.stringify({ operation, ...payload })}\n`)
      child.stdin?.end()
    })
  }

  private writeTranslation(record: TaskRecord, text: string): void {
    const textDirectory = join(record.task.taskDirectory, 'text')
    mkdirSync(textDirectory, { recursive: true })
    const jsonPath = join(textDirectory, 'translation.json')
    const textPath = join(textDirectory, 'translation.txt')
    writeFileSync(jsonPath, JSON.stringify({ language: 'zh', text }, null, 2), 'utf8')
    writeFileSync(textPath, text, 'utf8')
    record.task.translation = text
    record.task.artifacts.translation = jsonPath
    record.task.artifacts.translationText = textPath
    this.persist(record)
  }

  private failWithCode(record: TaskRecord, code: string, message: string): Error & { taskError: TaskError } {
    const error = Object.assign(new Error(message), { taskError: { code, message } })
    return error
  }

  private fail(record: TaskRecord, code: string, message: string): void { this.update(record, { status: 'error', stage: 'error', message, error: { code, message } }) }

  private update(record: TaskRecord, patch: Partial<TaskSnapshot>): void {
    Object.assign(record.task, patch, { updatedAt: now() }); this.persist(record)
    const event: TaskEvent = { type: 'snapshot', task: this.clone(record.task) }
    for (const listener of record.listeners) listener(event)
  }

  private restoreTask(taskFile: string): void {
    try {
      const task = JSON.parse(readFileSync(taskFile, 'utf8')) as TaskSnapshot
      if (!task.taskId || !task.taskDirectory) return
      task.kind ??= task.taskId.startsWith('req2-') ? 'req2' : 'req1'
      if (task.status === 'running' || task.status === 'queued') {
        task.status = 'error'; task.stage = 'error'; task.message = '应用退出导致任务中断。'; task.error = { code: 'INTERRUPTED', message: task.message }; task.updatedAt = now()
        writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf8')
      }
      this.records.set(task.taskId, { task, listeners: new Set(), processes: new Set(), cancelled: false })
    } catch { /* Ignore malformed task records. */ }
  }

  private persist(record: TaskRecord): void {
    mkdirSync(record.task.taskDirectory, { recursive: true })
    writeFileSync(join(record.task.taskDirectory, 'task.json'), JSON.stringify(record.task, null, 2), 'utf8')
    mkdirSync(dirname(this.options.taskIndexFile), { recursive: true })
    const files = [...this.records.values()].map((item) => join(item.task.taskDirectory, 'task.json'))
    writeFileSync(this.options.taskIndexFile, JSON.stringify(files, null, 2), 'utf8')
  }
  private clone(task: TaskSnapshot): TaskSnapshot { return JSON.parse(JSON.stringify(task)) as TaskSnapshot }
}

function isTaskError(error: unknown): error is { taskError: TaskError } { return Boolean(error && typeof error === 'object' && 'taskError' in error) }
