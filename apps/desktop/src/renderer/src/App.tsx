import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { tools as toolCatalog, TOOL_TASK_KIND, type KouboxConfig, type RuntimeStatus, type TaskStatus, type ToolId, type ToolManifest } from '@koubox/shared'
import { Sidebar } from './components/Sidebar'
import { Toast, type ToastMessage } from './components/common/Toast'
import { HomePage } from './pages/HomePage'
import { ModelsPage } from './pages/ModelsPage'
import { SettingsPage } from './pages/SettingsPage'
import { RequirementOnePage } from './pages/RequirementOnePage'
import { RequirementTwoPage } from './pages/RequirementTwoPage'
import { VideoDownloaderPage } from './pages/VideoDownloaderPage'
import { VideoAudioPage } from './pages/VideoAudioPage'
import { VocalSeparationPage } from './pages/VocalSeparationPage'
import { TaskHistoryPage } from './pages/TaskHistoryPage'

type FixedPage = 'home' | 'models' | 'settings'
type Focus = { kind: 'fixed'; page: FixedPage } | { kind: 'tool'; toolId: ToolId; menu: string }

function keepAlivePane(visible: boolean, child: ReactNode) {
  return (
    <div className="workspace-keep-alive" hidden={!visible} style={{ display: visible ? 'contents' : 'none' }}>
      {child}
    </div>
  )
}

