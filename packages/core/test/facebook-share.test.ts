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

  it('returns canonical reel url from share/v 302 redirect', async () => {
    const { resolveFacebookShareUrl } = await import('../src/facebook.js')
    requestMock.mockResolvedValueOnce({
      statusCode: 302,
      headers: {
        location: 'https://www.facebook.com/reel/1602639675108903/?rdid=abc&share_url=https://example.com'
      },
      body: { dump: async () => undefined }
    })

    const result = await resolveFacebookShareUrl('https://www.facebook.com/share/v/1FCHgEUeAu/', '')
    expect(result.finalUrl).toBe('https://www.facebook.com/reel/1602639675108903')
    expect(result.redirectChain).toHaveLength(2)
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it('uses browser-like headers when resolving share links', async () => {
    const { resolveFacebookShareUrl } = await import('../src/facebook.js')
    requestMock.mockResolvedValueOnce({
      statusCode: 302,
      headers: { location: 'https://www.facebook.com/watch?v=123' },
      body: { dump: async () => undefined }
    })

    await resolveFacebookShareUrl('https://www.facebook.com/share/r/abc/', '')
    expect(requestMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'accept-language': 'en-US,en;q=0.9'
    })
  })

  it('follows relative and absolute redirects up to five hops', async () => {
    const { resolveFacebookShareUrl } = await import('../src/facebook.js')
    requestMock.mockResolvedValueOnce({
      statusCode: 302,
      headers: { location: '/watch?v=123' },
      body: { dump: async () => undefined }
    })

    const result = await resolveFacebookShareUrl('https://www.facebook.com/share/r/abc/', '')
    expect(result.finalUrl).toBe('https://www.facebook.com/watch?v=123')
    expect(result.redirectChain).toHaveLength(2)
    expect(requestMock).toHaveBeenCalledTimes(1)
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
