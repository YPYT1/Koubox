import dgram from 'node:dgram'
import type { LanDevice } from '@koubox/shared'
import type { LanIdentity } from './identity.js'

export const LAN_MULTICAST_ADDRESS = '224.0.0.167'
export const LAN_DISCOVERY_PORT = 53318
type DiscoveryMessage = { protocol: 'koubox-copy-library'; version: 1; alias: string; deviceId: string; port: number; fingerprint: string }

export class LanDiscovery {
  private readonly devices = new Map<string, LanDevice>()
  private socket?: dgram.Socket
  private announceTimer?: NodeJS.Timeout
  private started = false
  private error?: string
  constructor(private readonly identity: LanIdentity, private readonly port: number | (() => number)) {}
  start(onDevice?: (device: LanDevice) => void, onError?: (error: Error) => void): void {
    if (this.socket) return
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('error', (error) => {
      this.started = false
      this.error = error.message
      onError?.(error)
      socket.close()
      if (this.socket === socket) this.socket = undefined
    })
    socket.on('message', (data, remote) => {
      try {
        const message = JSON.parse(data.toString()) as DiscoveryMessage
        if (message.protocol !== 'koubox-copy-library' || message.version !== 1 || message.deviceId === this.identity.deviceId) return
        const device: LanDevice = { id: message.deviceId, alias: message.alias, host: remote.address, port: message.port, fingerprint: message.fingerprint, online: true, lastSeenAt: new Date().toISOString() }
        this.devices.set(device.id, device); onDevice?.(device)
      } catch { /* ignore malformed UDP */ }
    })
    socket.bind(LAN_DISCOVERY_PORT, '0.0.0.0', () => {
      try { socket.addMembership(LAN_MULTICAST_ADDRESS) } catch { /* network may disable multicast */ }
      this.started = true
      this.announce()
      this.announceTimer = setInterval(() => this.announce(), 3000)
    })
  }
  announce(): void {
    if (!this.socket || !this.started) return
    const message: DiscoveryMessage = { protocol: 'koubox-copy-library', version: 1, alias: this.identity.alias, deviceId: this.identity.deviceId, port: typeof this.port === 'function' ? this.port() : this.port, fingerprint: this.identity.fingerprint }
    const data = Buffer.from(JSON.stringify(message))
    this.socket.send(data, LAN_DISCOVERY_PORT, LAN_MULTICAST_ADDRESS)
  }
  list(): LanDevice[] {
    const now = Date.now()
    return [...this.devices.values()]
      .map((device) => ({ ...device, online: now - Date.parse(device.lastSeenAt) < 10000 }))
      .sort((a, b) => a.alias.localeCompare(b.alias))
  }
  getError(): string | undefined { return this.error }
  close(): void { if (this.announceTimer) clearInterval(this.announceTimer); this.announceTimer = undefined; this.started = false; this.socket?.close(); this.socket = undefined }
}
