import { contextBridge } from 'electron'

const apiUrl = process.argv.find((value) => value.startsWith('--koubox-api='))?.slice('--koubox-api='.length)
const token = process.argv.find((value) => value.startsWith('--koubox-token='))?.slice('--koubox-token='.length)

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!apiUrl || !token) throw new Error('本地服务尚未启动。')
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init?.headers }
  })
  const payload = await response.json() as T & { error?: string; detail?: string }
  if (!response.ok) throw new Error(payload.error ?? `本地服务错误 (${response.status})`)
  return payload
}

contextBridge.exposeInMainWorld('koubox', {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
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