export function App() {
  const tools = toolCatalog
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [config, setConfig] = useState<KouboxConfig | null>(null)
  const [focus, setFocus] = useState<Focus>({ kind: 'fixed', page: 'home' })
  const [opened, setOpened] = useState<ToolId[]>([])
  const [toolStatuses, setToolStatuses] = useState<Partial<Record<ToolId, TaskStatus>>>({})
  const [query, setQuery] = useState('')
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const refreshSequence = useRef(0)
  const startupRefreshStarted = useRef(false)

  const showToast = (text: string, type: ToastMessage['type'] = 'info') => {
    setToast({ id: String(Date.now()), text, type })
  }

  const refreshRuntimeAndConfig = async (reason = 'manual') => {
    const refreshId = ++refreshSequence.current
    const startedAt = performance.now()
    void window.koubox.logDebug('renderer 状态刷新开始', { refreshId, reason })
    let firstError: unknown
    try {
      const nextConfig = await window.koubox.get<KouboxConfig>('/config')
      setConfig(nextConfig)
      void window.koubox.logDebug('renderer 配置收到', {
        refreshId,
        durationMs: Math.round(performance.now() - startedAt),
        modelsDirectory: nextConfig.modelsDirectory,
        outputDirectory: nextConfig.outputDirectory
      })
    } catch (error) {
      firstError = error
      void window.koubox.logDebug('renderer 配置刷新失败', {
        refreshId,
        durationMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error)
      })
    }

    try {
      const nextRuntime = await window.koubox.get<RuntimeStatus>('/runtime/status')
      setRuntime(nextRuntime)
      void window.koubox.logDebug('renderer 运行时状态收到', {
        refreshId,
        durationMs: Math.round(performance.now() - startedAt),
        healthy: nextRuntime.healthy,
        modelCount: nextRuntime.models.length
      })
    } catch (error) {
      firstError ??= error
      void window.koubox.logDebug('renderer 运行时状态刷新失败', {
        refreshId,
        durationMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error)
      })
    }

    if (!firstError) {
      void window.koubox.logDebug('renderer 状态刷新完成', {
        refreshId,
        reason,
        durationMs: Math.round(performance.now() - startedAt)
      })
    } else {
      void window.koubox.logDebug('renderer 状态刷新失败', {
        refreshId,
        reason,
        durationMs: Math.round(performance.now() - startedAt),
        error: firstError instanceof Error ? firstError.message : String(firstError)
      })
      showToast(firstError instanceof Error ? firstError.message : '无法连接本地服务', 'error')
    }
  }

  useEffect(() => {
    if (startupRefreshStarted.current) return
    startupRefreshStarted.current = true
    void refreshRuntimeAndConfig('startup')
  }, [])

  const handleOpenTool = (tool: ToolManifest) => {
    setOpened((current) => (current.includes(tool.id) ? current : [...current, tool.id]))
    setFocus({ kind: 'tool', toolId: tool.id, menu: tool.menus[0].id })
  }

  const handleCloseTool = (toolId: ToolId) => {
    setOpened((current) => current.filter((id) => id !== toolId))
    setToolStatuses((current) => {
      const next = { ...current }
      delete next[toolId]
      return next
    })
    if (focus.kind === 'tool' && focus.toolId === toolId) {
      setFocus({ kind: 'fixed', page: 'home' })
    }
  }

  const bindToolStatus = (toolId: ToolId) => (status: TaskStatus | null) => {
    setToolStatuses((current) => {
      const next = { ...current }
      if (!status || status === 'complete' || status === 'error' || status === 'cancelled') {
        delete next[toolId]
        return next
      }
      next[toolId] = status
      return next
    })
  }

  const handleSelectToolMenu = (toolId: ToolId, menuId?: string) => {
    const tool = tools.find((t) => t.id === toolId)
    const targetMenu = menuId || tool?.menus[0].id || 'run'
    setFocus({ kind: 'tool', toolId, menu: targetMenu })
  }

  const handleChooseDirectory = async (
    title: string,
    defaultPath?: string
  ): Promise<string | undefined> => {
    const result = await window.koubox.post<{ path: string | null }>(
      '/dialog/select-directory',
      { title, defaultPath }
    )
    return result.path ?? undefined
  }

  const handleChooseAudio = async (
    title: string,
    defaultPath?: string
  ): Promise<string | undefined> => {
    const result = await window.koubox.post<{ path: string | null }>('/dialog/select-audio', {
      title,
      defaultPath
    })
    return result.path ?? undefined
  }

  const handleChooseVideo = async (
    title: string,
    defaultPath?: string
  ): Promise<string | undefined> => {
    const result = await window.koubox.post<{ path: string | null }>('/dialog/select-file', {
      title,
      defaultPath,
      filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'flv'] }]
    })
    return result.path ?? undefined
  }

  const handleChooseFile = async (
    title: string,
    defaultPath?: string,
    filters?: Array<{ name: string; extensions: string[] }>
  ): Promise<string | undefined> => {
    const result = await window.koubox.post<{ path: string | null }>('/dialog/select-file', {
      title,
      defaultPath,
      filters
    })
    return result.path ?? undefined
  }

  const handleSaveConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!config) return
    try {
      const updated = await window.koubox.put<KouboxConfig>('/config', config)
      setConfig(updated)
      showToast('全局配置已保存', 'success')
      await refreshRuntimeAndConfig('config-save')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存失败', 'error')
    }
  }

  return (
    <div className="desktop-shell">
      <div className="app-body">
        {/* 左侧可拖拽调宽工作台侧栏 */}
        <Sidebar
          tools={tools}
          runtime={runtime}
          focus={focus}
          opened={opened}
          toolStatuses={toolStatuses}
          onSelectFixed={(page) => setFocus({ kind: 'fixed', page })}
          onSelectTool={handleSelectToolMenu}
          onCloseTool={handleCloseTool}
        />

        {/* 主视窗 Workspace Viewport */}
        <main className="workspace-viewport">
          {focus.kind === 'fixed' && focus.page === 'home' && (
            <HomePage
              tools={tools}
              query={query}
              onQueryChange={setQuery}
              onOpenTool={handleOpenTool}
            />
          )}

          {focus.kind === 'fixed' && focus.page === 'models' && (
            <ModelsPage
              runtime={runtime}
              config={config}
              onRefresh={() => void refreshRuntimeAndConfig('models-page')}
              onChooseDirectory={handleChooseDirectory}
              onShowToast={showToast}
              onConfigChange={setConfig}
            />
          )}

          {focus.kind === 'fixed' && focus.page === 'settings' && config && (
            <SettingsPage
              config={config}
              runtime={runtime}
              onChange={setConfig}
              onSave={handleSaveConfig}
              onChooseDirectory={handleChooseDirectory}
              onChooseFile={handleChooseFile}
              onShowToast={showToast}
            />
          )}

          {opened.includes('viral-materials') && keepAlivePane(
            focus.kind === 'tool' && focus.toolId === 'viral-materials' && focus.menu === 'run',
            <RequirementOnePage
              defaultOutputDirectory={config?.outputDirectory ?? ''}
              translationTargetLanguage={config?.translationTargetLanguage ?? 'zh-Hans'}
              openOutputOnComplete={config?.openOutputOnComplete ?? false}
              onChooseDirectory={handleChooseDirectory}
              onChooseVideoFile={handleChooseVideo}
              onShowToast={showToast}
              onTaskStatus={bindToolStatus('viral-materials')}
            />
          )}

          {opened.includes('precise-srt') && keepAlivePane(
            focus.kind === 'tool' && focus.toolId === 'precise-srt' && focus.menu === 'run',
            <RequirementTwoPage
              defaultOutputDirectory={config?.outputDirectory ?? ''}
              openOutputOnComplete={config?.openOutputOnComplete ?? false}
              onChooseDirectory={handleChooseDirectory}
              onChooseAudioFile={handleChooseAudio}
              onShowToast={showToast}
              onTaskStatus={bindToolStatus('precise-srt')}
            />
          )}

          {opened.includes('video-downloader') && keepAlivePane(
            focus.kind === 'tool' && focus.toolId === 'video-downloader' && focus.menu === 'run',
            <VideoDownloaderPage
              defaultOutputDirectory={config?.outputDirectory ?? ''}
              onChooseDirectory={handleChooseDirectory}
              onShowToast={showToast}
              onTaskStatus={bindToolStatus('video-downloader')}
            />
          )}

          {opened.includes('video-audio') && keepAlivePane(
            focus.kind === 'tool' && focus.toolId === 'video-audio' && focus.menu === 'run',
            <VideoAudioPage
              defaultOutputDirectory={config?.outputDirectory ?? ''}
              openOutputOnComplete={config?.openOutputOnComplete ?? false}
              onChooseDirectory={handleChooseDirectory}
              onChooseVideoFile={handleChooseVideo}
              onShowToast={showToast}
              onTaskStatus={bindToolStatus('video-audio')}
            />
          )}

          {opened.includes('vocal-separation') && keepAlivePane(
            focus.kind === 'tool' && focus.toolId === 'vocal-separation' && focus.menu === 'run',
            <VocalSeparationPage
              defaultOutputDirectory={config?.outputDirectory ?? ''}
              openOutputOnComplete={config?.openOutputOnComplete ?? false}
              onChooseDirectory={handleChooseDirectory}
              onChooseAudioFile={handleChooseAudio}
              onShowToast={showToast}
              onTaskStatus={bindToolStatus('vocal-separation')}
            />
          )}

          {focus.kind === 'tool' && focus.menu !== 'run' && (
            <TaskHistoryPage
              kind={TOOL_TASK_KIND[focus.toolId]}
              outputDirectory={config?.outputDirectory ?? ''}
              onShowToast={showToast}
            />
          )}
        </main>
      </div>

      {/* 全局反馈 Toast */}
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  )
}
