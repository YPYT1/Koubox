export type ToolId = 'viral-materials' | 'precise-srt'

export type ToolManifest = {
  id: ToolId
  name: string
  description: string
  accent: 'teal' | 'blue'
  artifactTags: string[]
  menus: Array<{ id: string; label: string }>
}

export const tools: ToolManifest[] = [
  {
    id: 'viral-materials',
    name: '爆款素材获取',
    description: '输入视频链接，下载视频、抽取音频、识别原文并进行本地翻译。',
    accent: 'teal',
    artifactTags: ['URL', 'Video', 'Audio', 'Transcript', 'Translation'],
    menus: [
      { id: 'run', label: '开始处理' },
      { id: 'history', label: '任务记录' },
      { id: 'outputs', label: '输出文件' }
    ]
  },
  {
    id: 'precise-srt',
    name: '精准 SRT 对齐',
    description: '导入音频和可选原文，输出可直接导入剪映的标准 SRT。',
    accent: 'blue',
    artifactTags: ['Audio', 'Transcript', 'Text', 'SRT'],
    menus: [
      { id: 'run', label: '开始对齐' },
      { id: 'history', label: '任务记录' },
      { id: 'outputs', label: '输出文件' }
    ]
  }
]

export type TranscriptSegment = {
  text: string
  start: number
  end: number
}

export type Transcript = {
  language?: string
  segments: TranscriptSegment[]
}

export type ModelCheck = {
  id: string
  label: string
  directory: string
  format: 'transformers'
  ready: boolean
  configured: boolean
  expectedFiles: number
  foundFiles: number
  missingFiles: string[]
}

export type GpuStatus = {
  available: boolean
  name?: string
  totalMemoryMiB?: number
  usedMemoryMiB?: number
  freeMemoryMiB?: number
  message: string
}

export type RuntimeStatus = {
  healthy: boolean
  startedAt: string
  gpu: GpuStatus
  models: ModelCheck[]
  vendor: {
    ytdlp: boolean
    ffmpeg: boolean
  }
}

export type TaskKind = 'req1' | 'req2'
export type RequirementTwoMode = 'align' | 'asr-only'
export type TaskStage = 'queued' | 'download' | 'extract-audio' | 'asr' | 'align' | 'export-srt' | 'translation' | 'complete' | 'error' | 'cancelled'
export type TaskStatus = 'queued' | 'running' | 'complete' | 'error' | 'cancelled'

export type TaskArtifacts = {
  video?: string
  sourceAudio?: string
  audio?: string
  transcript?: string
  transcriptText?: string
  translation?: string
  translationText?: string
  srt?: string
}

export type TaskError = {
  code: string
  message: string
}

export type TaskSnapshot = {
  taskId: string
  kind: TaskKind
  mode?: RequirementTwoMode
  status: TaskStatus
  stage: TaskStage
  percent: number
  message: string
  url: string
  sourceText?: string
  outputDirectory: string
  taskDirectory: string
  language?: string
  transcript?: Transcript
  translation?: string
  artifacts: TaskArtifacts
  error?: TaskError
  createdAt: string
  updatedAt: string
}

export type TaskEvent = {
  type: 'snapshot'
  task: TaskSnapshot
}

export type KouboxConfig = {
  modelsDirectory: string
  outputDirectory: string
}

export type ApiError = { error: string; detail?: string }
