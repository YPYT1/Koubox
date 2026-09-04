import type { ComponentType } from 'react'
import {
  YoutubeLogo,
  InstagramLogo,
  TiktokLogo,
  FacebookLogo,
  TelevisionSimple
} from '@phosphor-icons/react'
import {
  DOWNLOADABLE_VIDEO_PLATFORMS,
  MATERIALS_VIDEO_PLATFORMS,
  type DownloadableVideoPlatform,
  type KouboxPlatform,
  type MaterialsVideoPlatform
} from '@koubox/shared'

type PlatformMeta = {
  id: DownloadableVideoPlatform
  label: string
  Icon: ComponentType<{ size?: number; weight?: 'bold' | 'fill' | 'regular' }>
}

const PLATFORM_ICONS: Record<DownloadableVideoPlatform, PlatformMeta['Icon']> = {
  YouTube: YoutubeLogo,
  Facebook: FacebookLogo,
  Instagram: InstagramLogo,
  TikTok: TiktokLogo,
  Bilibili: TelevisionSimple
}

function metaFor(ids: readonly DownloadableVideoPlatform[]): PlatformMeta[] {
  return ids.map((id) => ({ id, label: id, Icon: PLATFORM_ICONS[id] }))
}

/** 视频下载页平台条（含 Bilibili） */
export const DOWNLOAD_PLATFORM_META = metaFor(DOWNLOADABLE_VIDEO_PLATFORMS)

/** 爆款素材 / 视频提取音频平台条（不含 Bilibili） */
export const MATERIALS_PLATFORM_META = metaFor(MATERIALS_VIDEO_PLATFORMS as readonly DownloadableVideoPlatform[])

export function isSupportedDownloadPlatform(platform: KouboxPlatform | undefined): boolean {
  if (!platform) return false
  return (DOWNLOADABLE_VIDEO_PLATFORMS as readonly string[]).includes(platform)
}

export function isSupportedMaterialsPlatform(platform: KouboxPlatform | undefined): platform is MaterialsVideoPlatform {
  if (!platform) return false
  return (MATERIALS_VIDEO_PLATFORMS as readonly string[]).includes(platform)
}
