import { useState } from 'react'
import {
  CheckCircle,
  FolderSimple,
  FolderOpen,
  ArrowClockwise,
  Check,
  Warning,
  PauseCircle
} from '@phosphor-icons/react'
import type { KouboxConfig, RuntimeStatus } from '@koubox/shared'
import { Button } from '../components/common/Button'
import { GpuMemoryLiveChart, SystemMemoryLiveChart } from '../components/common/MemoryLiveChart'

type ModelsPageProps = {
  runtime: RuntimeStatus | null
  config: KouboxConfig | null
  onRefresh: () => void
  onChooseDirectory: (title: string, defaultPath?: string) => Promise<string | undefined>
  onShowToast: (message: string, type?: 'success' | 'warning' | 'error' | 'info') => void
  onConfigChange: (config: KouboxConfig) => void
}

function modelBadge(id: string): string {
  if (id === 'asr') return '语音识别'
  if (id === 'translation') return '翻译'
  if (id === 'demucs') return '去除背景音乐'
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

/** 功能已暂时关闭的模型，保留配置与路径供后续恢复 */
const SHELVED_MODEL_IDS = new Set(['translation'])

function isShelvedModel(id: string): boolean {
  return SHELVED_MODEL_IDS.has(id)
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
      <div className="page-header-block models-page-header">
        <div>
          <h1>模型与计算环境</h1>
          <p>实时监控本机内存、显卡显存、媒体组件及离线 AI 模型状态</p>
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

      <div className="models-env-stack">
        <SystemMemoryLiveChart />
        <GpuMemoryLiveChart />

        <section className="env-card env-card-wide env-vendor-panel">
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

          <div className="env-vendor-grid">
            <div className="env-vendor-item">
              <div className="env-vendor-item-head">
                <span className="env-vendor-item-title">
                  yt-dlp 视频解析引擎
                  {vendor?.ytdlp && (
                    <span className="env-vendor-file-count">
                      {' '}· 文件 {vendor.ytdlp.foundFiles.length} / {vendor.ytdlp.expectedFiles.length}
                      {vendor.ytdlp.missingFiles.length > 0 ? ` · 缺少 ${vendor.ytdlp.missingFiles.join(', ')}` : ''}
                    </span>
                  )}
                </span>
                <span className={`env-vendor-status ${vendor?.ytdlp.ready ? 'ready' : 'warn'}`}>
                  {vendor?.ytdlp.ready ? <Check size={14} weight="bold" /> : <Warning size={14} weight="bold" />}
                  {vendor?.ytdlp.ready ? '运行就绪' : '未就绪'}
                </span>
              </div>
              {vendor?.ytdlp && (
                <code
                  className="vendor-missing-path"
                  style={vendor.ytdlp.ready && vendor.ytdlp.missingFiles.length === 0 ? { color: 'var(--text-muted)', background: 'var(--bg-card-subtle)', borderColor: 'var(--border-subtle)' } : undefined}
                >
                  {vendor.ytdlp.directory}
                </code>
              )}
            </div>

            <div className="env-vendor-item">
              <div className="env-vendor-item-head">
                <span className="env-vendor-item-title">
                  FFmpeg 音视频转换处理库
                  {vendor?.ffmpeg && (
                    <span className="env-vendor-file-count">
                      {' '}· 文件 {vendor.ffmpeg.foundFiles.length} / {vendor.ffmpeg.expectedFiles.length}
                    </span>
                  )}
                </span>
                <span className={`env-vendor-status ${vendor?.ffmpeg.ready ? 'ready' : 'warn'}`}>
                  {vendor?.ffmpeg.ready ? <Check size={14} weight="bold" /> : <Warning size={14} weight="bold" />}
                  {vendor?.ffmpeg.ready ? '运行就绪' : '未就绪'}
                </span>
              </div>
              {vendor?.ffmpeg && (
                <>
                  <code
                    className="vendor-missing-path"
                    style={vendor.ffmpeg.ready && vendor.ffmpeg.missingFiles.length === 0 ? { color: 'var(--text-muted)', background: 'var(--bg-card-subtle)', borderColor: 'var(--border-subtle)' } : undefined}
                  >
                    {vendor.ffmpeg.directory}
                  </code>
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
            </div>
          </div>

          <p className="env-vendor-footnote">
            {isVendorOk
              ? '媒体组件路径可在「全局设置」中自定义；当前检测通过。'
              : '组件未就绪时下载或抽音会失败。请到「全局设置」核对 yt-dlp / FFmpeg 目录，补齐缺失文件后重新检测。'}
          </p>
        </section>

        <div className="section-header models-section-header">
          <h2>离线 AI 模型权重库</h2>
          <span>支持独立选择自定义模型存放路径</span>
        </div>

        <div className="model-deck">
          {runtime?.models.map((model) => {
            const shelved = isShelvedModel(model.id)
            return (
              <div className={`model-card-item${shelved ? ' is-shelved' : ''}`} key={model.id}>
                <div
                  className={`model-status-icon ${shelved ? 'shelved' : model.ready ? 'ready' : 'warn'}`}
                >
                  {shelved ? (
                    <PauseCircle weight="fill" />
                  ) : model.ready ? (
                    <CheckCircle weight="fill" />
                  ) : (
                    <FolderSimple weight="fill" />
                  )}
                </div>

                <div className="model-main-info">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <h4>{model.label}</h4>
                    <span className="panel-title-badge">{modelBadge(model.id)}</span>
                    <span className="panel-title-badge">{modelFormatBadge(model.format)}</span>
                    {shelved && (
                      <span
                        className="panel-title-badge"
                        style={{ color: '#b45309', background: '#fffbeb' }}
                      >
                        暂时下架
                      </span>
                    )}
                  </div>
                  <p title={model.directory}>{model.directory}</p>
                  {shelved ? (
                    <small className="model-shelved-hint">
                      翻译功能已暂时关闭；模型路径与权重检测仍保留，恢复功能后可继续使用。
                    </small>
                  ) : (
                    model.missingFiles.length > 0 && (
                      <small style={{ color: '#ef4444', fontSize: 11 }}>
                        缺少 {model.missingFiles.length} 项关键权重文件 ({model.missingFiles.slice(0, 3).join(', ')}…)
                      </small>
                    )
                  )}
                </div>

                <div className="model-file-count">
                  <div className={`model-file-badge${shelved ? ' is-shelved' : ''}`}>
                    {shelved
                      ? '功能下架'
                      : `${model.foundFiles} / ${model.expectedFiles} 文件就绪`}
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={shelved}
                    title={shelved ? '翻译功能暂时下架，路径更换已禁用' : undefined}
                    icon={<FolderOpen size={14} />}
                    onClick={() =>
                      handleChooseModel(modelPathKey(model.id), `选择 ${model.label} 文件夹`)
                    }
                  >
                    更换路径
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
