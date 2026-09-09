import { randomUUID } from 'node:crypto'
import type { LanTransfer, LanTransferStatus } from '@koubox/shared'

export class LanTransferStore {
  private readonly transfers = new Map<string, LanTransfer>()
  create(input: Pick<LanTransfer, 'direction' | 'peerId' | 'peerAlias' | 'entries' | 'bytesTotal'> & Partial<Pick<LanTransfer, 'status'>> & { id?: string }): LanTransfer {
    const now = new Date().toISOString()
    const transfer: LanTransfer = { id: input.id ?? randomUUID(), direction: input.direction, peerId: input.peerId, peerAlias: input.peerAlias, status: input.status ?? 'waiting', entries: input.entries, bytesTotal: input.bytesTotal, bytesTransferred: 0, percent: 0, createdAt: now, updatedAt: now }
    this.transfers.set(transfer.id, transfer)
    return structuredClone(transfer)
  }
  update(id: string, patch: Partial<Pick<LanTransfer, 'status' | 'bytesTransferred' | 'percent' | 'error'>>): LanTransfer | undefined {
    const current = this.transfers.get(id); if (!current) return undefined
    Object.assign(current, patch, { updatedAt: new Date().toISOString() }); return structuredClone(current)
  }
  get(id: string): LanTransfer | undefined { const value = this.transfers.get(id); return value ? structuredClone(value) : undefined }
  list(): LanTransfer[] { return [...this.transfers.values()].map((value) => structuredClone(value)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }
  cancel(id: string): LanTransfer | undefined { return this.update(id, { status: 'cancelled' }) }
}
