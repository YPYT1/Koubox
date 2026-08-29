import {
  assertDownloadableVideoUrl,
  assertLocalAudioPath,
  assertLocalVideoPath,
  type TaskSnapshot,
  VIDEO_AUDIO_PIPELINE_PATH,
  VIDEO_DOWNLOAD_PIPELINE_PATH,
  VIDEO_MATERIALS_PIPELINE_PATH,
  VOCAL_SEPARATION_PIPELINE_PATH
} from '@koubox/shared'

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

async function postVideoMaterialsPipeline(path: string, input: MaterialsPipelineInput): Promise<TaskSnapshot> {
  if (!input.outputDirectory.trim()) throw new Error('请选择保存目录。')
  const videoPath = input.videoPath?.trim() ?? ''
  if (videoPath) {
    const checked = assertLocalVideoPath(videoPath)
    return window.koubox.post<TaskSnapshot>(path, {
      videoPath: checked,
      outputDirectory: input.outputDirectory.trim()
    })
  }
  const checked = assertDownloadableVideoUrl(input.url ?? '')
  return window.koubox.post<TaskSnapshot>(path, {
    url: checked.url,
    outputDirectory: input.outputDirectory.trim()
  })
}

/** 下载或本地导入 + 后续素材流水线：爆款素材获取 */
export async function startMaterialsPipeline(input: MaterialsPipelineInput): Promise<TaskSnapshot> {
  return postVideoMaterialsPipeline(VIDEO_MATERIALS_PIPELINE_PATH, input)
}

/** 下载或本地导入 + 仅提取音频：视频提取音频 */
export async function startVideoAudioPipeline(input: MaterialsPipelineInput): Promise<TaskSnapshot> {
  return postVideoMaterialsPipeline(VIDEO_AUDIO_PIPELINE_PATH, input)
}

/** 本地上传音频 + 人声分离 */
export async function startVocalSeparationPipeline(audioPath: string, outputDirectory: string): Promise<TaskSnapshot> {
  const checked = assertLocalAudioPath(audioPath)
  if (!outputDirectory.trim()) throw new Error('请选择保存目录。')
  return window.koubox.post<TaskSnapshot>(VOCAL_SEPARATION_PIPELINE_PATH, {
    audioPath: checked,
    outputDirectory: outputDirectory.trim()
  })
}

export async function cancelDownloadTask(taskId: string): Promise<TaskSnapshot> {
  return window.koubox.post<TaskSnapshot>(`/tasks/${encodeURIComponent(taskId)}/cancel`)
}
