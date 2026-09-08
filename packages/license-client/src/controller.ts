import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'
import type {
  LicenseControllerOptions,
  LicenseCredentials,
  LicenseDevScenario,
  LicenseInvalidCode,
  LicenseSnapshot,
  LicenseStore,
  LicenseTransport,
  StoredLicenseState
} from './types.js'

const DEFAULT_GRACE_MS = 2 * 60 * 60 * 1000

function localDay(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function dailyVerifyTime(date: Date, random: () => number): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 1, Math.floor(random() * 60), 0, 0)
  return result
}

function nextDayVerifyTime(date: Date, random: () => number): Date {
  const tomorrow = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0)
  return dailyVerifyTime(tomorrow, random)
}

function mask(value: string): string {
  const parts = value.split('-')
  return parts.length > 3 ? `${parts.slice(0, 2).join('-')}-••••-${parts.at(-1)}` : '••••'
}

export class LicenseCredentialError extends Error {
  constructor(readonly code: LicenseInvalidCode) {
    super({
      PAIR_MISMATCH: 'Token 和 API Key 不是同一组。请从同一条授权记录中重新复制这两项。',
      TOKEN_NOT_FOUND: '这个 Token 无效或已删除。请检查是否完整复制，并确认它和 API Key 来自同一条授权记录。',
      API_KEY_NOT_FOUND: '这个 API Key 无效或已删除。请检查是否完整复制，并确认它和 Token 来自同一条授权记录。',
      TOKEN_DISABLED: '这个 Token 已停用。请在授权管理后台启用它，或输入一组新的有效凭据。',
      API_KEY_DISABLED: '这个 API Key 已停用。请在授权管理后台启用它，或输入一组新的有效凭据。',
      TOKEN_REVOKED: '这个 Token 已撤销，不能再使用。请在授权管理后台创建并输入一组新凭据。',
      API_KEY_REVOKED: '这个 API Key 已撤销，不能再使用。请在授权管理后台创建并输入一组新凭据。',
      TOKEN_EXPIRED: '这个 Token 已过期。请在授权管理后台续期后，再输入同一组凭据。',
      API_KEY_EXPIRED: '这个 API Key 已过期。请在授权管理后台续期后，再输入同一组凭据。'
    }[code])
  }
}

export class LicenseLockedError extends Error {
  constructor() { super('授权宽限已结束，任务、下载、处理和导出已锁定。') }
}

export class HttpLicenseTransport implements LicenseTransport {
  private readonly dispatcher = hasEnvironmentProxy() ? new EnvHttpProxyAgent() : undefined

  constructor(private readonly apiUrl: string, private readonly timeoutMs = 15_000) {}

