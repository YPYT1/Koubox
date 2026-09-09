import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import selfsigned from 'selfsigned'

export type LanIdentity = {
  deviceId: string
  alias: string
  certificate: string
  privateKey: string
  fingerprint: string
}

function fingerprint(certificate: string): string {
  const der = Buffer.from(certificate.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
  return createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g)?.join(':') ?? ''
}

export async function loadOrCreateLanIdentity(directory: string, alias: string): Promise<LanIdentity> {
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'identity.json')
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LanIdentity>
    if (parsed.deviceId && parsed.certificate && parsed.privateKey && parsed.fingerprint) {
      return { deviceId: parsed.deviceId, alias: alias || parsed.alias || '口播匣', certificate: parsed.certificate, privateKey: parsed.privateKey, fingerprint: parsed.fingerprint }
    }
  }
  const keys = selfsigned.generate([{ name: 'commonName', value: 'koubox-lan' }], { days: 3650, keySize: 2048, algorithm: 'sha256' })
  const identity: LanIdentity = {
    deviceId: randomUUID(), alias: alias || '口播匣', certificate: keys.cert, privateKey: keys.private, fingerprint: fingerprint(keys.cert)
  }
  writeFileSync(file, JSON.stringify(identity, null, 2), 'utf8')
  return identity
}
