import https from 'node:https'
import { createHash } from 'node:crypto'
import type { ClientRequest } from 'node:http'
import type { TLSSocket } from 'node:tls'
import type { CopySharePayload, LanDevice } from '@koubox/shared'

function normalizeFingerprint(value: string): string { return value.replace(/[^a-f0-9]/gi, '').toLowerCase() }
function sendAfterFingerprintCheck(request: ClientRequest, device: LanDevice, send: () => void): void {
  let settled = false
  const verify = (socket: TLSSocket) => {
    if (settled) return
    settled = true
    const raw = socket.getPeerCertificate().raw
    if (!raw || normalizeFingerprint(device.fingerprint) !== normalizeFingerprint(createHash('sha256').update(raw).digest('hex'))) {
      request.destroy(new Error(`设备证书指纹不匹配：${device.alias}`)); return
    }
    send()
  }
  request.once('socket', (socket) => {
    const tls = socket as TLSSocket
    if (tls.connecting) tls.once('secureConnect', () => verify(tls))
    else queueMicrotask(() => verify(tls))
  })
  request.setTimeout(5000, () => request.destroy(new Error('局域网 TLS 握手超时。')))
  request.flushHeaders()
}

export async function sendCopyPayload(device: LanDevice, payload: CopySharePayload, sessionToken: string): Promise<{ transferId: string; accepted: boolean; waiting?: boolean }> {
  const body = JSON.stringify({ sessionToken, payload })
  return await new Promise((resolve, reject) => {
    const request = https.request({ hostname: device.host, port: device.port, path: '/v1/receive', method: 'POST', rejectUnauthorized: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (response) => {
      let text = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { text += chunk }); response.on('end', () => {
        if ((response.statusCode ?? 500) >= 400) return reject(new Error(text || `接收方返回 ${response.statusCode}`))
        try { resolve(JSON.parse(text) as { transferId: string; accepted: boolean; waiting?: boolean }) } catch { reject(new Error('接收方响应无效。')) }
      })
    })
    request.on('error', reject)
    sendAfterFingerprintCheck(request, device, () => { request.write(body); request.end() })
  })
}

export async function getCopyTransferStatus(device: LanDevice, transferId: string, sessionToken: string): Promise<{ status: string; error?: string }> {
  return await new Promise((resolve, reject) => {
    const request = https.request({ hostname: device.host, port: device.port, path: `/v1/transfers/${encodeURIComponent(transferId)}?sessionToken=${encodeURIComponent(sessionToken)}`, method: 'GET', rejectUnauthorized: false }, (response) => {
      let text = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { text += chunk }); response.on('end', () => {
        if ((response.statusCode ?? 500) >= 400) return reject(new Error(text || `接收方返回 ${response.statusCode}`))
        try { resolve(JSON.parse(text) as { status: string; error?: string }) } catch { reject(new Error('接收方状态响应无效。')) }
      })
    })
    request.on('error', reject)
    sendAfterFingerprintCheck(request, device, () => request.end())
  })
}

export async function cancelCopyTransfer(device: LanDevice, transferId: string, sessionToken: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = https.request({ hostname: device.host, port: device.port, path: `/v1/transfers/${encodeURIComponent(transferId)}/cancel?sessionToken=${encodeURIComponent(sessionToken)}`, method: 'POST', rejectUnauthorized: false }, (response) => {
      let text = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { text += chunk }); response.on('end', () => {
        if ((response.statusCode ?? 500) >= 400) return reject(new Error(text || `接收方返回 ${response.statusCode}`))
        resolve()
      })
    })
    request.on('error', reject)
    sendAfterFingerprintCheck(request, device, () => request.end())
  })
}
