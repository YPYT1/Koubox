import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { normalizeProxyUrl } from '@koubox/shared'
import { resolvePublicMedia } from '../src/public-video.js'

const enabled = process.env.KOUBOX_NETWORK_TEST === '1'

describe.skipIf(!enabled)('public video network verification', () => {
  it('downloads the requested public media without account cookies', async () => {
    const url = process.env.KOUBOX_TEST_URL!
    const platform = process.env.KOUBOX_TEST_PLATFORM!
    const output = process.env.KOUBOX_TEST_OUTPUT!
    const ffmpeg = process.env.KOUBOX_TEST_FFMPEG!
    const proxy = normalizeProxyUrl(process.env.KOUBOX_TEST_PROXY ?? '') ?? ''
    mkdirSync(dirname(output), { recursive: true })
    const resolved = await resolvePublicMedia(url, platform, proxy, 720)
    const args = ['-hide_banner', '-loglevel', 'error', '-y']
    const addInput = (input: string) => {
      if (proxy) args.push('-http_proxy', proxy)
      args.push('-user_agent', resolved.userAgent, '-referer', resolved.referer, '-i', input)
    }
    addInput(resolved.videoUrl)
    if (resolved.audioUrl) addInput(resolved.audioUrl)
    args.push('-map', '0:v:0', '-map', resolved.audioUrl ? '1:a:0' : '0:a:0?', '-c', 'copy', '-movflags', '+faststart', output)
    const result = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(existsSync(output)).toBe(true)
    expect(statSync(output).size).toBeGreaterThan(100_000)
  }, 150_000)
})
