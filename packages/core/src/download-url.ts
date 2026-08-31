import {
  parsePlatformUrl,
  parsePlatformUrlOrThrow,
  type ParsedPlatformUrl
} from '@koubox/shared'
import { resolveFacebookShareUrl } from './facebook.js'

export type PreparedDownloadUrl = {
  originalUrl: string
  downloadUrl: string
  parsed: ParsedPlatformUrl
  redirectChain?: string[]
}

export async function prepareDownloadUrl(inputUrl: string, proxy: string): Promise<PreparedDownloadUrl> {
  const originalUrl = inputUrl.trim()
  const parsed = parsePlatformUrlOrThrow(originalUrl)
  let downloadUrl = parsed.canonicalUrl
  let redirectChain: string[] | undefined

  if (parsed.needsRedirect && parsed.platform === 'Facebook' && parsed.kind === 'facebook-share') {
    const resolved = await resolveFacebookShareUrl(originalUrl, proxy)
    redirectChain = resolved.redirectChain
    downloadUrl = resolved.finalUrl
    const finalParsed = parsePlatformUrl(resolved.finalUrl)
    if (!finalParsed || finalParsed.platform !== 'Facebook' || finalParsed.kind === 'facebook-share') {
      throw new Error('Facebook 分享链接无法跳转到视频页面。')
    }
    return { originalUrl, downloadUrl, parsed: finalParsed, redirectChain }
  }

  return { originalUrl, downloadUrl, parsed, redirectChain }
}
