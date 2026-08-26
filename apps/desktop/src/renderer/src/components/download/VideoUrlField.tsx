import { detectPlatform } from '@koubox/shared'
import { FormField } from '../common/FormControls'
import { DOWNLOAD_PLATFORM_META, isSupportedDownloadPlatform } from './platforms'

type VideoUrlFieldProps = {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  label?: string
  placeholder?: string
  showPlatformChips?: boolean
}

/** 两个下载相关工具共用的链接输入 + 平台识别条 */
export function VideoUrlField({
  value,
  onChange,
  disabled,
  label = '视频链接',
  placeholder = 'https://www.youtube.com/watch?v=...',
  showPlatformChips = true
}: VideoUrlFieldProps) {
  const platform = value.trim() ? detectPlatform(value.trim()) : undefined
  const supported = isSupportedDownloadPlatform(platform)

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
          {DOWNLOAD_PLATFORM_META.map(({ id, label: name, Icon }) => {
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

      {value.trim() && platform && !supported && (
        <div className="downloader-platform-warn">当前链接平台不在支持范围内</div>
      )}
    </>
  )
}
