import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AsrLanguage, KouboxConfig, TranslationTargetLanguage, YtdlpCookieSource, YtdlpMaxHeight } from '@koubox/shared'
import { tools } from '@koubox/shared'
import { createLogger } from '@koubox/shared/logger'
import { RuntimeStore, getRuntimeStatus, resolveModelPaths, resolveVendorPaths } from './runtime.js'
import { isTranslationTargetLanguage, TaskManager } from './tasks.js'

type FileFilter = { name: string; extensions: string[] }

type ServerOptions = {
  configFile: string
  defaults: KouboxConfig
  projectDirectory: string
  pythonProjectDirectory: string
  bundledPythonExecutable?: string
  selectDirectory(title: string, defaultPath?: string): Promise<string | undefined>
  selectAudioFile(title: string, defaultPath?: string): Promise<string | undefined>
  selectFile(title: string, defaultPath?: string, filters?: FileFilter[]): Promise<string | undefined>
  openPath(targetPath: string): Promise<void>
  openLoginWindow(): Promise<void>
  exportLoginCookies(): Promise<import('@koubox/shared').YtdlpCookieStatus>
  getLoginCookieStatus(instagramCookies: string, proxy: string): Promise<import('@koubox/shared').YtdlpCookieStatus>
  exportedCookiesFile: string
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  })
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = ''
  for await (const chunk of request) text += chunk
  return text ? JSON.parse(text) as Record<string, unknown> : {}
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asAsrLanguage(value: unknown, fallback: AsrLanguage): AsrLanguage {
  if (value === 'auto' || isTranslationTargetLanguage(value)) return value
  return fallback
}

function asTranslationTargetLanguage(value: unknown, fallback: TranslationTargetLanguage): TranslationTargetLanguage {
  return isTranslationTargetLanguage(value) ? value : fallback
}

function asYtdlpMaxHeight(value: unknown, fallback: YtdlpMaxHeight): YtdlpMaxHeight {
  if (value === 0 || value === 1080 || value === 720 || value === 480) return value
  return fallback
}

function asYtdlpCookieSource(value: unknown, fallback: YtdlpCookieSource): YtdlpCookieSource {
  if (value === 'builtin' || value === 'none' || value === 'file') return value
  if (value === 'chrome' || value === 'edge') return 'builtin'
  return fallback
}

function mergeConfig(body: Record<string, unknown>, config: KouboxConfig): KouboxConfig {
  const ytdlpCookieSource = asYtdlpCookieSource(body.ytdlpCookieSource, config.ytdlpCookieSource)
  return {
    modelsDirectory: asString(body.modelsDirectory, config.modelsDirectory),
    outputDirectory: asString(body.outputDirectory, config.outputDirectory),
    asrModelDirectory: asString(body.asrModelDirectory, config.asrModelDirectory),
    translationModelDirectory: asString(body.translationModelDirectory, config.translationModelDirectory),
    demucsModelDirectory: asString(body.demucsModelDirectory, config.demucsModelDirectory),
    ytdlpDirectory: asString(body.ytdlpDirectory, config.ytdlpDirectory),
    ffmpegDirectory: asString(body.ffmpegDirectory, config.ffmpegDirectory),
    translationTargetLanguage: asTranslationTargetLanguage(body.translationTargetLanguage, config.translationTargetLanguage),
    asrLanguage: asAsrLanguage(body.asrLanguage, config.asrLanguage),
    openOutputOnComplete: asBoolean(body.openOutputOnComplete, config.openOutputOnComplete),
    ytdlpProxy: asString(body.ytdlpProxy, config.ytdlpProxy),
    ytdlpCookieSource,
    ytdlpCookiesPath: ytdlpCookieSource === 'file'
      ? asString(body.ytdlpCookiesPath, config.ytdlpCookiesPath)
      : '',
    ytdlpInstagramCookies: asString(body.ytdlpInstagramCookies, config.ytdlpInstagramCookies),
    ytdlpMaxHeight: asYtdlpMaxHeight(body.ytdlpMaxHeight, config.ytdlpMaxHeight),
    ytdlpExtraArgs: asString(body.ytdlpExtraArgs, config.ytdlpExtraArgs),
    maxConcurrentTasks: Math.max(1, Math.floor(asNumber(body.maxConcurrentTasks, config.maxConcurrentTasks))),
    translationTemperature: asNumber(body.translationTemperature, config.translationTemperature),
    translationMaxNewTokens: Math.max(1, Math.floor(asNumber(body.translationMaxNewTokens, config.translationMaxNewTokens))),
    translationTopP: asNumber(body.translationTopP, config.translationTopP),
    whisperChunkLengthS: Math.max(1, Math.floor(asNumber(body.whisperChunkLengthS, config.whisperChunkLengthS))),
    pythonExecutable: asString(body.pythonExecutable, config.pythonExecutable),
    debugMode: asBoolean(body.debugMode, config.debugMode)
  }
}

