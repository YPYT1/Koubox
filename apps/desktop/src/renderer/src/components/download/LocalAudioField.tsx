import { MusicNotes } from '@phosphor-icons/react'
import { FormField, PathPicker } from '../common/FormControls'

type LocalAudioFieldProps = {
  value: string
  onChange: (path: string) => void
  disabled?: boolean
  onChooseAudioFile: (title: string, defaultPath?: string) => Promise<string | undefined>
  browseDefaultPath?: string
}

/** 本地音频文件选择 */
export function LocalAudioField({
  value,
  onChange,
  disabled = false,
  onChooseAudioFile,
  browseDefaultPath = ''
}: LocalAudioFieldProps) {
  const fileName = value.replace(/^.*[/\\]/, '')

  return (
    <FormField label="本地音频">
      <PathPicker
        value={value}
        onChange={onChange}
        onBrowse={async () => {
          const picked = await onChooseAudioFile('选择本地音频', value || browseDefaultPath)
          if (picked) onChange(picked)
        }}
        disabled={disabled}
        placeholder="选择要处理的音频文件…"
      />
      {fileName ? (
        <p className="viral-local-file-hint">
          <MusicNotes size={14} />
          <span>{fileName}</span>
        </p>
      ) : null}
    </FormField>
  )
}
