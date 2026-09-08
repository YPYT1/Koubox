import { describe, expect, it, vi } from 'vitest'
import { LicenseController, LicenseCredentialError, MemoryLicenseStore, dailyVerifyTime } from '../src/index.js'
import type { LicenseCredentials, LicenseTransport } from '../src/types.js'

const valid: LicenseCredentials = { token: 'KB-TKN-DEV2-TEST-AAAA', apiKey: 'KB-KEY-DEV2-TEST-AAAA-BBBB-CCCC' }

function transport(result: Awaited<ReturnType<LicenseTransport['verify']>> | Error): LicenseTransport {
  return { verify: vi.fn(async () => { if (result instanceof Error) throw result; return result }) }
}

describe('LicenseController', () => {
  it('schedules a deterministic local-time check between 01:00 and 02:00', () => {
    const due = dailyVerifyTime(new Date(2026, 8, 4, 0, 1), () => 0.5)
    expect(due.getHours()).toBe(1)
    expect(due.getMinutes()).toBe(30)
  })

  it('enters grace on explicit expiry, locks without extending it, then accepts a correct replacement', async () => {
    let now = new Date('2026-09-04T01:30:00+08:00')
    let result: Awaited<ReturnType<LicenseTransport['verify']>> = { valid: false, code: 'API_KEY_EXPIRED', serverTime: now.toISOString() }
    const adapter: LicenseTransport = { verify: vi.fn(async () => result) }
    const locked = vi.fn()
    const controller = new LicenseController({
      store: new MemoryLicenseStore(), transport: adapter, packageCredentials: valid, packageCredentialVersion: 1,
      now: () => now, random: () => 0.5, graceDurationMs: 1000, onLocked: locked
    })
    await controller.initialize()
    await controller.verifyNow()
    const graceEnd = controller.getSnapshot().graceEndsAt
    expect(controller.getSnapshot().phase).toBe('grace')
    now = new Date(now.getTime() + 500)
    await controller.verifyNow()
    expect(controller.getSnapshot().graceEndsAt).toBe(graceEnd)
    now = new Date(now.getTime() + 600)
    expect(() => controller.assertAllowed()).toThrow('授权宽限已结束')
    result = { valid: true, tokenId: 'tok', apiKeyId: 'key', expiresAt: null, serverTime: now.toISOString() }
    await controller.replaceCredentials(valid)
    expect(controller.getSnapshot().phase).toBe('valid')
    expect(controller.getSnapshot().allowed).toBe(true)
    controller.dispose()
  })

  it('keeps using the software on network failure', async () => {
    const adapter = transport(new Error('offline'))
    const controller = new LicenseController({
      store: new MemoryLicenseStore(), transport: adapter, packageCredentials: valid, packageCredentialVersion: 1,
      now: () => new Date('2026-09-07T10:00:00+08:00'), random: () => 0.5
    })
    await controller.initialize()
    await controller.verifyNow()
    expect(controller.getSnapshot()).toMatchObject({ phase: 'network-error', allowed: true })
    expect(Date.parse(controller.getSnapshot().verifyDueAt)).toBe(new Date('2026-09-08T01:30:00+08:00').getTime())
    expect(adapter.verify).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('does not retry a same-day network failure in a zero-delay loop after restart', async () => {
    const now = new Date('2026-09-07T10:00:00+08:00')
    const adapter = transport(new Error('offline'))
    const store = new MemoryLicenseStore({
      credentials: valid,
      packageCredentialVersion: 1,
      verifyDueAt: '2026-09-07T01:30:00.000+08:00',
      lastAttemptDay: '2026-09-07',
      lastVerifiedAt: null,
      graceStartedAt: null,
      graceEndsAt: null,
      invalidCode: null
    })
    const controller = new LicenseController({ store, transport: adapter, packageCredentials: valid, packageCredentialVersion: 1, now: () => now, random: () => 0.5 })
    await controller.initialize()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(adapter.verify).toHaveBeenCalledTimes(0)
    expect(controller.getSnapshot().phase).toBe('network-error')
    controller.dispose()
  })

  it('retries verification on next-day startup when the scheduled time was missed during sleep', async () => {
    const now = new Date('2026-09-08T08:00:00+08:00')
    const result: Awaited<ReturnType<LicenseTransport['verify']>> = { valid: true, tokenId: 'tok', apiKeyId: 'key', expiresAt: null, serverTime: now.toISOString() }
    const adapter: LicenseTransport = { verify: vi.fn(async () => result) }
    const store = new MemoryLicenseStore({
      credentials: valid,
      packageCredentialVersion: 1,
      verifyDueAt: '2026-09-07T01:30:00.000+08:00',
      lastAttemptDay: null,
      lastVerifiedAt: '2026-09-06T01:30:00.000+08:00',
      graceStartedAt: null,
      graceEndsAt: null,
      invalidCode: null
    })
    const controller = new LicenseController({ store, transport: adapter, packageCredentials: valid, packageCredentialVersion: 1, now: () => now, random: () => 0.5 })
    await controller.initialize()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(adapter.verify).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().phase).toBe('valid')
    controller.dispose()
  })

  it('does not replace existing credentials when the candidate pair is invalid', async () => {
    const controller = new LicenseController({
      store: new MemoryLicenseStore(), transport: transport({ valid: false, code: 'PAIR_MISMATCH', serverTime: new Date().toISOString() }),
      packageCredentials: valid, packageCredentialVersion: 1
    })
    await controller.initialize()
    await expect(controller.replaceCredentials({ token: 'KB-TKN-AAAA-BBBB-CCCC' })).rejects.toBeInstanceOf(LicenseCredentialError)
    expect(new LicenseCredentialError('TOKEN_NOT_FOUND').message).toBe('这个 Token 无效或已删除。请检查是否完整复制，并确认它和 API Key 来自同一条授权记录。')
    expect(controller.getSnapshot().tokenMasked).toContain('AAAA')
    controller.dispose()
  })

  it('development mode can force an expired grace and reset the package pair', async () => {
    let now = new Date('2026-09-04T01:30:00+08:00')
    const controller = new LicenseController({
      store: new MemoryLicenseStore(), transport: transport(new Error('unused')), packageCredentials: valid,
      packageCredentialVersion: 2, devMode: true, now: () => now
    })
    await controller.initialize()
    await controller.simulate('API_KEY_EXPIRED')
    expect(controller.getSnapshot()).toMatchObject({ phase: 'grace', graceDurationMs: 2 * 60 * 60 * 1000 })
    expect(Date.parse(controller.getSnapshot().graceEndsAt!)).toBe(now.getTime() + 2 * 60 * 60 * 1000)
    await controller.simulate('grace-expired')
    expect(controller.getSnapshot().phase).toBe('locked')
    now = new Date(now.getTime() + 60_000)
    await controller.simulate('API_KEY_EXPIRED')
    expect(controller.getSnapshot().phase).toBe('grace')
    expect(Date.parse(controller.getSnapshot().graceEndsAt!)).toBe(now.getTime() + 2 * 60 * 60 * 1000)
    await controller.simulate('grace-expired')
    expect(controller.getSnapshot().phase).toBe('locked')
    await controller.simulate('valid')
    expect(controller.getSnapshot()).toMatchObject({ phase: 'valid', allowed: true })
    await controller.resetToPackage()
    expect(controller.getSnapshot().phase).toBe('unverified')
    controller.dispose()
  })
})
