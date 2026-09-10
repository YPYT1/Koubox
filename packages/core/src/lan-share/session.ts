import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { CopySharePayload, LanDevice, LanTransfer } from '@koubox/shared'
import { CopyLibraryStore } from '../copy-library.js'
import { loadOrCreateLanIdentity, type LanIdentity } from './identity.js'
import { LanDiscovery } from './discovery.js'
import { cancelCopyTransfer, getCopyTransferStatus, sendCopyPayload } from './client.js'
import { createLanHttpsServer } from './server.js'
import { LanTransferStore } from './transfer-store.js'

export class LanShareService {
  readonly identity: LanIdentity
  readonly transfers = new LanTransferStore()
  readonly discovery: LanDiscovery
  private server?: ReturnType<typeof createLanHttpsServer>
  private error?: string
  private readonly incoming = new Map<string, { payload: CopySharePayload; transferId: string }>()
  private readonly incomingListeners = new Set<(items: Array<{ id: string; senderAlias: string; names: string[]; transferId: string }>) => void>()
  private readonly remoteSessions = new Map<string, { device: LanDevice; transferId: string; sessionToken: string }>()
  private constructor(
    private readonly rootDir: string,
    private readonly port: number,
    alias: string,
    private readonly library: CopyLibraryStore,
    private readonly getConfig: () => { lanAutoSave: boolean; lanHistoryEnabled: boolean; lanSaveDirectory: string },
    identity: LanIdentity
  ) {
    this.identity = identity
    this.discovery = new LanDiscovery(this.identity, () => this.getPort())
  }
  static async create(rootDir: string, port: number, alias: string, library: CopyLibraryStore, getConfig: () => { lanAutoSave: boolean; lanHistoryEnabled: boolean; lanSaveDirectory: string }): Promise<LanShareService> {
    return new LanShareService(rootDir, port, alias, library, getConfig, await loadOrCreateLanIdentity(join(rootDir, 'lan'), alias))
  }
  start(): void {
    if (this.server) return
    this.server = createLanHttpsServer(this.identity, this.port, (id, payload) => {
      const transfer = this.transfers.create({ id, direction: 'receive', peerId: payload.sender.deviceId, peerAlias: payload.sender.alias, entries: payload.entries.map((entry) => entry.id), bytesTotal: Buffer.byteLength(JSON.stringify(payload)) })
      if (this.getConfig().lanAutoSave) {
        this.acceptPayload(transfer.id, payload)
        this.transfers.update(transfer.id, { status: 'complete', bytesTransferred: transfer.bytesTotal, percent: 100 })
        return { accepted: true }
      }
      this.incoming.set(id, { payload, transferId: transfer.id })
      this.emitIncoming()
      return { accepted: false, waiting: true }
    }, (id) => this.transfers.get(id), (id) => {
      this.incoming.delete(id)
      const current = this.transfers.get(id)
      if (current && !['complete', 'rejected', 'error'].includes(current.status)) this.transfers.cancel(id)
    }, (error) => { this.error = `HTTPS 服务启动失败：${error.message}` })
    this.discovery.start(undefined, (error) => { this.error = `局域网发现失败：${error.message}` })
  }
  stop(): void { this.server?.close(); this.server = undefined; this.discovery.close() }
  getPort(): number { return this.server ? ((this.server.address() as AddressInfo | null)?.port ?? this.port) : this.port }
  getError(): string | undefined { return this.error ?? this.discovery.getError() }
  listDevices(): LanDevice[] { return this.discovery.list() }
  listTransfers(): LanTransfer[] { return this.transfers.list() }
  listIncoming(): Array<{ id: string; senderAlias: string; names: string[]; transferId: string }> {
    return [...this.incoming.entries()].map(([id, value]) => ({ id, senderAlias: value.payload.sender.alias, names: value.payload.entries.map((entry) => entry.title), transferId: value.transferId }))
  }
  async shareEntries(entryIds: string[], deviceIds: string[]): Promise<LanTransfer[]> {
    const entries = entryIds.map((id) => this.library.get(id)).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    if (entries.length === 0) throw new Error('请选择要分享的文案。')
    const devices = deviceIds.map((id) => this.listDevices().find((device) => device.id === id && device.online)).filter((device): device is LanDevice => Boolean(device))
    if (devices.length === 0) throw new Error('请选择在线设备。')
    return this.send({ protocol: 'koubox-copy-library', version: 1, sender: { alias: this.identity.alias, deviceId: this.identity.deviceId }, entries: entries.map(({ id, title, content, kind, tags, sourceTool, sourceTaskId, sourceName }) => ({ id, title, content, kind, tags, sourceTool, sourceTaskId, sourceName })) }, devices)
  }
  async send(payload: CopySharePayload, devices: LanDevice[]): Promise<LanTransfer[]> {
    const results: LanTransfer[] = []
    const queue = [...devices]
    const worker = async () => { while (queue.length > 0) {
      const device = queue.shift()!
      const bytesTotal = Buffer.byteLength(JSON.stringify(payload))
      const transfer = this.transfers.create({ direction: 'send', peerId: device.id, peerAlias: device.alias, entries: payload.entries.map((entry) => entry.id), bytesTotal, status: 'sending' })
      results.push(transfer)
      const sessionToken = randomUUID()
      try {
        const result = await sendCopyPayload(device, payload, sessionToken)
        if (this.transfers.get(transfer.id)?.status === 'cancelled') {
          if (!result.accepted) await cancelCopyTransfer(device, result.transferId, sessionToken).catch(() => undefined)
          continue
        }
        this.remoteSessions.set(transfer.id, { device, transferId: result.transferId, sessionToken })
        this.transfers.update(transfer.id, { status: result.accepted ? 'complete' : 'waiting', bytesTransferred: result.accepted ? bytesTotal : 0, percent: result.accepted ? 100 : 0 })
        if (result.accepted && this.getConfig().lanHistoryEnabled) for (const entry of payload.entries) this.library.recordHistory({ transferId: transfer.id, direction: 'send', entryId: entry.id, peerId: device.id, peerAlias: device.alias, status: 'complete', bytesTotal, bytesTransferred: bytesTotal, completedAt: new Date().toISOString() })
        if (!result.accepted && result.waiting) void this.pollRemoteTransfer(transfer.id, device, result.transferId, sessionToken, payload)
        else this.remoteSessions.delete(transfer.id)
      } catch (error) {
        this.remoteSessions.delete(transfer.id)
        this.transfers.update(transfer.id, { status: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    }}
    await Promise.all(Array.from({ length: Math.min(4, devices.length) }, worker))
    return this.transfers.list().filter((item) => results.some((result) => result.id === item.id))
  }
  decideIncoming(id: string, accept: boolean): LanTransfer | undefined {
    const pending = this.incoming.get(id); if (!pending) return undefined
    this.incoming.delete(id)
    this.emitIncoming()
    if (accept) {
      this.acceptPayload(pending.transferId, pending.payload)
      return this.transfers.update(pending.transferId, { status: 'complete', bytesTransferred: Buffer.byteLength(JSON.stringify(pending.payload)), percent: 100 })
    }
    return this.transfers.update(pending.transferId, { status: 'rejected' })
  }
  subscribeIncoming(listener: (items: Array<{ id: string; senderAlias: string; names: string[]; transferId: string }>) => void): () => void {
    this.incomingListeners.add(listener)
    listener(this.listIncoming())
    return () => this.incomingListeners.delete(listener)
  }
  private emitIncoming(): void {
    const items = this.listIncoming()
    for (const listener of this.incomingListeners) listener(items)
  }
  async cancel(id: string): Promise<LanTransfer | undefined> {
    const transfer = this.transfers.cancel(id)
    const remote = this.remoteSessions.get(id)
    this.remoteSessions.delete(id)
    if (remote) await cancelCopyTransfer(remote.device, remote.transferId, remote.sessionToken).catch(() => undefined)
    return transfer
  }
  private acceptPayload(transferId: string, payload: CopySharePayload): void {
    const bytes = Buffer.byteLength(JSON.stringify(payload))
    for (const entry of payload.entries) {
      const saved = this.library.upsert({ ...entry, senderAlias: payload.sender.alias }, true)
      if (this.getConfig().lanHistoryEnabled) this.library.recordHistory({ transferId, direction: 'receive', entryId: saved.id, peerId: payload.sender.deviceId, peerAlias: payload.sender.alias, status: 'complete', bytesTotal: bytes, bytesTransferred: bytes, completedAt: new Date().toISOString() })
    }
    const directory = this.getConfig().lanSaveDirectory
    if (directory) { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, `${transferId}.json`), JSON.stringify(payload, null, 2), 'utf8') }
  }
  private async pollRemoteTransfer(localId: string, device: LanDevice, remoteId: string, sessionToken: string, payload: CopySharePayload): Promise<void> {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      try {
        if (this.transfers.get(localId)?.status === 'cancelled') return
        const status = await getCopyTransferStatus(device, remoteId, sessionToken)
        if (status.status === 'complete' || status.status === 'rejected' || status.status === 'cancelled' || status.status === 'error') {
          const bytes = Buffer.byteLength(JSON.stringify(payload))
          if (this.transfers.get(localId)?.status === 'cancelled') return
          this.transfers.update(localId, { status: status.status as 'complete' | 'rejected' | 'cancelled' | 'error', bytesTransferred: status.status === 'complete' ? bytes : 0, percent: status.status === 'complete' ? 100 : 0, error: status.error })
          if (status.status === 'complete' && this.getConfig().lanHistoryEnabled) for (const entry of payload.entries) this.library.recordHistory({ transferId: localId, direction: 'send', entryId: entry.id, peerId: device.id, peerAlias: device.alias, status: 'complete', bytesTotal: bytes, bytesTransferred: bytes, completedAt: new Date().toISOString() })
          this.remoteSessions.delete(localId)
          return
        }
      } catch { /* temporary LAN disconnect; keep polling */ }
    }
  }
}
