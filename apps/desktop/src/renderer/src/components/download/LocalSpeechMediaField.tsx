import { FileAudio } from '@phosphor-icons/react'
import { FormField, PathPicker } from '../common/FormControls'

type LocalSpeechMediaFieldProps = {
  value: string
  onChange: (path: string) => void
  disabled?: boolean
  onChooseMediaFile: (title: string, defaultPath?: string) => Promise<string | undefined>
  browseDefaultPath?: string
}

/** 本地音频或视频文件选择（语音转文字） */
export function LocalSpeechMediaField({
  value,
  onChange,
  disabled = false,
  onChooseMediaFile,
  browseDefaultPath = ''
}: LocalSpeechMediaFieldProps) {
  const fileName = value.replace(/^.*[/\\]/, '')

  return (
    <FormField label="本地音频 / 视频">
      <PathPicker
        value={value}
        onChange={onChange}
        onBrowse={async () => {
          const picked = await onChooseMediaFile('选择本地音频或视频', value || browseDefaultPath)
          if (picked) onChange(picked)
        }}
        disabled={disabled}
        placeholder="选择要识别的音频、视频或人声轨…"
      />
      {fileName ? (
        <p className="viral-local-file-hint">
          <FileAudio size={14} />
          <span>{fileName}</span>
        </p>
      ) : null}
    </FormField>
  )
}
