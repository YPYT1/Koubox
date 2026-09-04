import {
  parsePlatformUrl,
  parsePlatformUrlOrThrow,
  type ParsedPlatformUrl
} from '@koubox/shared'
import { resolveFacebookShareUrl } from './facebook.js'
import { resolveBilibiliShortUrl } from './bilibili.js'

export type PreparedDownloadUrl = {
  originalUrl: string
  downloadUrl: string
  parsed: ParsedPlatformUrl
  redirectChain?: string[]
}

export async function prepareDownloadUrl(inputUrl: string, proxy: string, signal?: AbortSignal): Promise<PreparedDownloadUrl> {
  const originalUrl = inputUrl.trim()
  const parsed = parsePlatformUrlOrThrow(originalUrl)
  let downloadUrl = parsed.canonicalUrl
  let redirectChain: string[] | undefined

  if (parsed.needsRedirect && parsed.platform === 'Facebook' && parsed.kind === 'facebook-share') {
    const resolved = await resolveFacebookShareUrl(originalUrl, proxy, signal)
    redirectChain = resolved.redirectChain
    downloadUrl = resolved.finalUrl
    const finalParsed = parsePlatformUrl(resolved.finalUrl)
    if (!finalParsed || finalParsed.platform !== 'Facebook' || finalParsed.kind === 'facebook-share') {
      throw new Error('Facebook 分享链接无法跳转到视频页面。')
    }
    return { originalUrl, downloadUrl, parsed: finalParsed, redirectChain }
  }

  if (parsed.needsRedirect && parsed.platform === 'Bilibili' && parsed.kind === 'bilibili-short-link') {
    const resolved = await resolveBilibiliShortUrl(originalUrl, proxy, signal)
    const finalParsed = parsePlatformUrl(resolved.finalUrl)
    if (!finalParsed || finalParsed.platform !== 'Bilibili' || finalParsed.kind === 'bilibili-short-link') {
      throw new Error('Bilibili 短链无法跳转到视频页面。')
    }
    return {
      originalUrl,
      downloadUrl: finalParsed.canonicalUrl,
      parsed: finalParsed,
      redirectChain: resolved.redirectChain
    }
  }

  return { originalUrl, downloadUrl, parsed, redirectChain }
}
