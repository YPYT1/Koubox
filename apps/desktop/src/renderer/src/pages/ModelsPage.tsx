import { useState } from 'react'
import {
  Cpu,
  CheckCircle,
  FolderSimple,
  FolderOpen,
  ArrowClockwise,
  Check,
  Warning
} from '@phosphor-icons/react'
import type { KouboxConfig, RuntimeStatus } from '@koubox/shared'
import { Button } from '../components/common/Button'

type ModelsPageProps = {
  runtime: RuntimeStatus | null
  config: KouboxConfig | null
  onRefresh: () => void
  onChooseDirectory: (title: string, defaultPath?: string) => Promise<string | undefined>
  onShowToast: (message: string, type?: 'success' | 'warning' | 'error' | 'info') => void
  onConfigChange: (config: KouboxConfig) => void
}

function formatMemory(value?: number): string {
  return value === undefined ? '—' : `${(value / 1024).toFixed(1)} GB`
}

function modelBadge(id: string): string {
  if (id === 'asr') return '语音识别'
  if (id === 'translation') return '翻译'
  if (id === 'demucs') return '人声分离'
  return id
}

function modelFormatBadge(format: RuntimeStatus['models'][number]['format']): string {
  return format === 'ctranslate2' ? 'CTranslate2 · FP16' : 'Transformers'
}

function modelPathKey(id: string): 'asrModelDirectory' | 'translationModelDirectory' | 'demucsModelDirectory' {
  if (id === 'asr') return 'asrModelDirectory'
  if (id === 'translation') return 'translationModelDirectory'
  return 'demucsModelDirectory'
}

