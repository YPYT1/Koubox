import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LicenseCredentials, LicenseInvalidCode, LicenseStore, StoredLicenseState } from './types.js'

export type EncryptionAdapter = {
  isAvailable(): boolean
  encrypt(value: string): Uint8Array
  decrypt(value: Uint8Array): string
}

type DiskState = Omit<StoredLicenseState, 'credentials'> & {
  schemaVersion: 1
  tokenCiphertext: string
  apiKeyCiphertext: string
}

export class SecureFileLicenseStore implements LicenseStore {
  constructor(private readonly filePath: string, private readonly encryption: EncryptionAdapter) {}

  async load(): Promise<StoredLicenseState | undefined> {
    if (!existsSync(this.filePath)) return undefined
    this.assertEncryption()
    const disk = JSON.parse(readFileSync(this.filePath, 'utf8')) as DiskState
    if (disk.schemaVersion !== 1) throw new Error('授权状态版本不受支持。')
    return {
      credentials: {
        token: this.encryption.decrypt(Buffer.from(disk.tokenCiphertext, 'base64')),
        apiKey: this.encryption.decrypt(Buffer.from(disk.apiKeyCiphertext, 'base64'))
      },
      packageCredentialVersion: disk.packageCredentialVersion,
      verifyDueAt: disk.verifyDueAt,
      lastAttemptDay: disk.lastAttemptDay,
      lastVerifiedAt: disk.lastVerifiedAt,
      graceStartedAt: disk.graceStartedAt,
      graceEndsAt: disk.graceEndsAt,
      invalidCode: disk.invalidCode as LicenseInvalidCode | null
    }
  }

  async save(state: StoredLicenseState): Promise<void> {
    this.assertEncryption()
    mkdirSync(dirname(this.filePath), { recursive: true })
    const disk: DiskState = {
      schemaVersion: 1,
      tokenCiphertext: Buffer.from(this.encryption.encrypt(state.credentials.token)).toString('base64'),
      apiKeyCiphertext: Buffer.from(this.encryption.encrypt(state.credentials.apiKey)).toString('base64'),
      packageCredentialVersion: state.packageCredentialVersion,
      verifyDueAt: state.verifyDueAt,
      lastAttemptDay: state.lastAttemptDay,
      lastVerifiedAt: state.lastVerifiedAt,
      graceStartedAt: state.graceStartedAt,
      graceEndsAt: state.graceEndsAt,
      invalidCode: state.invalidCode
    }
    const temporary = `${this.filePath}.tmp`
    writeFileSync(temporary, JSON.stringify(disk, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.filePath)
  }

  private assertEncryption(): void {
    if (!this.encryption.isAvailable()) throw new Error('Windows 凭据加密当前不可用，授权状态不会以明文保存。')
  }
}

export function assertCredentials(value: unknown): LicenseCredentials {
  if (!value || typeof value !== 'object') throw new Error('包内授权凭据配置无效。')
  const record = value as Partial<LicenseCredentials>
  if (!record.token?.trim() || !record.apiKey?.trim()) throw new Error('包内授权凭据不完整。')
  return { token: record.token.trim(), apiKey: record.apiKey.trim() }
}
