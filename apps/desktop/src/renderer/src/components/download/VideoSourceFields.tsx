import { DownloadSimple, FilmStrip, LinkSimple, UploadSimple } from '@phosphor-icons/react'
import { LOCAL_VIDEO_EXTENSIONS, type MaterialsSourceMode } from '@koubox/shared'
import { FormField, PathPicker } from '../common/FormControls'
import { VideoUrlField } from './VideoUrlField'

type VideoSourceFieldsProps = {
  sourceMode: MaterialsSourceMode
  onSourceModeChange: (mode: MaterialsSourceMode) => void
  url: string
  onUrlChange: (url: string) => void
  videoPath: string
  onVideoPathChange: (path: string) => void
  disabled?: boolean
  onChooseVideoFile: (title: string, defaultPath?: string) => Promise<string | undefined>
  browseDefaultPath?: string
  urlLabel?: string
}

/** 链接下载 / 本地上传 视频来源切换与输入 */
export function VideoSourceFields({
  sourceMode,
  onSourceModeChange,
  url,
  onUrlChange,
  videoPath,
  onVideoPathChange,
  disabled = false,
  onChooseVideoFile,
  browseDefaultPath = '',
  urlLabel = '短视频 URL'
}: VideoSourceFieldsProps) {
  const videoFileName = videoPath.replace(/^.*[/\\]/, '')

  return (
    <>
      <div className="viral-source-mode" role="tablist" aria-label="视频来源">
        <button
          type="button"
          role="tab"
          aria-selected={sourceMode === 'url'}
          className={`viral-source-mode-btn ${sourceMode === 'url' ? 'is-active' : ''}`}
          disabled={disabled}
          onClick={() => onSourceModeChange('url')}
        >
          <LinkSimple size={16} weight="bold" />
          链接下载
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={sourceMode === 'local'}
          className={`viral-source-mode-btn ${sourceMode === 'local' ? 'is-active' : ''}`}
          disabled={disabled}
          onClick={() => onSourceModeChange('local')}
        >
          <UploadSimple size={16} weight="bold" />
          本地上传
        </button>
      </div>

      {sourceMode === 'url' ? (
        <VideoUrlField value={url} onChange={onUrlChange} disabled={disabled} label={urlLabel} />
      ) : (
        <FormField label="本地视频" hint={`支持 ${LOCAL_VIDEO_EXTENSIONS.join(' / ')}`}>
          <PathPicker
            value={videoPath}
            onChange={onVideoPathChange}
            onBrowse={async () => {
              const picked = await onChooseVideoFile('选择本地视频', videoPath || browseDefaultPath)
              if (picked) onVideoPathChange(picked)
            }}
            disabled={disabled}
            placeholder="选择要导入的视频文件…"
          />
          {videoFileName ? (
            <p className="viral-local-file-hint">
              <FilmStrip size={14} />
              <span>{videoFileName}</span>
            </p>
          ) : null}
        </FormField>
      )}
    </>
  )
}

export function videoSourceStartIcon(sourceMode: MaterialsSourceMode) {
  return sourceMode === 'local'
    ? <UploadSimple size={18} weight="bold" />
    : <DownloadSimple size={18} weight="bold" />
}
