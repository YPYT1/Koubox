import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type { KouboxConfig } from '@koubox/shared'
import { tools } from '@koubox/shared'
import { RuntimeStore, getRuntimeStatus } from './runtime.js'
import { TaskManager } from './tasks.js'

type ServerOptions = {
  configFile: string
  defaults: KouboxConfig
  vendorDirectory: string
  projectDirectory: string
  pythonProjectDirectory: string
  bundledPythonExecutable?: string
  selectDirectory(title: string, defaultPath?: string): Promise<string | undefined>
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS'
  })
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = ''
  for await (const chunk of request) text += chunk
  return text ? JSON.parse(text) as Record<string, unknown> : {}
}

export async function startLocalApi(options: ServerOptions) {
  const store = new RuntimeStore(options.configFile, options.defaults)
  const tasks = new TaskManager({
    vendorDirectory: options.vendorDirectory,
    projectDirectory: options.projectDirectory,
    pythonProjectDirectory: options.pythonProjectDirectory,
    bundledPythonExecutable: options.bundledPythonExecutable
  })
  const token = randomBytes(24).toString('hex')
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const method = request.method ?? 'GET'
      if (method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS'
        })
        return response.end()
      }
      if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { error: 'Unauthorized local request' })
      const config = store.read()

      if (method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true })
      if (method === 'GET' && url.pathname === '/tools') return json(response, 200, tools)
      if (method === 'GET' && url.pathname === '/runtime/status') return json(response, 200, getRuntimeStatus(config, options.vendorDirectory))
      if (method === 'GET' && url.pathname === '/config') return json(response, 200, config)
      if (method === 'PUT' && url.pathname === '/config') {
        const body = await readJson(request)
        const next: KouboxConfig = {
          modelsDirectory: typeof body.modelsDirectory === 'string' ? body.modelsDirectory : config.modelsDirectory,
          outputDirectory: typeof body.outputDirectory === 'string' ? body.outputDirectory : config.outputDirectory
        }
        mkdirSync(next.outputDirectory, { recursive: true })
        return json(response, 200, store.write(next))
      }
      if (method === 'POST' && url.pathname === '/runtime/refresh') return json(response, 200, getRuntimeStatus(config, options.vendorDirectory))
      if (method === 'POST' && url.pathname === '/dialog/select-directory') {
        const body = await readJson(request)
        const title = typeof body.title === 'string' ? body.title : '选择文件夹'
        const defaultPath = typeof body.defaultPath === 'string' ? body.defaultPath : undefined
        return json(response, 200, { path: await options.selectDirectory(title, defaultPath) ?? null })
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
          const unsubscribe = tasks.subscribe(taskId, (event) => response.write(`data: ${JSON.stringify(event)}\n\n`))
          request.on('close', unsubscribe)
          return
        }
        if (method === 'GET' && !action) return json(response, 200, task)
        if (method === 'POST' && action === 'cancel') return json(response, 200, tasks.cancel(taskId))
        if (method === 'POST' && action === 'translate') {
          try { return json(response, 200, await tasks.translate(taskId, store.read().modelsDirectory)) }
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
        return json(response, 202, tasks.startRequirementOne(urlValue, outputDirectory, store.read().modelsDirectory))
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
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}
