import https from 'node:https'
import { randomUUID } from 'node:crypto'
import type { CopySharePayload } from '@koubox/shared'
import { assertCopySharePayload } from './payload.js'
import type { LanIdentity } from './identity.js'

export type IncomingHandler = (id: string, payload: CopySharePayload) => { accepted: boolean; waiting?: boolean }
export type CancelHandler = (id: string) => void

export function createLanHttpsServer(identity: LanIdentity, port: number, onIncoming: IncomingHandler, getTransfer?: (id: string) => unknown, onCancel?: CancelHandler): https.Server {
  const sessions = new Map<string, string>()
  return https.createServer({ key: identity.privateKey, cert: identity.certificate }, async (request, response) => {
    const url = new URL(request.url ?? '/', 'https://koubox.local')
    if (request.method === 'GET' && /^\/v1\/transfers\/[^/]+$/.test(url.pathname)) {
      const token = url.searchParams.get('sessionToken')
      if (typeof token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) { response.writeHead(400); response.end(JSON.stringify({ error: '会话令牌无效。' })); return }
      const transferId = decodeURIComponent(url.pathname.split('/').pop()!)
      if (sessions.get(token) !== transferId) { response.writeHead(403); response.end(JSON.stringify({ error: '会话令牌与传输不匹配。' })); return }
      const transfer = getTransfer?.(transferId)
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(transfer ?? { status: 'error', error: '传输不存在。' })); return
    }
    if (request.method === 'POST' && /^\/v1\/transfers\/[^/]+\/cancel$/.test(url.pathname)) {
      const token = url.searchParams.get('sessionToken')
      if (typeof token !== 'string' || sessions.get(token) !== decodeURIComponent(url.pathname.split('/')[3])) { response.writeHead(403); response.end(JSON.stringify({ error: '会话令牌与传输不匹配。' })); return }
      onCancel?.(sessions.get(token)!)
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true })); return
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/receive') { response.writeHead(404); response.end(); return }
    let raw = ''; for await (const chunk of request) raw += chunk
    try {
      const body = JSON.parse(raw) as Record<string, unknown>
      if (typeof body.sessionToken !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.sessionToken)) throw new Error('会话令牌无效。')
      const payload = assertCopySharePayload(body.payload)
      const transferId = randomUUID()
      const result = onIncoming(transferId, payload)
      sessions.set(body.sessionToken, transferId)
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ transferId, ...result }))
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  }).listen(port, '0.0.0.0')
}
