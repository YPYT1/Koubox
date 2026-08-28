import {
  assertDownloadableVideoUrl,
  assertLocalVideoPath,
  type TaskSnapshot
} from '@koubox/shared'
import { VIDEO_DOWNLOAD_PIPELINE_PATH, VIDEO_MATERIALS_PIPELINE_PATH } from '@koubox/shared'

/** 仅下载：视频下载工具 */
export async function startVideoDownload(url: string, outputDirectory: string): Promise<TaskSnapshot> {
  const checked = assertDownloadableVideoUrl(url)
  if (!outputDirectory.trim()) throw new Error('请选择保存目录。')
  return window.koubox.post<TaskSnapshot>(VIDEO_DOWNLOAD_PIPELINE_PATH, {
    url: checked.url,
    outputDirectory: outputDirectory.trim()
  })
}

export type MaterialsPipelineInput = {
  outputDirectory: string
  url?: string
  videoPath?: string
}

/** 下载或本地导入 + 后续素材流水线：爆款素材获取 */
export async function startMaterialsPipeline(input: MaterialsPipelineInput): Promise<TaskSnapshot> {
  if (!input.outputDirectory.trim()) throw new Error('请选择保存目录。')
  const videoPath = input.videoPath?.trim() ?? ''
  if (videoPath) {
    const checked = assertLocalVideoPath(videoPath)
    return window.koubox.post<TaskSnapshot>(VIDEO_MATERIALS_PIPELINE_PATH, {
      videoPath: checked,
      outputDirectory: input.outputDirectory.trim()
    })
  }
  const checked = assertDownloadableVideoUrl(input.url ?? '')
  return window.koubox.post<TaskSnapshot>(VIDEO_MATERIALS_PIPELINE_PATH, {
    url: checked.url,
    outputDirectory: input.outputDirectory.trim()
  })
}

export async function cancelDownloadTask(taskId: string): Promise<TaskSnapshot> {
  return window.koubox.post<TaskSnapshot>(`/tasks/${encodeURIComponent(taskId)}/cancel`)
}