  async verify(credentials: LicenseCredentials) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await undiciFetch(`${this.apiUrl.replace(/\/$/, '')}/api/license/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
        signal: controller.signal,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {})
      })
      if (!response.ok) throw new Error(`授权服务 HTTP ${response.status}`)
      const payload = await response.json() as unknown
      if (!payload || typeof payload !== 'object' || typeof (payload as { valid?: unknown }).valid !== 'boolean') {
        throw new Error('授权服务返回了无效数据。')
      }
      return payload as Awaited<ReturnType<LicenseTransport['verify']>>
    } finally {
      clearTimeout(timer)
    }
  }
}

function hasEnvironmentProxy(): boolean {
  return Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy)
}

export class MemoryLicenseStore implements LicenseStore {
  constructor(private state?: StoredLicenseState) {}
  async load() { return this.state ? structuredClone(this.state) : undefined }
  async save(state: StoredLicenseState) { this.state = structuredClone(state) }
}

export class LicenseController {
  private state!: StoredLicenseState
  private snapshotValue!: LicenseSnapshot
  private readonly listeners = new Set<(snapshot: LicenseSnapshot) => void>()
  private timer?: ReturnType<typeof setTimeout>
  private verifying?: Promise<LicenseSnapshot>
  private lockedNotified = false

  constructor(private readonly options: LicenseControllerOptions) {}

  async initialize(): Promise<LicenseSnapshot> {
    const loaded = await this.options.store.load()
    const now = this.now()
    if (!loaded || loaded.packageCredentialVersion !== this.options.packageCredentialVersion) {
      this.state = {
        credentials: structuredClone(this.options.packageCredentials),
        packageCredentialVersion: this.options.packageCredentialVersion,
        verifyDueAt: dailyVerifyTime(now, this.random()).toISOString(),
        lastAttemptDay: null,
        lastVerifiedAt: null,
        graceStartedAt: null,
        graceEndsAt: null,
        invalidCode: null
      }
      await this.persist()
    } else {
      this.state = loaded
    }
    // 如果已经错过验证时间（如电脑休眠期间），在启动时立即验证，无论之前是什么状态
    // 唯一例外：如果当天已经尝试过但网络失败，推迟到明天避免无限重试循环
    const missedVerifyTime = now.getTime() >= Date.parse(this.state.verifyDueAt)
    const alreadyTriedToday = this.state.lastAttemptDay === localDay(now)
    if (missedVerifyTime && alreadyTriedToday && this.phase() === 'network-error') {
      this.state.verifyDueAt = nextDayVerifyTime(now, this.random()).toISOString()
      await this.persist()
    }
    await this.refreshSnapshot()
    this.schedule()
    // 启动时，如果错过了验证时间且当天未尝试过，立即验证（处理休眠场景）
    if (missedVerifyTime && !alreadyTriedToday && this.phase() !== 'locked') void this.verifyNow()
    return this.getSnapshot()
  }

  getSnapshot(): LicenseSnapshot {
    return structuredClone(this.snapshotValue)
  }

  subscribe(listener: (snapshot: LicenseSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  assertAllowed(): void {
    if (this.phase() === 'locked') throw new LicenseLockedError()
  }

  verifyNow(): Promise<LicenseSnapshot> {
    this.verifying ??= this.performVerify(this.state.credentials).finally(() => { this.verifying = undefined })
    return this.verifying
  }

  async replaceCredentials(patch: Partial<LicenseCredentials>): Promise<LicenseSnapshot> {
    const candidate = {
      token: patch.token?.trim() || this.state.credentials.token,
      apiKey: patch.apiKey?.trim() || this.state.credentials.apiKey
    }
    const result = await this.options.transport.verify(candidate)
    if (!result.valid) throw new LicenseCredentialError(result.code)
    this.state.credentials = candidate
    await this.applyValid(result.serverTime)
    return this.getSnapshot()
  }

  async simulate(scenario: LicenseDevScenario): Promise<LicenseSnapshot> {
    if (!this.options.devMode) throw new Error('授权开发模式未启用。')
    if (scenario === 'network-error') {
      this.state.lastVerifiedAt = null
      this.state.lastAttemptDay = localDay(this.now())
      this.state.graceStartedAt = null
      this.state.graceEndsAt = null
      this.state.invalidCode = null
      this.state.verifyDueAt = nextDayVerifyTime(this.now(), this.random()).toISOString()
      await this.persistAndNotify()
      return this.getSnapshot()
    }
    if (scenario === 'valid') {
      await this.applyValid(this.now().toISOString())
      return this.getSnapshot()
    }
    if (scenario === 'grace-expired') {
      this.state.graceStartedAt = new Date(this.now().getTime() - this.graceMs() - 1000).toISOString()
      this.state.graceEndsAt = new Date(this.now().getTime() - 1000).toISOString()
      this.state.invalidCode ??= 'API_KEY_EXPIRED'
      await this.persistAndNotify()
      return this.getSnapshot()
    }
    // Development simulations must be repeatable: each explicit expiry starts a fresh full grace window.
    this.state.lastAttemptDay = localDay(this.now())
    this.state.lastVerifiedAt = null
    this.state.invalidCode = scenario
    this.state.graceStartedAt = this.now().toISOString()
    this.state.graceEndsAt = new Date(this.now().getTime() + this.graceMs()).toISOString()
    await this.persistAndNotify()
    return this.getSnapshot()
  }

  async resetToPackage(): Promise<LicenseSnapshot> {
    if (!this.options.devMode) throw new Error('授权开发模式未启用。')
    const now = this.now()
    this.state = {
      credentials: structuredClone(this.options.packageCredentials),
      packageCredentialVersion: this.options.packageCredentialVersion,
      verifyDueAt: dailyVerifyTime(now, this.random()).toISOString(),
      lastAttemptDay: null,
      lastVerifiedAt: null,
      graceStartedAt: null,
      graceEndsAt: null,
      invalidCode: null
    }
    await this.persistAndNotify()
    return this.getSnapshot()
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.listeners.clear()
  }

  private now(): Date { return this.options.now?.() ?? new Date() }
  private random(): () => number { return this.options.random ?? Math.random }
  private graceMs(): number { return this.options.graceDurationMs ?? DEFAULT_GRACE_MS }

  private phase(): LicenseSnapshot['phase'] {
    const now = this.now().getTime()
    if (this.state.graceEndsAt && now >= Date.parse(this.state.graceEndsAt)) return 'locked'
    if (this.state.graceStartedAt) return 'grace'
    if (this.state.lastVerifiedAt) return 'valid'
    if (this.state.lastAttemptDay === localDay(this.now())) return 'network-error'
    return 'unverified'
  }

  private async performVerify(credentials: LicenseCredentials): Promise<LicenseSnapshot> {
    try {
      const result = await this.options.transport.verify(credentials)
      if (result.valid) await this.applyValid(result.serverTime)
      else await this.applyInvalid(result.code, result.serverTime)
    } catch {
      this.state.lastAttemptDay = localDay(this.now())
      this.state.verifyDueAt = nextDayVerifyTime(this.now(), this.random()).toISOString()
      await this.persistAndNotify()
    }
    return this.getSnapshot()
  }

  private async applyValid(serverTime: string): Promise<void> {
    const verifiedAt = new Date(serverTime)
    if (Number.isNaN(verifiedAt.getTime())) throw new Error('授权服务返回的时间无效。')
    this.state.lastAttemptDay = localDay(this.now())
    this.state.lastVerifiedAt = verifiedAt.toISOString()
    this.state.graceStartedAt = null
    this.state.graceEndsAt = null
    this.state.invalidCode = null
    this.state.verifyDueAt = nextDayVerifyTime(this.now(), this.random()).toISOString()
    this.lockedNotified = false
    await this.persistAndNotify()
  }

  private async applyInvalid(code: LicenseInvalidCode, serverTime: string): Promise<void> {
    const reportedAt = new Date(serverTime)
    if (Number.isNaN(reportedAt.getTime())) throw new Error('授权服务返回的时间无效。')
    this.state.lastAttemptDay = localDay(this.now())
    this.state.invalidCode = code
    if (!this.state.graceStartedAt || !this.state.graceEndsAt) {
      this.state.graceStartedAt = reportedAt.toISOString()
      this.state.graceEndsAt = new Date(reportedAt.getTime() + this.graceMs()).toISOString()
    }
    await this.persistAndNotify()
  }

  private async persist(): Promise<void> {
    await this.options.store.save(this.state)
  }

  private async persistAndNotify(): Promise<void> {
    await this.persist()
    await this.refreshSnapshot()
    this.schedule()
  }

  private async refreshSnapshot(): Promise<void> {
    const phase = this.phase()
    this.snapshotValue = {
      phase,
      allowed: phase !== 'locked',
      devMode: Boolean(this.options.devMode),
      verifyDueAt: this.state.verifyDueAt,
      lastVerifiedAt: this.state.lastVerifiedAt,
      graceStartedAt: this.state.graceStartedAt,
      graceEndsAt: this.state.graceEndsAt,
      graceDurationMs: this.graceMs(),
      invalidCode: this.state.invalidCode,
      packageCredentialVersion: this.state.packageCredentialVersion,
      tokenMasked: mask(this.state.credentials.token),
      apiKeyMasked: mask(this.state.credentials.apiKey)
    }
    for (const listener of this.listeners) listener(this.getSnapshot())
    if (phase === 'locked' && !this.lockedNotified) {
      this.lockedNotified = true
      await this.options.onLocked?.()
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    const phase = this.phase()
    if (phase === 'locked') {
      this.timer = undefined
      return
    }
    const nextAt = phase === 'grace' && this.state.graceEndsAt ? this.state.graceEndsAt : this.state.verifyDueAt
    const wait = Math.max(0, Math.min(Date.parse(nextAt) - this.now().getTime(), 2_147_000_000))
    this.timer = setTimeout(() => {
      const nextPhase = this.phase()
      if (nextPhase === 'grace') void this.refreshSnapshot().then(() => this.schedule())
      else if (nextPhase === 'locked') void this.refreshSnapshot()
      else void this.verifyNow()
    }, wait)
  }
}
