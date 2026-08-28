import type { ComponentType } from 'react'
import {
  YoutubeLogo,
  InstagramLogo,
  TiktokLogo,
  FacebookLogo
} from '@phosphor-icons/react'
import {
  DOWNLOADABLE_VIDEO_PLATFORMS,
  type DownloadableVideoPlatform,
  type KouboxPlatform
} from '@koubox/shared'

export const DOWNLOAD_PLATFORM_META: Array<{
  id: DownloadableVideoPlatform
  label: string
  Icon: ComponentType<{ size?: number; weight?: 'bold' | 'fill' | 'regular' }>
}> = [
  { id: 'YouTube', label: 'YouTube', Icon: YoutubeLogo },
  { id: 'Facebook', label: 'Facebook', Icon: FacebookLogo },
  { id: 'Instagram', label: 'Instagram', Icon: InstagramLogo },
  { id: 'TikTok', label: 'TikTok', Icon: TiktokLogo }
]

export function isSupportedDownloadPlatform(platform: KouboxPlatform | undefined): boolean {
  if (!platform) return false
  return (DOWNLOADABLE_VIDEO_PLATFORMS as readonly string[]).includes(platform)
}