export async function startLocalApi(options: ServerOptions) {
  const apiLog = createLogger('api')
  const store = new RuntimeStore(options.configFile, options.defaults)
  const tasks = new TaskManager({
    getConfig: () => store.read(),
    resolveVendor: () => resolveVendorPaths(store.read()),
    projectDirectory: options.projectDirectory,
    pythonProjectDirectory: options.pythonProjectDirectory,
    bundledPythonExecutable: options.bundledPythonExecutable,
    taskIndexFile: join(dirname(options.configFile), 'tasks.json')
  })
  tasks.restore(store.read().outputDirectory)
  const token = randomBytes(24).toString('hex')
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const method = request.method ?? 'GET'
      apiLog.debug(`${method} ${url.pathname}`)
      if (method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
        })
        return response.end()
      }
      if (request.headers.authorization !== `Bearer ${token}` && url.searchParams.get('token') !== token) {
        return json(response, 401, { error: 'Unauthorized local request' })
      }
      const config = store.read()

      if (method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true })
      if (method === 'GET' && url.pathname === '/media') {
        const filePath = url.searchParams.get('path')
        if (!filePath || !existsSync(filePath)) return json(response, 404, { error: '文件不存在。' })
        const stat = statSync(filePath)
        if (!stat.isFile()) return json(response, 400, { error: '路径不是文件。' })
        const ext = filePath.toLowerCase()
        const type = ext.endsWith('.webm')
          ? 'video/webm'
          : ext.endsWith('.mkv')
            ? 'video/x-matroska'
            : ext.endsWith('.mp4') || ext.endsWith('.m4v')
              ? 'video/mp4'
              : ext.endsWith('.wav')
                ? 'audio/wav'
                : ext.endsWith('.mp3')
                  ? 'audio/mpeg'
                  : 'application/octet-stream'
        const size = stat.size
        const range = request.headers.range
        const commonHeaders = {
          'Accept-Ranges': 'bytes',
          'Content-Type': type,
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*'
        }
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range)
          if (!match) return json(response, 416, { error: '无效的 Range。' })
          const start = match[1] ? Number(match[1]) : 0
          const end = match[2] ? Number(match[2]) : size - 1
          if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
            response.writeHead(416, { ...commonHeaders, 'Content-Range': `bytes */${size}` })
            return response.end()
          }
          const chunkEnd = Math.min(end, size - 1)
          response.writeHead(206, {
            ...commonHeaders,
            'Content-Range': `bytes ${start}-${chunkEnd}/${size}`,
            'Content-Length': chunkEnd - start + 1
          })
          createReadStream(filePath, { start, end: chunkEnd }).pipe(response)
          return
        }
        response.writeHead(200, {
          ...commonHeaders,
          'Content-Length': size
        })
        createReadStream(filePath).pipe(response)
        return
      }
      if (method === 'GET' && url.pathname === '/tools') return json(response, 200, tools)
      if (method === 'GET' && url.pathname === '/tasks') return json(response, 200, tasks.list())
      if (method === 'GET' && url.pathname === '/runtime/status') return json(response, 200, getRuntimeStatus(config))
      if (method === 'GET' && url.pathname === '/config') return json(response, 200, config)
      if (method === 'PUT' && url.pathname === '/config') {
        const body = await readJson(request)
        const next = mergeConfig(body, config)
        mkdirSync(next.outputDirectory, { recursive: true })
        return json(response, 200, store.write(next))
      }
      if (method === 'POST' && url.pathname === '/runtime/refresh') return json(response, 200, getRuntimeStatus(config))
      if (method === 'POST' && url.pathname === '/dialog/select-directory') {
        const body = await readJson(request)
        const title = typeof body.title === 'string' ? body.title : '选择文件夹'
        const defaultPath = typeof body.defaultPath === 'string' ? body.defaultPath : undefined
        return json(response, 200, { path: await options.selectDirectory(title, defaultPath) ?? null })
      }
      if (method === 'POST' && url.pathname === '/dialog/select-audio') {
        const body = await readJson(request)
        const title = typeof body.title === 'string' ? body.title : '选择音频文件'
        const defaultPath = typeof body.defaultPath === 'string' ? body.defaultPath : undefined
        return json(response, 200, { path: await options.selectAudioFile(title, defaultPath) ?? null })
      }
      if (method === 'POST' && url.pathname === '/dialog/select-file') {
        const body = await readJson(request)
        const title = typeof body.title === 'string' ? body.title : '选择文件'
        const defaultPath = typeof body.defaultPath === 'string' ? body.defaultPath : undefined
        const filters = Array.isArray(body.filters)
          ? body.filters.filter((item): item is FileFilter =>
            Boolean(item) &&
            typeof item === 'object' &&
            typeof (item as FileFilter).name === 'string' &&
            Array.isArray((item as FileFilter).extensions)
          )
          : undefined
        return json(response, 200, { path: await options.selectFile(title, defaultPath, filters) ?? null })
      }
      if (method === 'POST' && url.pathname === '/dialog/open-path') {
        const body = await readJson(request)
        if (typeof body.path !== 'string' || !body.path.trim()) return json(response, 400, { error: '请提供要打开的路径。' })
        await options.openPath(body.path.trim())
        return json(response, 200, { ok: true })
      }
      if (method === 'POST' && url.pathname === '/browser/open-login') {
        try {
          await options.openLoginWindow()
        } catch (error) {
          return json(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return json(response, 200, { ok: true })
      }
      if (method === 'POST' && url.pathname === '/browser/export-cookies') {
        try {
          return json(response, 200, await options.exportLoginCookies())
        } catch (error) {
          return json(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (method === 'GET' && url.pathname === '/browser/cookie-status') {
        return json(response, 200, await options.getLoginCookieStatus(config.ytdlpInstagramCookies, config.ytdlpProxy))
      }
      const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)(?:\/(events|translate|cancel|export))?$/)
      if (taskMatch) {
        const taskId = decodeURIComponent(taskMatch[1])
        const action = taskMatch[2]
        const task = tasks.get(taskId)
        if (!task) return json(response, 404, { error: '任务不存在。' })
        if (method === 'GET' && action === 'events') {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          })
          const unsubscribe = tasks.subscribe(taskId, (event) => {
            try {
              response.write(`data: ${JSON.stringify(event)}\n\n`)
            } catch {
              unsubscribe()
            }
          })
          request.on('close', unsubscribe)
          return
        }
        if (method === 'GET' && !action) return json(response, 200, task)
        if (method === 'DELETE' && !action) {
          try {
            tasks.remove(taskId)
            return json(response, 200, { ok: true })
          } catch (error) {
            return json(response, 409, { error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (method === 'POST' && action === 'cancel') return json(response, 200, tasks.cancel(taskId))
        if (method === 'POST' && action === 'translate') {
          const body = await readJson(request)
          const targetLanguage = isTranslationTargetLanguage(body.targetLanguage) ? body.targetLanguage : undefined
          try { return json(response, 200, await tasks.translate(taskId, resolveModelPaths(store.read()), targetLanguage)) }
          catch (error) { return json(response, 409, { error: error instanceof Error ? error.message : String(error) }) }
        }
        if (method === 'POST' && action === 'export') {
          const body = await readJson(request)
          if (typeof body.targetDirectory !== 'string' || !body.targetDirectory.trim()) return json(response, 400, { error: '请提供另存目录。' })
          return json(response, 200, { artifacts: tasks.export(taskId, body.targetDirectory) })
        }
      }
      if (method === 'POST' && url.pathname === '/pipelines/req1') {
        const body = await readJson(request)
        const urlValue = typeof body.url === 'string' ? body.url.trim() : ''
        if (!/^https?:\/\//i.test(urlValue)) return json(response, 400, { error: '请输入有效的视频链接。' })
        const outputDirectory = typeof body.outputDirectory === 'string' && body.outputDirectory.trim() ? body.outputDirectory : store.read().outputDirectory
        mkdirSync(outputDirectory, { recursive: true })
        return json(response, 202, tasks.startRequirementOne(urlValue, outputDirectory, resolveModelPaths(store.read())))
      }
      if (method === 'POST' && url.pathname === '/pipelines/req2') {
        const body = await readJson(request)
        const audioPath = typeof body.audioPath === 'string' ? body.audioPath.trim() : ''
        if (!audioPath) return json(response, 400, { error: '请选择本地音频文件。' })
        const sourceText = typeof body.sourceText === 'string' ? body.sourceText : ''
        const outputDirectory = typeof body.outputDirectory === 'string' && body.outputDirectory.trim() ? body.outputDirectory : store.read().outputDirectory
        mkdirSync(outputDirectory, { recursive: true })
        return json(response, 202, tasks.startRequirementTwo(audioPath, sourceText, outputDirectory, resolveModelPaths(store.read())))
      }
      return json(response, 404, { error: 'Not found' })
    } catch (error) {
      return json(response, 400, { error: 'Bad request', detail: error instanceof Error ? error.message : String(error) })
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    getConfig: () => store.read(),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}
