import type { DownloadableVideoPlatform } from './index.js'

export type ParsedPlatformUrlKind =
  | 'youtube-watch'
  | 'youtube-short'
  | 'youtube-short-link'
  | 'tiktok-video'
  | 'tiktok-short-link'
  | 'instagram-post'
  | 'instagram-reel'
  | 'instagram-reels'
  | 'facebook-watch'
  | 'facebook-reel'
  | 'facebook-video'
  | 'facebook-share'
  | 'bilibili-video'
  | 'bilibili-short-link'
  | 'bilibili-bangumi'

export type ParsedPlatformUrl = {
  platform: DownloadableVideoPlatform
  kind: ParsedPlatformUrlKind
  canonicalUrl: string
  id?: string
  needsRedirect: boolean
  strippedParams: string[]
}

const VIDEO_ID_PATTERN = /[A-Za-z0-9_-]+/

function parseYoutube(input: string): ParsedPlatformUrl | undefined {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return undefined
  }
  const host = parsed.hostname.toLowerCase()
  const strippedParams: string[] = []
  if (host === 'youtu.be') {
    const videoId = parsed.pathname.split('/').filter(Boolean)[0]
    if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) return undefined
    return {
      platform: 'YouTube',
      kind: 'youtube-short-link',
      canonicalUrl: `https://youtu.be/${videoId}`,
      id: videoId,
      needsRedirect: false,
      strippedParams
    }
  }
  if (!/(^|\.)youtube\.com$/i.test(host)) return undefined

  const parts = parsed.pathname.split('/').filter(Boolean)
  if (parts[0] === 'shorts' && parts[1] && VIDEO_ID_PATTERN.test(parts[1])) {
    for (const key of ['feature', 'si', 'list', 'index']) {
      if (parsed.searchParams.has(key)) strippedParams.push(key)
    }
    return {
      platform: 'YouTube',
      kind: 'youtube-short',
      canonicalUrl: `https://www.youtube.com/shorts/${parts[1]}`,
      id: parts[1],
      needsRedirect: false,
      strippedParams
    }
  }

  const fromQuery = parsed.searchParams.get('v')
  if (fromQuery && VIDEO_ID_PATTERN.test(fromQuery)) {
    for (const key of ['list', 'index', 'feature', 'si']) {
      if (parsed.searchParams.has(key)) strippedParams.push(key)
    }
    return {
      platform: 'YouTube',
      kind: 'youtube-watch',
      canonicalUrl: `https://www.youtube.com/watch?v=${fromQuery}`,
      id: fromQuery,
      needsRedirect: false,
      strippedParams
    }
  }

  if ((parts[0] === 'embed' || parts[0] === 'live') && parts[1] && VIDEO_ID_PATTERN.test(parts[1])) {
    return {
      platform: 'YouTube',
      kind: 'youtube-watch',
      canonicalUrl: `https://www.youtube.com/watch?v=${parts[1]}`,
      id: parts[1],
      needsRedirect: false,
      strippedParams
    }
  }
  return undefined
}

function parseTikTok(input: string): ParsedPlatformUrl | undefined {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return undefined
  }
  const host = parsed.hostname.toLowerCase()
  if (/^(?:vm|vt)\.tiktok\.com$/i.test(host)) {
    const code = parsed.pathname.split('/').filter(Boolean)[0]
    if (!code) return undefined
    return {
      platform: 'TikTok',
      kind: 'tiktok-short-link',
      canonicalUrl: parsed.origin + parsed.pathname,
      needsRedirect: true,
      strippedParams: []
    }
  }
  if (!host.includes('tiktok.com')) return undefined
  const match = parsed.pathname.match(/\/@([^/]+)\/video\/(\d+)/)
  if (!match) return undefined
  const strippedParams: string[] = []
  for (const key of ['q', 't', 'is_from_webapp', 'sender_device']) {
    if (parsed.searchParams.has(key)) strippedParams.push(key)
  }
  if (parsed.hash) strippedParams.push('hash')
  return {
    platform: 'TikTok',
    kind: 'tiktok-video',
    canonicalUrl: `https://www.tiktok.com/@${match[1]}/video/${match[2]}`,
    id: match[2],
    needsRedirect: false,
    strippedParams
  }
}

