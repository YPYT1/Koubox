import { contextBridge, ipcRenderer } from 'electron'

const apiUrl = process.argv.find((value) => value.startsWith('--koubox-api='))?.slice('--koubox-api='.length)
const token = process.argv.find((value) => value.startsWith('--koubox-token='))?.slice('--koubox-token='.length)
let requestSequence = 0
const inFlightGets = new Map<string, Promise<unknown>>()

function requestLabel(method: string, path: string): string {
  return `${method} ${path}`
}

function isSilentMonitorGet(method: string, path: string): boolean {
  return method === 'GET' && (path === '/runtime/memory' || path === '/runtime/gpu')
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!apiUrl || !token) throw new Error('本地服务尚未启动。')
  const startTime = Date.now()
  const requestId = ++requestSequence
  const method = init?.method || 'GET'
  const silent = isSilentMonitorGet(method, path)
  if (!silent) {
    void ipcRenderer.invoke('log:debug', 'preload 请求开始', {
      requestId,
      request: requestLabel(method, path),
      hasBody: Boolean(init?.body),
      bodyBytes: typeof init?.body === 'string' ? init.body.length : 0
    })
  }
  try {
    const response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init?.headers }
    })
    const payload = await response.json() as T & { error?: string; detail?: string }
    const duration = Date.now() - startTime

    if (!silent) {
      void ipcRenderer.invoke('log:debug', 'preload 请求收到响应', {
        requestId,
        request: requestLabel(method, path),
        status: response.status,
        ok: response.ok,
        durationMs: duration,
        payloadType: typeof payload
      })
    }

    if (!response.ok) {
      const message = payload.detail || payload.error || `本地服务错误 (${response.status})`
      void ipcRenderer.invoke('log:error', `API 请求失败: ${init?.method || 'GET'} ${path}`, {
        status: response.status,
        error: message,
        duration: `${duration}ms`,
        bodyBytes: typeof init?.body === 'string' ? init.body.length : 0
      })
      throw new Error(message)
    }

    if (!silent) {
      void ipcRenderer.invoke('log:debug', 'preload 请求完成', {
        requestId,
        request: requestLabel(method, path),
        durationMs: duration
      })
    }
    if (init?.method && init.method !== 'GET') {
      void ipcRenderer.invoke('log:info', `API 请求成功: ${init.method} ${path}`, { duration: `${duration}ms` })
    }

    return payload
  } catch (error) {
    const duration = Date.now() - startTime
    if (error instanceof Error && error.message !== '本地服务尚未启动。') {
      void ipcRenderer.invoke('log:error', `API 请求异常: ${init?.method || 'GET'} ${path}`, {
        error: error.message,
        duration: `${duration}ms`,
        requestId
      })
    }
    throw error
  }
}

function get<T>(path: string): Promise<T> {
  const existing = inFlightGets.get(path)
  if (existing) {
    if (!isSilentMonitorGet('GET', path)) {
      void ipcRenderer.invoke('log:debug', 'preload 复用进行中的 GET 请求', { path })
    }
    return existing as Promise<T>
  }

  const pending = request<T>(path)
  inFlightGets.set(path, pending)
  const clear = () => {
    if (inFlightGets.get(path) === pending) inFlightGets.delete(path)
  }
  void pending.then(clear, clear)
  return pending
}

contextBridge.exposeInMainWorld('koubox', {
  get,
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  mediaUrl: (filePath: string) => {
    if (!apiUrl || !token) throw new Error('本地服务尚未启动。')
    return `${apiUrl}/media?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(token)}`
  },
  openDevTools: () => ipcRenderer.invoke('devtools:toggle') as Promise<boolean>,
  logError: (message: string, detail?: unknown) => ipcRenderer.invoke('log:error', message, detail),
  logDebug: (message: string, detail?: unknown) => ipcRenderer.invoke('log:debug', message, detail),
  logWarn: (message: string, detail?: unknown) => ipcRenderer.invoke('log:warn', message, detail),
  logInfo: (message: string, detail?: unknown) => ipcRenderer.invoke('log:info', message, detail),
  events: <T>(path: string, onEvent: (event: T) => void) => {
    const controller = new AbortController()
    const subscriptionId = ++requestSequence
    void ipcRenderer.invoke('log:debug', 'preload 事件订阅开始', { subscriptionId, path })
    if (!apiUrl || !token) return () => controller.abort()
    void (async () => {
      const response = await fetch(`${apiUrl}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      if (!response.ok || !response.body) {
        void ipcRenderer.invoke('log:debug', 'preload 事件订阅失败', { subscriptionId, path, status: response.status })
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (!controller.signal.aborted) {
        const result = await reader.read()
        if (result.done) break
        buffer += decoder.decode(result.value, { stream: true })
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        for (const block of blocks) {
          const data = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
          if (data) onEvent(JSON.parse(data) as T)
        }
      }
    })().catch((error) => {
      void ipcRenderer.invoke('log:debug', 'preload 事件订阅异常', { subscriptionId, path, error: error instanceof Error ? error.message : String(error) })
    })
    return () => {
      controller.abort()
      void ipcRenderer.invoke('log:debug', 'preload 事件订阅结束', { subscriptionId, path })
    }
  }
})

// 记录 preload 脚本加载
void ipcRenderer.invoke('log:info', 'Preload 脚本已加载', { apiUrl: apiUrl ? '已配置' : '未配置' })
