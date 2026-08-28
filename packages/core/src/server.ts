import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AsrLanguage, KouboxConfig, PlatformAuthConfig, PlatformAuthEntry, TranslationTargetLanguage, YtdlpCookiePlatformId, YtdlpMaxHeight, YtdlpUpdateStatus } from '@koubox/shared'
import { assertDownloadableVideoUrl, assertLocalVideoPath, defaultPlatformAuth, normalizeOsPath, tools } from '@koubox/shared'
import { createLogger } from '@koubox/shared/logger'
import { RuntimeStore, getRuntimeStatus, resolveModelPaths, resolveVendorPaths } from './runtime.js'
import type { ActiveYtdlpRuntime } from './ytdlp-update.js'
import { isTranslationTargetLanguage, TaskManager } from './tasks.js'

type FileFilter = { name: string; extensions: string[] }

type ServerOptions = {
  configFile: string
  defaults: KouboxConfig
  projectDirectory: string
  pythonProjectDirectory: string
  bundledPythonExecutable?: string
  downloadTikTokPublic?(url: string, directory: string, fileStem: string, onLine?: (line: string) => void): Promise<string>
  pinBundledPaths?: boolean
  selectDirectory(title: string, defaultPath?: string): Promise<string | undefined>
  selectAudioFile(title: string, defaultPath?: string): Promise<string | undefined>
  selectFile(title: string, defaultPath?: string, filters?: FileFilter[]): Promise<string | undefined>
  openPath(targetPath: string): Promise<void>
  openLoginWindow(platformId: YtdlpCookiePlatformId): Promise<void>
  getLoginCookieStatus(platformAuth: PlatformAuthConfig, proxy: string, platformId?: YtdlpCookiePlatformId): Promise<import('@koubox/shared').YtdlpCookieStatus>
  resolveTikTokBrowserMedia?(url: string, proxy: string): Promise<import('./public-video.js').PublicMediaResolution>
  resolveFacebookAnonymousMedia?(url: string, proxy: string): Promise<import('./public-video.js').PublicMediaResolution>
  resolvePlatformAuthentication?(platformId: YtdlpCookiePlatformId, auth: PlatformAuthEntry): Promise<import('./video-download.js').AuthenticatedCookieFile>
  resolveActiveYtdlp(): ActiveYtdlpRuntime
  checkYtdlpUpdate(): Promise<YtdlpUpdateStatus>
  installYtdlpUpdate(version: string): Promise<YtdlpUpdateStatus>
  restoreBundledYtdlp(): Promise<YtdlpUpdateStatus>
  getAppDataRoots?(): Promise<{ mode: 'development' | 'packaged'; userData: string; logs: string }>
  clearAppCache?(): Promise<{
    cancelled: boolean
    cleared: string[]
    failed: Array<{ path: string; error: string }>
    roots: { mode: 'development' | 'packaged'; userData: string; logs: string }
    config?: KouboxConfig
  }>
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

function asPathString(value: unknown, fallback: string): string {
  return normalizeOsPath(asString(value, fallback))
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

function asPlatformAuth(value: unknown, fallback: PlatformAuthConfig): PlatformAuthConfig {
  const next = defaultPlatformAuth()
  const ids = ['youtube', 'tiktok', 'instagram', 'facebook'] as const
  for (const id of ids) {
    next[id] = {
      mode: fallback[id]?.mode ?? next[id].mode,
      cookies: typeof fallback[id]?.cookies === 'string' ? fallback[id].cookies : ''
    }
  }
  if (!value || typeof value !== 'object') return next
  const record = value as Record<string, { mode?: unknown; cookies?: unknown }>
  for (const id of ids) {
    const entry = record[id]
    if (!entry || typeof entry !== 'object') continue
    next[id] = {
      mode: entry.mode === 'paste' || entry.mode === 'builtin' ? entry.mode : next[id].mode,
      cookies: typeof entry.cookies === 'string' ? entry.cookies : next[id].cookies
    }
  }
  return next
}

function summarizeRequestBody(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const stringLengths: Record<string, number> = {}
  const arrayLengths: Record<string, number> = {}
  const objectKeyCounts: Record<string, number> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') stringLengths[key] = value.length
    else if (Array.isArray(value)) arrayLengths[key] = value.length
    else if (value && typeof value === 'object') objectKeyCounts[key] = Object.keys(value).length
  }
  return { keys: Object.keys(record), stringLengths, arrayLengths, objectKeyCounts }
}

function safeRequestUrl(requestUrl: string | undefined): string | undefined {
  if (!requestUrl) return requestUrl
  try {
    const url = new URL(requestUrl, 'http://127.0.0.1')
    url.searchParams.delete('token')
    return `${url.pathname}${url.search}`
  } catch {
    return requestUrl.split('?')[0]
  }
}

function readVideoPipelineInput(body: Record<string, unknown>, defaultOutputDirectory: string): {
  url: string
  outputDirectory: string
} {
  const checked = assertDownloadableVideoUrl(typeof body.url === 'string' ? body.url : '')
  const outputDirectory = typeof body.outputDirectory === 'string' && body.outputDirectory.trim()
    ? normalizeOsPath(body.outputDirectory.trim())
    : normalizeOsPath(defaultOutputDirectory)
  return { url: checked.url, outputDirectory }
}

function mergeConfig(body: Record<string, unknown>, config: KouboxConfig): KouboxConfig {
  return {
    modelsDirectory: asPathString(body.modelsDirectory, config.modelsDirectory),
    outputDirectory: asPathString(body.outputDirectory, config.outputDirectory),
    asrModelDirectory: asPathString(body.asrModelDirectory, config.asrModelDirectory),
    translationModelDirectory: asPathString(body.translationModelDirectory, config.translationModelDirectory),
    demucsModelDirectory: asPathString(body.demucsModelDirectory, config.demucsModelDirectory),
    ytdlpDirectory: asPathString(body.ytdlpDirectory, config.ytdlpDirectory),
    ffmpegDirectory: asPathString(body.ffmpegDirectory, config.ffmpegDirectory),
    denoDirectory: asPathString(body.denoDirectory, config.denoDirectory),
    translationTargetLanguage: asTranslationTargetLanguage(body.translationTargetLanguage, config.translationTargetLanguage),
    asrLanguage: asAsrLanguage(body.asrLanguage, config.asrLanguage),
    openOutputOnComplete: asBoolean(body.openOutputOnComplete, config.openOutputOnComplete),
    ytdlpProxy: asString(body.ytdlpProxy, config.ytdlpProxy),
    ytdlpPlatformAuth: asPlatformAuth(body.ytdlpPlatformAuth, config.ytdlpPlatformAuth),
    ytdlpMaxHeight: asYtdlpMaxHeight(body.ytdlpMaxHeight, config.ytdlpMaxHeight),
    ytdlpExtraArgs: asString(body.ytdlpExtraArgs, config.ytdlpExtraArgs),
    maxConcurrentTasks: Math.max(1, Math.floor(asNumber(body.maxConcurrentTasks, config.maxConcurrentTasks))),
    translationTemperature: asNumber(body.translationTemperature, config.translationTemperature),
    translationMaxNewTokens: Math.max(1, Math.floor(asNumber(body.translationMaxNewTokens, config.translationMaxNewTokens))),
    translationTopP: asNumber(body.translationTopP, config.translationTopP),
    whisperChunkLengthS: Math.max(1, Math.floor(asNumber(body.whisperChunkLengthS, config.whisperChunkLengthS))),
    pythonExecutable: asPathString(body.pythonExecutable, config.pythonExecutable),
    debugMode: asBoolean(body.debugMode, config.debugMode)
  }
}

export async function startLocalApi(options: ServerOptions) {
  const apiLog = createLogger('api')
  let requestSequence = 0
  const store = new RuntimeStore(options.configFile, options.defaults, Boolean(options.pinBundledPaths))
  const resolveVendor = () => {
    const base = resolveVendorPaths(store.read())
    return { ...base, ytdlpExecutable: options.resolveActiveYtdlp().executable }
  }
  const tasks = new TaskManager({
    getConfig: () => store.read(),
    resolveVendor,
    projectDirectory: options.projectDirectory,
    pythonProjectDirectory: options.pythonProjectDirectory,
    bundledPythonExecutable: options.bundledPythonExecutable,
    downloadTikTokPublic: options.downloadTikTokPublic,
    taskIndexFile: join(dirname(options.configFile), 'tasks.json'),
    resolveTikTokBrowserMedia: options.resolveTikTokBrowserMedia,
    resolveFacebookAnonymousMedia: options.resolveFacebookAnonymousMedia,
    resolvePlatformAuthentication: options.resolvePlatformAuthentication
  })
  tasks.restore(store.read().outputDirectory)
  const token = randomBytes(24).toString('hex')
  const server = createServer(async (request, response) => {
    const startTime = Date.now()
    const requestId = ++requestSequence
    let requestBody: unknown = undefined
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const method = request.method ?? 'GET'
      response.once('finish', () => {
        apiLog.debug('API 请求完成', {
          requestId,
          method,
          path: url.pathname,
          status: response.statusCode,
          durationMs: Date.now() - startTime
        })
      })
      apiLog.info(`→ ${method} ${url.pathname}${url.searchParams.has('token') ? '?token=<redacted>' : url.search}`, { requestId })
      if (method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Max-Age': '600'
        })
        return response.end()
      }
      if (request.headers.authorization !== `Bearer ${token}` && url.searchParams.get('token') !== token) {
        return json(response, 401, { error: 'Unauthorized local request' })
      }
      if (method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true })
      if (method === 'GET' && url.pathname === '/media') {
        const filePath = normalizeOsPath(url.searchParams.get('path') ?? '')
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

      const configStartedAt = Date.now()
      const config = store.read()
      apiLog.debug('请求配置读取完成', {
        requestId,
        path: url.pathname,
        durationMs: Date.now() - configStartedAt,
        modelsDirectory: config.modelsDirectory,
        ytdlpDirectory: config.ytdlpDirectory,
        ffmpegDirectory: config.ffmpegDirectory,
        denoDirectory: config.denoDirectory
      })

      if (method === 'GET' && url.pathname === '/runtime/status') {
        const activeStartedAt = Date.now()
        const activeYtdlp = options.resolveActiveYtdlp()
        apiLog.debug('活动 yt-dlp 解析完成', {
          requestId,
          durationMs: Date.now() - activeStartedAt,
          source: activeYtdlp.source,
          channel: activeYtdlp.channel
        })
        const statusStartedAt = Date.now()
        const status = getRuntimeStatus(config, activeYtdlp)
        apiLog.debug('运行时状态响应准备完成', { requestId, durationMs: Date.now() - statusStartedAt })
        return json(response, 200, status)
      }
      if (method === 'GET' && url.pathname === '/config') {
        apiLog.debug('配置响应准备完成', { requestId, configFile: options.configFile })
        return json(response, 200, config)
      }
      if (method === 'PUT' && url.pathname === '/config') {
        const body = await readJson(request)
        requestBody = body
        apiLog.info('更新配置', { requestId, keys: Object.keys(body), bodySummary: summarizeRequestBody(body) })
        const next = mergeConfig(body, config)
        mkdirSync(next.outputDirectory, { recursive: true })
        const result = store.write(next)
        apiLog.info('✓ 配置已保存')
        return json(response, 200, result)
      }
      const platformAuthConfigMatch = url.pathname.match(/^\/config\/platform-auth\/(youtube|tiktok|instagram|facebook)$/)
      if (method === 'PUT' && platformAuthConfigMatch) {
        const platformId = platformAuthConfigMatch[1] as YtdlpCookiePlatformId
        const body = await readJson(request)
        const current = store.read()
        const entry = asPlatformAuth({ [platformId]: body }, current.ytdlpPlatformAuth)[platformId]
        const next = store.write({
          ...current,
          ytdlpPlatformAuth: {
            ...current.ytdlpPlatformAuth,
            [platformId]: entry
          }
        })
        return json(response, 200, next)
      }
      if (method === 'POST' && url.pathname === '/runtime/refresh') {
        const activeYtdlp = options.resolveActiveYtdlp()
        return json(response, 200, getRuntimeStatus(config, activeYtdlp))
      }
      if (method === 'POST' && url.pathname === '/runtime/ytdlp/check-update') {
        return json(response, 200, await options.checkYtdlpUpdate())
      }
      if (method === 'POST' && url.pathname === '/runtime/ytdlp/install-update') {
        if (tasks.hasActiveTasks()) return json(response, 409, { error: '下载任务运行中，不能更新 yt-dlp。' })
        const body = await readJson(request)
        if (typeof body.version !== 'string' || !body.version.trim()) return json(response, 400, { error: '请提供要安装的 yt-dlp 版本。' })
        return json(response, 200, await options.installYtdlpUpdate(body.version.trim()))
      }
      if (method === 'POST' && url.pathname === '/runtime/ytdlp/restore-bundled') {
        if (tasks.hasActiveTasks()) return json(response, 409, { error: '下载任务运行中，不能恢复 yt-dlp。' })
        return json(response, 200, await options.restoreBundledYtdlp())
      }
      if (method === 'POST' && url.pathname === '/dialog/select-directory') {
        const body = await readJson(request)
        const title = typeof body.title === 'string' ? body.title : '选择文件夹'
        const defaultPath = typeof body.defaultPath === 'string' ? normalizeOsPath(body.defaultPath) : undefined
        const selected = await options.selectDirectory(title, defaultPath)
        return json(response, 200, { path: selected ? normalizeOsPath(selected) : null })
      }
      if (method === 'POST' && url.pathname === '/dialog/select-audio') {
        const body = await readJson(request)
        const title = typeof body.title === 'string' ? body.title : '选择音频文件'
        const defaultPath = typeof body.defaultPath === 'string' ? normalizeOsPath(body.defaultPath) : undefined
        const selected = await options.selectAudioFile(title, defaultPath)
        return json(response, 200, { path: selected ? normalizeOsPath(selected) : null })
      }
      if (method === 'POST' && url.pathname === '/dialog/select-file') {
        const body = await readJson(request)
        const title = typeof body.title === 'string' ? body.title : '选择文件'
        const defaultPath = typeof body.defaultPath === 'string' ? normalizeOsPath(body.defaultPath) : undefined
        const filters = Array.isArray(body.filters)
          ? body.filters.filter((item): item is FileFilter =>
            Boolean(item) &&
            typeof item === 'object' &&
            typeof (item as FileFilter).name === 'string' &&
            Array.isArray((item as FileFilter).extensions)
          )
          : undefined
        const selected = await options.selectFile(title, defaultPath, filters)
        return json(response, 200, { path: selected ? normalizeOsPath(selected) : null })
      }
      if (method === 'POST' && url.pathname === '/dialog/open-path') {
        const body = await readJson(request)
        if (typeof body.path !== 'string' || !body.path.trim()) return json(response, 400, { error: '请提供要打开的路径。' })
        await options.openPath(normalizeOsPath(body.path.trim()))
        return json(response, 200, { ok: true })
      }
      if (method === 'POST' && url.pathname === '/browser/open-login') {
        try {
          const body = await readJson(request)
          const platformId = body.platformId
          if (platformId !== 'youtube' && platformId !== 'tiktok' && platformId !== 'instagram' && platformId !== 'facebook') {
            return json(response, 400, { error: '请选择要登录的平台。' })
          }
          await options.openLoginWindow(platformId)
        } catch (error) {
          return json(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return json(response, 200, { ok: true })
      }
      if (method === 'GET' && url.pathname === '/browser/cookie-status') {
        const requested = url.searchParams.get('platformId')
        const platformId = requested === 'youtube' || requested === 'tiktok' || requested === 'instagram' || requested === 'facebook'
          ? requested
          : undefined
        return json(response, 200, await options.getLoginCookieStatus(config.ytdlpPlatformAuth, config.ytdlpProxy, platformId))
      }
      if (method === 'POST' && url.pathname === '/browser/cookie-status') {
        const body = await readJson(request)
        const requested = body.platformId
        if (requested !== 'youtube' && requested !== 'tiktok' && requested !== 'instagram' && requested !== 'facebook') {
          return json(response, 400, { error: '请选择要检测的平台。' })
        }
        const platformAuth = asPlatformAuth({ [requested]: body.auth }, config.ytdlpPlatformAuth)
        return json(response, 200, await options.getLoginCookieStatus(platformAuth, config.ytdlpProxy, requested))
      }
      if (method === 'GET' && url.pathname === '/system/data-roots') {
        if (!options.getAppDataRoots) {
          return json(response, 400, { error: '当前环境不支持查询数据目录。' })
        }
        return json(response, 200, await options.getAppDataRoots())
      }
      if (method === 'POST' && url.pathname === '/system/clear-cache') {
        if (!options.clearAppCache) {
          return json(response, 400, { error: '当前环境不支持清理缓存。' })
        }
        try {
          const result = await options.clearAppCache()
          if (result.cancelled) return json(response, 200, result)
          tasks.clearAllRecords()
          result.cleared.push('tasks.json / records')
          const current = store.read()
          const next = store.write({
            ...current,
            ytdlpPlatformAuth: defaultPlatformAuth()
          })
          return json(response, 200, { ...result, config: next })
        } catch (error) {
          return json(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
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
          return json(response, 200, { artifacts: tasks.export(taskId, normalizeOsPath(body.targetDirectory.trim())) })
        }
      }
      if (method === 'POST' && url.pathname === '/pipelines/req1') {
        const body = await readJson(request)
        const outputDirectory = typeof body.outputDirectory === 'string' && body.outputDirectory.trim()
          ? normalizeOsPath(body.outputDirectory.trim())
          : normalizeOsPath(store.read().outputDirectory)
        mkdirSync(outputDirectory, { recursive: true })
        const videoPathRaw = typeof body.videoPath === 'string' ? body.videoPath : ''
        if (videoPathRaw.trim()) {
          const videoPath = assertLocalVideoPath(videoPathRaw)
          if (!existsSync(videoPath)) return json(response, 400, { error: '本地视频文件不存在。' })
          return json(response, 202, tasks.startRequirementOne(videoPath, outputDirectory, resolveModelPaths(store.read()), 'local'))
        }
        const { url: urlValue } = readVideoPipelineInput(body, store.read().outputDirectory)
        return json(response, 202, tasks.startRequirementOne(urlValue, outputDirectory, resolveModelPaths(store.read()), 'url'))
      }
      if (method === 'POST' && url.pathname === '/pipelines/req2') {
        const body = await readJson(request)
        const audioPath = typeof body.audioPath === 'string' ? normalizeOsPath(body.audioPath.trim()) : ''
        if (!audioPath) return json(response, 400, { error: '请选择本地音频文件。' })
        const sourceText = typeof body.sourceText === 'string' ? body.sourceText : ''
        const outputDirectory = typeof body.outputDirectory === 'string' && body.outputDirectory.trim()
          ? normalizeOsPath(body.outputDirectory.trim())
          : normalizeOsPath(store.read().outputDirectory)
        mkdirSync(outputDirectory, { recursive: true })
        return json(response, 202, tasks.startRequirementTwo(audioPath, sourceText, outputDirectory, resolveModelPaths(store.read())))
      }
      if (method === 'POST' && url.pathname === '/pipelines/download') {
        const body = await readJson(request)
        const { url: urlValue, outputDirectory } = readVideoPipelineInput(body, store.read().outputDirectory)
        mkdirSync(outputDirectory, { recursive: true })
        return json(response, 202, tasks.startDownload(urlValue, outputDirectory))
      }
      return json(response, 404, { error: 'Not found' })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorStack = error instanceof Error ? error.stack : undefined
      apiLog.error(`✗ 请求失败`, {
        requestId,
        method: request.method,
        url: safeRequestUrl(request.url),
        error: errorMessage,
        stack: errorStack,
        bodySummary: summarizeRequestBody(requestBody),
        duration: `${Date.now() - startTime}ms`
      })
      return json(response, 400, { error: 'Bad request', detail: errorMessage })
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