function parseInstagram(input: string): ParsedPlatformUrl | undefined {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return undefined
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  if (host !== 'instagram.com') return undefined
  const match = parsed.pathname.match(/^\/(p|reel|reels)\/([A-Za-z0-9_-]+)/)
  if (!match) return undefined
  const [, segment, shortcode] = match
  const strippedParams: string[] = []
  for (const key of ['utm_source', 'igsi']) {
    if (parsed.searchParams.has(key)) strippedParams.push(key)
  }
  if (parsed.hash) strippedParams.push('hash')
  const kind: ParsedPlatformUrlKind =
    segment === 'p' ? 'instagram-post' : segment === 'reel' ? 'instagram-reel' : 'instagram-reels'
  return {
    platform: 'Instagram',
    kind,
    canonicalUrl: `https://www.instagram.com/${segment}/${shortcode}/`,
    id: shortcode,
    needsRedirect: false,
    strippedParams
  }
}

function parseFacebook(input: string): ParsedPlatformUrl | undefined {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return undefined
  }
  const host = parsed.hostname.toLowerCase()
  if (!host.includes('facebook.com') && host !== 'fb.watch') return undefined

  const shareMatch = parsed.pathname.match(/\/share\/([rv])\/([^/]+)/i)
  if (shareMatch) {
    return {
      platform: 'Facebook',
      kind: 'facebook-share',
      canonicalUrl: parsed.origin + parsed.pathname.replace(/\/$/, '') + '/',
      needsRedirect: true,
      strippedParams: []
    }
  }

  const queryId = parsed.searchParams.get('v')
  if (queryId && /^\d+$/.test(queryId)) {
    const strippedParams: string[] = []
    for (const key of parsed.searchParams.keys()) {
      if (key !== 'v') strippedParams.push(key)
    }
    return {
      platform: 'Facebook',
      kind: 'facebook-watch',
      canonicalUrl: `https://www.facebook.com/watch?v=${queryId}`,
      id: queryId,
      needsRedirect: false,
      strippedParams
    }
  }

  const pathMatch = parsed.pathname.match(/\/(?:videos|reel|reels)\/(\d+)/i)
  if (pathMatch) {
    const segment = parsed.pathname.match(/\/(videos|reel|reels)\//i)?.[1]?.toLowerCase() ?? 'videos'
    const kind: ParsedPlatformUrlKind = segment === 'videos' ? 'facebook-video' : 'facebook-reel'
    return {
      platform: 'Facebook',
      kind,
      canonicalUrl: `https://www.facebook.com/${segment === 'reels' ? 'reel' : segment}/${pathMatch[1]}`,
      id: pathMatch[1],
      needsRedirect: false,
      strippedParams: []
    }
  }
  return undefined
}

function bilibiliVideoCanonical(id: string, page: string | null): string {
  return page && /^\d+$/.test(page) && Number(page) > 1
    ? `https://www.bilibili.com/video/${id}?p=${page}`
    : `https://www.bilibili.com/video/${id}`
}

