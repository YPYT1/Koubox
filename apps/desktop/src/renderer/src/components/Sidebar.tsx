import React, { useEffect, useRef, useState } from 'react'
import {
  AudioWaveform,
  Captions,
  ChevronRight,
  Cpu,
  Download,
  HardDrive,
  Layers3,
  Mic,
  MicVocal,
  NotebookText,
  Play,
  Settings,
  X,
  type LucideIcon
} from 'lucide-react'
import type { RuntimeStatus, TaskStatus, ToolId, ToolManifest } from '@koubox/shared'
import kouboxIcon from '../assets/koubox-icon.png'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

type FixedPage = 'home' | 'models' | 'copy-library' | 'settings'
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

const toolIcons: Record<ToolId, LucideIcon> = {
  'viral-materials': Play,
  'precise-srt': Captions,
  'video-downloader': Download,
  'video-audio': AudioWaveform,
  'vocal-separation': Mic,
  'speech-to-text': MicVocal
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

  const navBtn = (active: boolean) => cn(
    'nav-pressable h-10 w-full justify-start gap-2.5 rounded-md px-3 text-sm font-medium',
    active
      ? 'is-selected'
      : 'text-slate-600 hover:bg-white/80 hover:text-slate-900'
  )

  return (
    <aside className="sidebar relative flex h-full shrink-0 flex-col border-r border-border" ref={sidebarRef} style={{ width: 'var(--sidebar-width, 256px)' }}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="sidebar-brand flex items-center gap-3 px-4 py-4">
          <img className="size-9 rounded-md" src={kouboxIcon} alt="口播匣" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">口播匣</div>
            <div className="truncate text-xs text-muted-foreground">KOUBOX STUDIO</div>
          </div>
        </div>

        <nav aria-label="主导航" className="sidebar-navigation mx-3 grid gap-1.5">
          <Button type="button" variant="ghost" aria-current={focus.kind === 'fixed' && focus.page === 'home' ? 'page' : undefined} className={navBtn(focus.kind === 'fixed' && focus.page === 'home')} onClick={() => onSelectFixed('home')}>
            <HardDrive size={17} strokeWidth={1.8} /><span>工具箱</span>
          </Button>
          <Button type="button" variant="ghost" aria-current={focus.kind === 'fixed' && focus.page === 'models' ? 'page' : undefined} className={navBtn(focus.kind === 'fixed' && focus.page === 'models')} onClick={() => onSelectFixed('models')}>
            <Cpu size={17} strokeWidth={1.8} /><span>模型与环境</span>
          </Button>
          <Button type="button" variant="ghost" aria-current={focus.kind === 'fixed' && focus.page === 'copy-library' ? 'page' : undefined} className={navBtn(focus.kind === 'fixed' && focus.page === 'copy-library')} onClick={() => onSelectFixed('copy-library')}>
            <NotebookText size={17} strokeWidth={1.8} /><span>文案库</span>
          </Button>
          <Button type="button" variant="ghost" aria-current={focus.kind === 'fixed' && focus.page === 'settings' ? 'page' : undefined} className={navBtn(focus.kind === 'fixed' && focus.page === 'settings')} onClick={() => onSelectFixed('settings')}>
            <Settings size={17} strokeWidth={1.8} /><span>全局设置</span>
          </Button>
        </nav>

        <Separator className="mx-3 my-3 w-auto" />

        <div className="sidebar-opened mx-3 flex min-h-0 flex-1 flex-col">
          <div className="sidebar-opened-label">已打开工具</div>
          <ScrollArea className="min-h-0 flex-1">
            {opened.length === 0 ? (
              <div className="sidebar-tools-empty"><Layers3 size={22} strokeWidth={1.4} /><span>让灵感开始流动</span><small>从工具箱选择一个工具开始</small></div>
            ) : (
              <div className="sidebar-tool-groups">
                {opened.map((toolId) => {
                  const tool = tools.find((t) => t.id === toolId)
                  if (!tool) return null
                  const isFocused = focus.kind === 'tool' && focus.toolId === toolId
                  const isExpanded = Boolean(expanded[toolId])
                  const Icon = toolIcons[toolId]
                  const status = toolStatuses[toolId]

                  return (
                    <div className="sidebar-tool-group" key={toolId}>
                      <div className="sidebar-tool-heading">
                        <Button
                          type="button"
                          variant="ghost"
                          className={cn('sidebar-tool-button', isFocused && 'is-selected')}
                          aria-expanded={isExpanded}
                          onClick={() => {
                            const nextExpanded = !isExpanded
                            setExpanded((current) => ({ ...current, [toolId]: nextExpanded }))
                            if (nextExpanded) onSelectTool(toolId, isFocused ? focus.menu : tool.menus[0].id)
                          }}
                        >
                          <Icon size={16} strokeWidth={1.8} />
                          <span className="min-w-0 flex-1 truncate text-left">{tool.name}</span>
                          {status && (status === 'queued' || status === 'running') && (
                            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">{STATUS_LABEL[status]}</Badge>
                          )}
                          <ChevronRight className={cn('size-3.5 transition-transform', isExpanded && 'rotate-90')} strokeWidth={1.8} />
                        </Button>
                        <Button type="button" variant="ghost" size="icon-sm" title={`关闭 ${tool.name}`} aria-label={`关闭 ${tool.name}`} onClick={() => onCloseTool(toolId)}>
                          <X size={14} strokeWidth={1.8} />
                        </Button>
                      </div>
                      {isExpanded && (
                        <div className="sidebar-tool-menus">
                          {tool.menus.map((menu) => (
                            <Button
                              type="button"
                              key={menu.id}
                              variant="ghost"
                              className={cn('sidebar-tool-menu', isFocused && focus.menu === menu.id && 'is-sub-selected')}
                              aria-current={isFocused && focus.menu === menu.id ? 'page' : undefined}
                              onClick={() => onSelectTool(toolId, menu.id)}
                            >
                              {menu.label}
                            </Button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </ScrollArea>
        </div>
      </div>

      <div className="sidebar-runtime grid gap-2 px-4 py-3">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>本地引擎</span>
          <Badge variant="outline" className="gap-1.5 border-border bg-white text-primary">
            <span className="size-1.5 rounded-full bg-primary" /> {runtime?.healthy ? '已连接' : runtime ? '连接异常' : '连接中'}
          </Badge>
        </div>
        <Progress value={gpu?.available ? memoryPct : 0} className="h-1.5" />
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>VRAM 显存负载</span>
          <span>{gpu?.available ? `${formatMemory(usedMem)} / ${formatMemory(totalMem)}` : '等待 GPU'}</span>
        </div>
      </div>

      <div className="sidebar-resizer absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-primary/20" ref={resizerRef} title="拖拽调整侧边栏宽度" />
    </aside>
  )
}
