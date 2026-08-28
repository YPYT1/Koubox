import { contextBridge, ipcRenderer } from 'electron'

const apiUrl = process.argv.find((value) => value.startsWith('--koubox-api='))?.slice('--koubox-api='.length)
const token = process.argv.find((value) => value.startsWith('--koubox-token='))?.slice('--koubox-token='.length)

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!apiUrl || !token) throw new Error('本地服务尚未启动。')
  const startTime = Date.now()
  try {
    const response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init?.headers }
    })
    const payload = await response.json() as T & { error?: string; detail?: string }
    const duration = Date.now() - startTime

    if (!response.ok) {
      // 优先显示 detail（包含真实错误信息），其次是 error
      const message = payload.detail || payload.error || `本地服务错误 (${response.status})`
      // 记录错误到日志文件
      void ipcRenderer.invoke('log:error', `API 请求失败: ${init?.method || 'GET'} ${path}`, {
        status: response.status,
        error: message,
        duration: `${duration}ms`,
        body: init?.body
      })
      throw new Error(message)
    }

    // 记录成功的请求（仅记录非 GET 请求）
    if (init?.method && init.method !== 'GET') {
      void ipcRenderer.invoke('log:info', `API 请求成功: ${init.method} ${path}`, { duration: `${duration}ms` })
    }

    return payload
  } catch (error) {
    const duration = Date.now() - startTime
    if (error instanceof Error && error.message !== '本地服务尚未启动。') {
      void ipcRenderer.invoke('log:error', `API 请求异常: ${init?.method || 'GET'} ${path}`, {
        error: error.message,
        duration: `${duration}ms`
      })
    }
    throw error
  }
}

contextBridge.exposeInMainWorld('koubox', {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  mediaUrl: (filePath: string) => {
    if (!apiUrl || !token) throw new Error('本地服务尚未启动。')
    return `${apiUrl}/media?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(token)}`
  },
  openDevTools: () => ipcRenderer.invoke('devtools:toggle') as Promise<boolean>,
  logError: (message: string, detail?: unknown) => ipcRenderer.invoke('log:error', message, detail),
  logWarn: (message: string, detail?: unknown) => ipcRenderer.invoke('log:warn', message, detail),
  logInfo: (message: string, detail?: unknown) => ipcRenderer.invoke('log:info', message, detail),
  events: <T>(path: string, onEvent: (event: T) => void) => {
    const controller = new AbortController()
    if (!apiUrl || !token) return () => controller.abort()
    void (async () => {
      const response = await fetch(`${apiUrl}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      if (!response.ok || !response.body) return
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
    })().catch(() => undefined)
    return () => controller.abort()
  }
})

// 记录 preload 脚本加载
void ipcRenderer.invoke('log:info', 'Preload 脚本已加载', { apiUrl: apiUrl ? '已配置' : '未配置' })
