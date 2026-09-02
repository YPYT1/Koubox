import React, { useEffect, useRef, useState } from 'react'
import {
  HardDrives,
  Cpu,
  GearSix,
  CaretRight,
  X,
  Play,
  Subtitles,
  DownloadSimple,
  Waveform,
  Microphone,
  MicrophoneStage
} from '@phosphor-icons/react'
import type { RuntimeStatus, TaskStatus, ToolId, ToolManifest } from '@koubox/shared'
import kouboxIcon from '../assets/koubox-icon.png'

type FixedPage = 'home' | 'models' | 'settings'
type Focus = { kind: 'fixed'; page: FixedPage } | { kind: 'tool'; toolId: ToolId; menu: string }

type SidebarProps = {
  tools: ToolManifest[]
  runtime: RuntimeStatus | null
  focus: Focus
  opened: ToolId[]
  toolStatuses: Partial<Record<ToolId, TaskStatus>>
  onSelectFixed: (page: FixedPage) => void
  onSelectTool: (toolId: ToolId, menuId?: string) => void
  onCloseTool: (toolId: ToolId) => void
}

const toolIcons: Record<ToolId, React.ComponentType<{ size?: number; weight?: 'bold' | 'duotone' | 'fill' | 'regular' }>> = {
  'viral-materials': Play,
  'precise-srt': Subtitles,
  'video-downloader': DownloadSimple,
  'video-audio': Waveform,
  'vocal-separation': Microphone,
  'speech-to-text': MicrophoneStage
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '运行中',
  complete: '已完成',
  error: '失败',
  cancelled: '已取消'
}

function formatMemory(value?: number): string {
  return value === undefined ? '—' : `${(value / 1024).toFixed(1)} GB`
}