function parseBilibili(input: string): ParsedPlatformUrl | undefined {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return undefined
  }
  const host = parsed.hostname.toLowerCase()
  const page = parsed.searchParams.get('p')
  const strippedParams = [...parsed.searchParams.keys()].filter((key) => key !== 'p')

  if (host === 'b23.tv' || host.endsWith('.b23.tv')) {
    const pathId = parsed.pathname.split('/').filter(Boolean)[0]
    if (!pathId) return undefined
    // 少数短链会直接带 BV/av；其余需跟随跳转
    if (/^(BV[0-9A-Za-z]+|av\d+)$/i.test(pathId)) {
      return {
        platform: 'Bilibili',
        kind: 'bilibili-video',
        canonicalUrl: bilibiliVideoCanonical(pathId, page),
        id: pathId,
        needsRedirect: false,
        strippedParams
      }
    }
    return {
      platform: 'Bilibili',
      kind: 'bilibili-short-link',
      canonicalUrl: `https://b23.tv/${pathId}`,
      id: pathId,
      needsRedirect: true,
      strippedParams
    }
  }

  if (!/(^|\.)bilibili\.com$/i.test(host)) return undefined

  const videoMatch = /\/video\/(BV[0-9A-Za-z]+|av\d+)/i.exec(parsed.pathname)
  if (videoMatch) {
    const id = videoMatch[1]
    return {
      platform: 'Bilibili',
      kind: 'bilibili-video',
      canonicalUrl: bilibiliVideoCanonical(id, page),
      id,
      needsRedirect: false,
      strippedParams
    }
  }

  const bangumiMatch = /\/bangumi\/play\/(ep|ss)(\d+)/i.exec(parsed.pathname)
  if (bangumiMatch) {
    const id = `${bangumiMatch[1].toLowerCase()}${bangumiMatch[2]}`
    return {
      platform: 'Bilibili',
      kind: 'bilibili-bangumi',
      canonicalUrl: `https://www.bilibili.com/bangumi/play/${id}`,
      id,
      needsRedirect: false,
      strippedParams: [...parsed.searchParams.keys()]
    }
  }

  // 稍后再看 / 合集页：只要带 bvid 就可落到普通视频
  if (/^\/(list|festival)\//i.test(parsed.pathname)) {
    const bvid = parsed.searchParams.get('bvid')
    if (bvid && /^BV[0-9A-Za-z]+$/i.test(bvid)) {
      return {
        platform: 'Bilibili',
        kind: 'bilibili-video',
        canonicalUrl: bilibiliVideoCanonical(bvid, page),
        id: bvid,
        needsRedirect: false,
        strippedParams: [...parsed.searchParams.keys()].filter((key) => key !== 'p' && key !== 'bvid')
      }
    }
  }

  return undefined
}

export function parsePlatformUrl(input: string): ParsedPlatformUrl | undefined {
  const trimmed = input.trim()
  if (!trimmed) return undefined
  return parseYoutube(trimmed)
    ?? parseTikTok(trimmed)
    ?? parseInstagram(trimmed)
    ?? parseFacebook(trimmed)
    ?? parseBilibili(trimmed)
}

export function parsePlatformUrlOrThrow(input: string): ParsedPlatformUrl {
  const parsed = parsePlatformUrl(input)
  if (!parsed) {
    const platform = (() => {
      try {
        const host = new URL(input.trim()).hostname.toLowerCase()
        if (host.includes('youtu')) return 'YouTube'
        if (host.includes('tiktok')) return 'TikTok'
        if (host.includes('instagram')) return 'Instagram'
        if (host.includes('facebook') || host === 'fb.watch') return 'Facebook'
        if (host.includes('bilibili') || host === 'b23.tv' || host.endsWith('.b23.tv')) return 'Bilibili'
      } catch { /* ignore */ }
      return undefined
    })()
    if (platform === 'YouTube') throw new Error('YouTube 链接格式不正确，未找到有效视频 ID。')
    if (platform === 'TikTok') throw new Error('TikTok 链接格式不正确，需要 /@用户名/video/数字 或短链。')
    if (platform === 'Instagram') throw new Error('Instagram 链接格式不正确，支持 /p/、/reel/、/reels/。')
    if (platform === 'Facebook') throw new Error('Facebook 链接格式不正确，支持 watch、reel、videos 或分享链接。')
    if (platform === 'Bilibili') {
      throw new Error('Bilibili 链接格式不正确，支持 /video/BV|av、b23 短链、番剧 ep/ss，或带 bvid 的 list/festival。')
    }
    throw new Error('链接格式不正确，未识别到支持的平台视频路径。')
  }
  return parsed
}

