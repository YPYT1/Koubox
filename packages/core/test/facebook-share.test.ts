import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.fn()

vi.mock('undici', () => ({
  ProxyAgent: class ProxyAgent {
    close() { return Promise.resolve() }
  },
  request: (...args: unknown[]) => requestMock(...args)
}))

describe('resolveFacebookShareUrl', () => {
  beforeEach(() => {
    requestMock.mockReset()
  })

  it('follows relative and absolute redirects up to five hops', async () => {
    const { resolveFacebookShareUrl } = await import('../src/facebook.js')
    requestMock
      .mockResolvedValueOnce({
        statusCode: 302,
        headers: { location: '/watch?v=123' },
        body: { dump: async () => undefined }
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: {},
        body: { dump: async () => undefined }
      })

    const result = await resolveFacebookShareUrl('https://www.facebook.com/share/r/abc/', '')
    expect(result.finalUrl).toBe('https://www.facebook.com/watch?v=123')
    expect(result.redirectChain).toHaveLength(2)
  })

  it('detects redirect loops', async () => {
    const { resolveFacebookShareUrl } = await import('../src/facebook.js')
    requestMock.mockResolvedValue({
      statusCode: 302,
      headers: { location: 'https://www.facebook.com/share/r/loop/' },
      body: { dump: async () => undefined }
    })

    await expect(resolveFacebookShareUrl('https://www.facebook.com/share/r/loop/', '')).rejects.toThrow('循环')
  })

  it('reports missing redirect target', async () => {
    const { resolveFacebookShareUrl } = await import('../src/facebook.js')
    requestMock.mockResolvedValue({
      statusCode: 404,
      headers: {},
      body: { dump: async () => undefined }
    })

    await expect(resolveFacebookShareUrl('https://www.facebook.com/share/v/test/', '')).rejects.toThrow('HTTP 404')
  })
})