export function ModelsPage({
  runtime,
  config,
  onRefresh,
  onChooseDirectory,
  onShowToast,
  onConfigChange
}: ModelsPageProps) {
  const [detecting, setDetecting] = useState(false)
  const gpu = runtime?.gpu
  const usedMem = gpu?.usedMemoryMiB ?? 0
  const totalMem = gpu?.totalMemoryMiB ?? 0
  const freeMem = gpu?.freeMemoryMiB ?? 0
  const usedPercent = totalMem > 0 ? Math.min(100, (usedMem / totalMem) * 100) : 0
  const vendor = runtime?.vendor

  const saveConfigPatch = async (patch: Partial<KouboxConfig>, successMessage: string) => {
    if (!config) return
    try {
      const next = await window.koubox.put<KouboxConfig>('/config', { ...config, ...patch })
      onConfigChange(next)
      onShowToast(successMessage, 'success')
      onRefresh()
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '保存失败', 'error')
    }
  }

  const handleChooseModel = async (
    key: 'asrModelDirectory' | 'translationModelDirectory' | 'demucsModelDirectory',
    title: string
  ) => {
    if (!config) return
    const path = await onChooseDirectory(title, config[key])
    if (!path) return
    await saveConfigPatch({ [key]: path }, '模型路径已更新并保存')
  }

  const handleDetect = async () => {
    setDetecting(true)
    try {
      await window.koubox.post<RuntimeStatus>('/runtime/refresh')
      onRefresh()
      onShowToast('硬件及本地模型状态已刷新', 'success')
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '刷新检测失败', 'error')
    } finally {
      setDetecting(false)
    }
  }

  const isVendorOk = Boolean(vendor?.ffmpeg.ready && vendor?.ytdlp.ready)

  return (
    <div className="page-container">
      <div className="page-header-block" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>模型与计算环境</h1>
          <p>实时监控本地 GPU 显存负载、媒体编解码组件及离线 AI 模型的完整性</p>
        </div>
        <Button
          variant="secondary"
          size="md"
          loading={detecting}
          icon={<ArrowClockwise size={16} />}
          onClick={handleDetect}
        >
          {detecting ? '检测中…' : '重新检测环境'}
        </Button>
      </div>

      <div className="env-grid">
        <div className="env-card">
          <div className="env-card-head">
            <div className="env-card-title">
              <Cpu weight="bold" />
              <span>GPU 计算加速器</span>
            </div>
            <span
              className={`panel-title-badge ${gpu?.available ? 'ready' : ''}`}
              style={{
                color: gpu?.available ? '#10b981' : '#f59e0b',
                background: gpu?.available ? '#ecfdf5' : '#fffbeb'
              }}
            >
              {gpu?.available ? 'CUDA 硬件加速就绪' : 'GPU 不可用 (将降级)'}
            </span>
          </div>

          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-main)' }}>
            {gpu?.name || '未检测到 NVIDIA GPU'}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-secondary)' }}>
              <span>显存占用</span>
              <span>{formatMemory(usedMem)} / {formatMemory(totalMem)} · 空闲 {formatMemory(freeMem)}</span>
            </div>
            <div className="vram-mini-progress" style={{ height: 8 }}>
              <div className="vram-mini-fill" style={{ width: `${gpu?.available ? usedPercent : 4}%` }} />
            </div>
          </div>
        </div>

        <div className="env-card">
          <div className="env-card-head">
            <div className="env-card-title">
              <FolderSimple weight="bold" />
              <span>媒体处理组件</span>
            </div>
            <span
              className="panel-title-badge"
              style={{
                color: isVendorOk ? '#10b981' : '#f59e0b',
                background: isVendorOk ? '#ecfdf5' : '#fffbeb'
              }}
            >
              {isVendorOk ? '全部组件就绪' : '部分组件缺失'}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12.5 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>yt-dlp 视频解析引擎</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: vendor?.ytdlp.ready ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                {vendor?.ytdlp.ready ? <Check size={14} weight="bold" /> : <Warning size={14} weight="bold" />}
                {vendor?.ytdlp.ready ? '运行就绪' : '未就绪'}
              </span>
            </div>
            {vendor?.ytdlp && (
              <>
                <code className="vendor-missing-path" style={vendor.ytdlp.ready && vendor.ytdlp.missingFiles.length === 0 ? { color: 'var(--text-muted)', background: 'var(--bg-card-subtle)', borderColor: 'var(--border-subtle)' } : undefined}>
                  {vendor.ytdlp.directory}
                </code>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  文件 {vendor.ytdlp.foundFiles.length} / {vendor.ytdlp.expectedFiles.length}
                  {vendor.ytdlp.missingFiles.length > 0 ? ` · 缺少 ${vendor.ytdlp.missingFiles.join(', ')}` : ''}
                </div>
              </>
            )}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>FFmpeg 音视频转换处理库</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: vendor?.ffmpeg.ready ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                {vendor?.ffmpeg.ready ? <Check size={14} weight="bold" /> : <Warning size={14} weight="bold" />}
                {vendor?.ffmpeg.ready ? '运行就绪' : '未就绪'}
              </span>
            </div>
            {vendor?.ffmpeg && (
              <>
                <code className="vendor-missing-path" style={vendor.ffmpeg.ready && vendor.ffmpeg.missingFiles.length === 0 ? { color: 'var(--text-muted)', background: 'var(--bg-card-subtle)', borderColor: 'var(--border-subtle)' } : undefined}>
                  {vendor.ffmpeg.directory}
                </code>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  文件 {vendor.ffmpeg.foundFiles.length} / {vendor.ffmpeg.expectedFiles.length}
                </div>
                {vendor.ffmpeg.missingFiles.length > 0 && (
                  <div className="vendor-integrity-missing">
                    <span>缺少：</span>
                    {vendor.ffmpeg.missingFiles.map((file) => (
                      <code key={file}>{file}</code>
                    ))}
                  </div>
                )}
              </>
            )}
            <p style={{ margin: 0, fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
              {isVendorOk
                ? '媒体组件路径可在「全局设置」中自定义；当前检测通过。'
                : '组件未就绪时下载或抽音会失败。请到「全局设置」核对 yt-dlp / FFmpeg 目录，补齐缺失文件后重新检测。'}
            </p>
          </div>
        </div>
      </div>

      <div className="section-header" style={{ marginBottom: 14 }}>
        <h2>离线 AI 模型权重库</h2>
        <span>支持独立选择自定义模型存放路径</span>
      </div>

      <div className="model-deck">
        {runtime?.models.map((model) => (
          <div className="model-card-item" key={model.id}>
            <div className={`model-status-icon ${model.ready ? 'ready' : 'warn'}`}>
              {model.ready ? <CheckCircle weight="fill" /> : <FolderSimple weight="fill" />}
            </div>

            <div className="model-main-info">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h4>{model.label}</h4>
                <span className="panel-title-badge">{modelBadge(model.id)}</span>
                <span className="panel-title-badge">{modelFormatBadge(model.format)}</span>
              </div>
              <p title={model.directory}>{model.directory}</p>
              {model.missingFiles.length > 0 && (
                <small style={{ color: '#ef4444', fontSize: 11 }}>
                  缺少 {model.missingFiles.length} 项关键权重文件 ({model.missingFiles.slice(0, 3).join(', ')}…)
                </small>
              )}
            </div>

            <div className="model-file-count">
              <div className="model-file-badge">
                {model.foundFiles} / {model.expectedFiles} 文件就绪
              </div>
              <Button
                variant="secondary"
                size="sm"
                icon={<FolderOpen size={14} />}
                onClick={() =>
                  handleChooseModel(modelPathKey(model.id), `选择 ${model.label} 文件夹`)
                }
              >
                更换路径
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
