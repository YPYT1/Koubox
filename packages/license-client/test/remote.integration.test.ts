import { describe, expect, it } from 'vitest'
import { HttpLicenseTransport, LicenseController, MemoryLicenseStore } from '../src/index.js'

const apiUrl = process.env.KOUBOX_LICENSE_INTEGRATION_URL
const token = process.env.KOUBOX_LICENSE_INTEGRATION_TOKEN
const apiKey = process.env.KOUBOX_LICENSE_INTEGRATION_API_KEY
const enabled = Boolean(apiUrl && token && apiKey)

describe.runIf(enabled)('remote license integration', () => {
  it('accepts the permanent pair and rejects a non-existent API key', async () => {
    const transport = new HttpLicenseTransport(apiUrl!)
    const controller = new LicenseController({
      store: new MemoryLicenseStore(),
      transport,
      packageCredentials: { token: token!, apiKey: apiKey! },
      packageCredentialVersion: 1
    })
    await controller.initialize()
    await controller.verifyNow()
    expect(controller.getSnapshot()).toMatchObject({ phase: 'valid', allowed: true })

    const invalidApiKey = `${apiKey!.slice(0, -1)}${apiKey!.endsWith('A') ? 'B' : 'A'}`
    await expect(transport.verify({ token: token!, apiKey: invalidApiKey }))
      .resolves.toMatchObject({ valid: false, code: 'API_KEY_NOT_FOUND' })
    controller.dispose()
  }, 20_000)
})
