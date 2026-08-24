import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { tools as toolCatalog, type KouboxConfig, type RuntimeStatus, type TaskStatus, type ToolId, type ToolManifest } from '@koubox/shared'
import { Sidebar } from './components/Sidebar'
import { Toast, type ToastMessage } from './components/common/Toast'
import { HomePage } from './pages/HomePage'
import { ModelsPage } from './pages/ModelsPage'
import { SettingsPage } from './pages/SettingsPage'
import { RequirementOnePage } from './pages/RequirementOnePage'
import { RequirementTwoPage } from './pages/RequirementTwoPage'
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

  const showToast = (text: string, type: ToastMessage['type'] = 'info') => {
    setToast({ id: String(Date.now()), text, type })
  }

  const refreshRuntimeAndConfig = async () => {
    try {
      const [nextRuntime, nextConfig] = await Promise.all([
        window.koubox.get<RuntimeStatus>('/runtime/status'),
        window.koubox.get<KouboxConfig>('/config')
      ])
      setRuntime(nextRuntime)
      setConfig(nextConfig)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法连接本地服务', 'error')
    }
  }

  useEffect(() => {
    void refreshRuntimeAndConfig()
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
      await refreshRuntimeAndConfig()
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
              onRefresh={() => void refreshRuntimeAndConfig()}
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

          {focus.kind === 'tool' && focus.menu !== 'run' && (
            <TaskHistoryPage
              kind={focus.toolId === 'precise-srt' ? 'req2' : 'req1'}
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