export function Sidebar({
  tools,
  runtime,
  focus,
  opened,
  toolStatuses,
  onSelectFixed,
  onSelectTool,
  onCloseTool
}: SidebarProps) {
  const sidebarRef = useRef<HTMLElement>(null)
  const resizerRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<Partial<Record<ToolId, boolean>>>({})

  useEffect(() => {
    setExpanded((current) => {
      const next = { ...current }
      for (const toolId of opened) {
        if (next[toolId] === undefined) next[toolId] = true
      }
      for (const key of Object.keys(next) as ToolId[]) {
        if (!opened.includes(key)) delete next[key]
      }
      return next
    })
  }, [opened])

  useEffect(() => {
    if (focus.kind !== 'tool') return
    setExpanded((current) => ({ ...current, [focus.toolId]: true }))
  }, [focus])

  useEffect(() => {
    const sidebar = sidebarRef.current
    const resizer = resizerRef.current
    if (!sidebar || !resizer) return

    const savedWidth = Number(localStorage.getItem('koubox-sidebar-w') || 256)
    if (savedWidth >= 190 && savedWidth <= 420) {
      sidebar.style.width = `${savedWidth}px`
      document.documentElement.style.setProperty('--sidebar-width', `${savedWidth}px`)
    }

    let startX = 0
    let startW = 0

    const onMouseMove = (e: MouseEvent) => {
      const newW = Math.min(420, Math.max(190, startW + (e.clientX - startX)))
      sidebar.style.width = `${newW}px`
      document.documentElement.style.setProperty('--sidebar-width', `${newW}px`)
    }

    const onMouseUp = () => {
      document.body.classList.remove('is-resizing')
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      const finalW = Math.round(sidebar.getBoundingClientRect().width)
      localStorage.setItem('koubox-sidebar-w', String(finalW))
    }

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault()
      startX = e.clientX
      startW = sidebar.getBoundingClientRect().width
      document.body.classList.add('is-resizing')
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    }

    resizer.addEventListener('mousedown', onMouseDown)
    return () => {
      resizer.removeEventListener('mousedown', onMouseDown)
    }
  }, [])

  const gpu = runtime?.gpu
  const usedMem = gpu?.usedMemoryMiB ?? 0
  const totalMem = gpu?.totalMemoryMiB ?? 0
  const memoryPct = totalMem > 0 ? Math.min(100, (usedMem / totalMem) * 100) : 0

  return (
    <aside className="sidebar" ref={sidebarRef}>
      <div className="sidebar-content">
        <div className="sidebar-brand">
          <img className="sidebar-brand-icon" src={kouboxIcon} alt="口播匣" />
          <div className="sidebar-brand-text">
            <strong>口播匣</strong>
            <span>本地口播工作台</span>
          </div>
        </div>

        <div className="sidebar-section">
          <button
            type="button"
            className={`nav-item ${focus.kind === 'fixed' && focus.page === 'home' ? 'active' : ''}`}
            onClick={() => onSelectFixed('home')}
          >
            <HardDrives size={17} weight="bold" />
            <span>工具箱</span>
          </button>
          <button
            type="button"
            className={`nav-item ${focus.kind === 'fixed' && focus.page === 'models' ? 'active' : ''}`}
            onClick={() => onSelectFixed('models')}
          >
            <Cpu size={17} weight="bold" />
            <span>模型与环境</span>
          </button>
          <button
            type="button"
            className={`nav-item ${focus.kind === 'fixed' && focus.page === 'settings' ? 'active' : ''}`}
            onClick={() => onSelectFixed('settings')}
          >
            <GearSix size={17} weight="bold" />
            <span>全局设置</span>
          </button>
        </div>

        <div className="sidebar-section" style={{ flex: 1 }}>
          <div className="sidebar-label">已打开工具</div>
          {opened.length === 0 ? (
            <div className="empty-sessions-hint">暂无打开的工具</div>
          ) : (
            opened.map((toolId) => {
              const tool = tools.find((t) => t.id === toolId)
              if (!tool) return null
              const isFocused = focus.kind === 'tool' && focus.toolId === toolId
              const isExpanded = Boolean(expanded[toolId])
              const Icon = toolIcons[toolId]
              const status = toolStatuses[toolId]

              return (
                <div className={`opened-session ${isExpanded ? 'expanded' : ''}`} key={toolId}>
                  <div className="session-head">
                    <button
                      type="button"
                      className="session-trigger"
                      onClick={() => {
                        const nextExpanded = !isExpanded
                        setExpanded((current) => ({ ...current, [toolId]: nextExpanded }))
                        if (nextExpanded) {
                          onSelectTool(toolId, isFocused ? focus.menu : tool.menus[0].id)
                        }
                      }}
                    >
                      <Icon size={16} weight="bold" />
                      <span className="session-title">{tool.name}</span>
                      {status && (status === 'queued' || status === 'running') && (
                        <span className={`session-status-pill status-${status}`}>
                          {STATUS_LABEL[status]}
                        </span>
                      )}
                      <CaretRight className="session-caret" size={13} weight="bold" />
                    </button>
                    <button
                      type="button"
                      className="session-close-btn"
                      title={`关闭 ${tool.name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onCloseTool(toolId)
                      }}
                    >
                      <X size={14} />
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="session-subnav">
                      {tool.menus.map((menu) => (
                        <button
                          type="button"
                          key={menu.id}
                          className={`subnav-btn ${isFocused && focus.menu === menu.id ? 'active' : ''}`}
                          onClick={() => onSelectTool(toolId, menu.id)}
                        >
                          {menu.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>

      <div className="sidebar-footer">
        <div className="footer-row">
          <span>本地引擎状态</span>
          <span className="footer-badge">
            <span className="pulse-dot" /> HTTP 守护就绪
          </span>
        </div>
        <div className="vram-mini-progress">
          <div className="vram-mini-fill" style={{ width: `${gpu?.available ? memoryPct : 4}%` }} />
        </div>
        <div className="vram-mini-text">
          <span>VRAM 显存负载</span>
          <span>{gpu?.available ? `${formatMemory(usedMem)} / ${formatMemory(totalMem)}` : '等待 GPU'}</span>
        </div>
      </div>

      <div className="sidebar-resizer" ref={resizerRef} title="拖拽调整侧边栏宽度" />
    </aside>
  )
}
