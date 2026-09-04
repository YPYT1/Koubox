import {
  assertDownloadableVideoUrl,
  assertMaterialsVideoUrl,
  detectPlatform
} from '@koubox/shared'
import { FormField } from '../common/FormControls'
import {
  DOWNLOAD_PLATFORM_META,
  MATERIALS_PLATFORM_META,
  isSupportedDownloadPlatform,
  isSupportedMaterialsPlatform
} from './platforms'

export type VideoUrlFieldScope = 'download' | 'materials'

type VideoUrlFieldProps = {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  label?: string
  placeholder?: string
  showPlatformChips?: boolean
  /** download=含 Bilibili；materials=爆款素材/抽音频，不含 Bilibili */
  scope?: VideoUrlFieldScope
}

function formatHint(value: string, scope: VideoUrlFieldScope): { error?: string } {
  const trimmed = value.trim()
  if (!trimmed) return {}
  try {
    if (scope === 'materials') assertMaterialsVideoUrl(trimmed)
    else assertDownloadableVideoUrl(trimmed)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  return {}
}

/** 链接输入 + 平台识别条 */
export function VideoUrlField({
  value,
  onChange,
  disabled,
  label = '视频链接',
  placeholder = 'https://www.youtube.com/watch?v=...',
  showPlatformChips = true,
  scope = 'download'
}: VideoUrlFieldProps) {
  const platform = value.trim() ? detectPlatform(value.trim()) : undefined
  const supported = scope === 'materials'
    ? isSupportedMaterialsPlatform(platform)
    : isSupportedDownloadPlatform(platform)
  const chips = scope === 'materials' ? MATERIALS_PLATFORM_META : DOWNLOAD_PLATFORM_META
  const hint = formatHint(value, scope)

  return (
    <>
      <FormField label={label}>
        <input
          className="input-text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
        />
      </FormField>

      {showPlatformChips && (
        <div className="downloader-platforms">
          {chips.map(({ id, label: name, Icon }) => {
            const active = platform === id
            return (
              <span
                key={id}
                className={`downloader-platform-chip${active ? ' is-active' : ''}${platform && !supported ? ' is-muted' : ''}`}
              >
                <Icon size={16} weight={active ? 'fill' : 'regular'} />
                {name}
              </span>
            )
          })}
        </div>
      )}

      {hint.error && <div className="downloader-platform-warn">{hint.error}</div>}
      {!hint.error && value.trim() && platform && !supported && (
        <div className="downloader-platform-warn">当前链接平台不在支持范围内</div>
      )}
    </>
  )
}
