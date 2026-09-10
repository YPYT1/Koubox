import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CopyLibraryStore } from '../src/copy-library.js'
import { sendCopyPayload } from '../src/lan-share/client.js'
import { LanShareService } from '../src/lan-share/session.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('LAN copy protocol', () => {
  const deviceFor = (service: LanShareService) => ({
    id: service.identity.deviceId,
    alias: service.identity.alias,
    host: '127.0.0.1',
    port: service.getPort(),
    fingerprint: service.identity.fingerprint,
    online: true,
    lastSeenAt: new Date().toISOString()
  })

  it('auto-saves a JSON copy payload and rejects invalid sessions', async () => {
    const a = mkdtempSync(join(tmpdir(), 'koubox-lan-a-')); const b = mkdtempSync(join(tmpdir(), 'koubox-lan-b-')); roots.push(a, b)
    const libraryA = await CopyLibraryStore.open(join(a, 'library.db'), join(a, 'backups'))
    const libraryB = await CopyLibraryStore.open(join(b, 'library.db'), join(b, 'backups'))
    const sender = await LanShareService.create(a, 0, 'A', libraryA, () => ({ lanAutoSave: false, lanHistoryEnabled: false, lanSaveDirectory: join(a, 'share') }))
    const receiver = await LanShareService.create(b, 0, 'B', libraryB, () => ({ lanAutoSave: true, lanHistoryEnabled: false, lanSaveDirectory: join(b, 'share') }))
    sender.start(); receiver.start(); await new Promise((resolve) => setTimeout(resolve, 40))
    const payload = { protocol: 'koubox-copy-library' as const, version: 1 as const, sender: { alias: sender.identity.alias, deviceId: sender.identity.deviceId }, entries: [{ id: 'e1', title: 'Hello', content: 'Hello LAN', kind: 'original' as const, tags: [] }] }
    await expect(sendCopyPayload({ ...deviceFor(receiver), fingerprint: '00' }, payload, randomUUID())).rejects.toThrow(/证书指纹不匹配/)
    expect(libraryB.list()).toHaveLength(0)
    await expect(sendCopyPayload(deviceFor(receiver), payload, 'invalid-session')).rejects.toThrow(/会话令牌无效/)
    const result = await sender.send(payload, [deviceFor(receiver)])
    expect(result[0]?.status).toBe('complete')
    expect(libraryB.list()).toHaveLength(1)
    expect(libraryA.listHistory()).toHaveLength(0)
    expect(libraryB.listHistory()).toHaveLength(0)
    sender.stop(); receiver.stop()
  })

  it('keeps manual accept and reject isolated per transfer', async () => {
    const a = mkdtempSync(join(tmpdir(), 'koubox-lan-manual-a-')); const b = mkdtempSync(join(tmpdir(), 'koubox-lan-manual-b-')); roots.push(a, b)
    const libraryA = await CopyLibraryStore.open(join(a, 'library.db'), join(a, 'backups'))
    const libraryB = await CopyLibraryStore.open(join(b, 'library.db'), join(b, 'backups'))
    const sender = await LanShareService.create(a, 0, 'A', libraryA, () => ({ lanAutoSave: false, lanHistoryEnabled: true, lanSaveDirectory: join(a, 'share') }))
    const receiver = await LanShareService.create(b, 0, 'B', libraryB, () => ({ lanAutoSave: false, lanHistoryEnabled: true, lanSaveDirectory: join(b, 'share') }))
    sender.start(); receiver.start(); await new Promise((resolve) => setTimeout(resolve, 40))
    const payload = (id: string, content: string) => ({ protocol: 'koubox-copy-library' as const, version: 1 as const, sender: { alias: sender.identity.alias, deviceId: sender.identity.deviceId }, entries: [{ id, title: id, content, kind: 'original' as const, tags: [] }] })
    const waiting = await sender.send(payload('accept', 'manual accept'), [deviceFor(receiver)])
    expect(waiting[0]?.status).toBe('waiting')
    const incoming = receiver.listIncoming()[0]
    expect(incoming?.names).toEqual(['accept'])
    expect(receiver.decideIncoming(incoming.id, true)?.status).toBe('complete')
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    expect(sender.listTransfers()[0]?.status).toBe('complete')
    expect(libraryB.list()).toHaveLength(1)
    expect(libraryA.listHistory()).toHaveLength(1)
    expect(libraryB.listHistory()).toHaveLength(1)

    const rejected = await sender.send(payload('reject', 'manual reject'), [deviceFor(receiver)])
    expect(rejected[0]?.status).toBe('waiting')
    const nextIncoming = receiver.listIncoming()[0]
    expect(receiver.decideIncoming(nextIncoming.id, false)?.status).toBe('rejected')
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    expect(sender.listTransfers().find((item) => item.entries.includes('reject'))?.status).toBe('rejected')
    expect(libraryB.list()).toHaveLength(1)
    sender.stop(); receiver.stop()
  })

  it('sends to multiple receivers and cancels a pending receiver', async () => {
    const a = mkdtempSync(join(tmpdir(), 'koubox-lan-multi-a-')); const b = mkdtempSync(join(tmpdir(), 'koubox-lan-multi-b-')); const c = mkdtempSync(join(tmpdir(), 'koubox-lan-multi-c-')); roots.push(a, b, c)
    const libraryA = await CopyLibraryStore.open(join(a, 'library.db'), join(a, 'backups'))
    const libraryB = await CopyLibraryStore.open(join(b, 'library.db'), join(b, 'backups'))
    const libraryC = await CopyLibraryStore.open(join(c, 'library.db'), join(c, 'backups'))
    const sender = await LanShareService.create(a, 0, 'A', libraryA, () => ({ lanAutoSave: false, lanHistoryEnabled: true, lanSaveDirectory: join(a, 'share') }))
    const receiverB = await LanShareService.create(b, 0, 'B', libraryB, () => ({ lanAutoSave: true, lanHistoryEnabled: true, lanSaveDirectory: join(b, 'share') }))
    const receiverC = await LanShareService.create(c, 0, 'C', libraryC, () => ({ lanAutoSave: true, lanHistoryEnabled: true, lanSaveDirectory: join(c, 'share') }))
    sender.start(); receiverB.start(); receiverC.start(); await new Promise((resolve) => setTimeout(resolve, 40))
    const payload = { protocol: 'koubox-copy-library' as const, version: 1 as const, sender: { alias: sender.identity.alias, deviceId: sender.identity.deviceId }, entries: [{ id: 'multi', title: 'Multi', content: 'Hello many', kind: 'original' as const, tags: [] }] }
    const results = await sender.send(payload, [deviceFor(receiverB), deviceFor(receiverC)])
    expect(results).toHaveLength(2)
    expect(results.every((item) => item.status === 'complete')).toBe(true)
    expect(libraryB.list()).toHaveLength(1)
    expect(libraryC.list()).toHaveLength(1)

    const manual = await LanShareService.create(c, 0, 'C-manual', libraryC, () => ({ lanAutoSave: false, lanHistoryEnabled: true, lanSaveDirectory: join(c, 'share') }))
    manual.start(); await new Promise((resolve) => setTimeout(resolve, 40))
    const pending = await sender.send({ ...payload, entries: [{ ...payload.entries[0], id: 'cancel', content: 'Cancel me' }] }, [deviceFor(manual)])
    expect(pending[0]?.status).toBe('waiting')
    expect((await sender.cancel(pending[0]!.id))?.status).toBe('cancelled')
    expect(manual.listIncoming()).toHaveLength(0)
    manual.stop(); sender.stop(); receiverB.stop(); receiverC.stop()
  })

  it('keeps the app alive when the configured HTTPS port is already occupied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-lan-conflict-')); roots.push(root)
    const library = await CopyLibraryStore.open(join(root, 'library.db'), join(root, 'backups'))
    const blocker = createServer()
    await new Promise<void>((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '0.0.0.0', resolve) })
    const occupiedPort = (blocker.address() as { port: number }).port
    const service = await LanShareService.create(root, occupiedPort, 'conflict', library, () => ({ lanAutoSave: true, lanHistoryEnabled: false, lanSaveDirectory: join(root, 'share') }))
    service.start()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(service.getPort()).toBeGreaterThan(0)
    expect(service.getPort()).not.toBe(occupiedPort)
    expect(service.getError()).toBeUndefined()
    service.stop()
    await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()))
  })
})
