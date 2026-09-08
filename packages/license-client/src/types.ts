export type LicenseInvalidCode =
  | 'PAIR_MISMATCH'
  | 'TOKEN_NOT_FOUND'
  | 'API_KEY_NOT_FOUND'
  | 'TOKEN_DISABLED'
  | 'API_KEY_DISABLED'
  | 'TOKEN_REVOKED'
  | 'API_KEY_REVOKED'
  | 'TOKEN_EXPIRED'
  | 'API_KEY_EXPIRED'

export const LICENSE_INVALID_REASON: Record<LicenseInvalidCode, string> = {
  PAIR_MISMATCH: 'Token 与 API Key 不属于同一组授权',
  TOKEN_NOT_FOUND: 'Token 不存在或已被删除',
  API_KEY_NOT_FOUND: 'API Key 不存在或已被删除',
  TOKEN_DISABLED: 'Token 已被停用',
  API_KEY_DISABLED: 'API Key 已被停用',
  TOKEN_REVOKED: 'Token 已被撤销',
  API_KEY_REVOKED: 'API Key 已被撤销',
  TOKEN_EXPIRED: 'Token 已到期',
  API_KEY_EXPIRED: 'API Key 已到期'
}

export type LicenseCredentials = { token: string; apiKey: string }

export type LicenseVerifyResult =
  | { valid: true; tokenId: string; apiKeyId: string; expiresAt: string | null; serverTime: string }
  | { valid: false; code: LicenseInvalidCode; serverTime: string }

export type LicensePhase = 'unverified' | 'valid' | 'network-error' | 'grace' | 'locked'

export type LicenseSnapshot = {
  phase: LicensePhase
  allowed: boolean
  devMode: boolean
  verifyDueAt: string
  lastVerifiedAt: string | null
  graceStartedAt: string | null
  graceEndsAt: string | null
  graceDurationMs: number
  invalidCode: LicenseInvalidCode | null
  packageCredentialVersion: number
  tokenMasked: string
  apiKeyMasked: string
}

export type StoredLicenseState = {
  credentials: LicenseCredentials
  packageCredentialVersion: number
  verifyDueAt: string
  lastAttemptDay: string | null
  lastVerifiedAt: string | null
  graceStartedAt: string | null
  graceEndsAt: string | null
  invalidCode: LicenseInvalidCode | null
}

export interface LicenseStore {
  load(): Promise<StoredLicenseState | undefined>
  save(state: StoredLicenseState): Promise<void>
}

export interface LicenseTransport {
  verify(credentials: LicenseCredentials): Promise<LicenseVerifyResult>
}

export type LicenseDevScenario = 'valid' | 'network-error' | LicenseInvalidCode | 'grace-expired'

export type LicenseControllerOptions = {
  store: LicenseStore
  transport: LicenseTransport
  packageCredentials: LicenseCredentials
  packageCredentialVersion: number
  devMode?: boolean
  graceDurationMs?: number
  now?: () => Date
  random?: () => number
  onLocked?: () => void | Promise<void>
}
