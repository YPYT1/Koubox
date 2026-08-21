import { useEffect, useState } from 'react'
import {
  ArrowClockwise, CaretRight, CheckCircle, ClipboardText, Copy, Cpu, DownloadSimple,
  FolderOpen, FolderSimple, GearSix, HardDrives, MagnifyingGlass, Play, Subtitles, X
} from '@phosphor-icons/react'
import type { KouboxConfig, RuntimeStatus, TaskEvent, TaskSnapshot, ToolId, ToolManifest } from '@koubox/shared'

type FixedPage = 'home' | 'models' | 'settings'
type Focus = { kind: 'fixed'; page: FixedPage } | { kind: 'tool'; toolId: ToolId; menu: string }

const icons = { 'viral-materials': Play, 'precise-srt': Subtitles }
function formatMemory(value?: number): string { return value === undefined ? '—' : `${(value / 1024).toFixed(1)} GB` }

export function App() {
  const [tools, setTools] = useState<ToolManifest[]>([])
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [config, setConfig] = useState<KouboxConfig | null>(null)
  const [focus, setFocus] = useState<Focus>({ kind: 'fixed', page: 'home' })
  const [opened, setOpened] = useState<ToolId[]>([])
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const [nextTools, nextRuntime, nextConfig] = await Promise.all([
        window.koubox.get<ToolManifest[]>('/tools'),
        window.koubox.get<RuntimeStatus>('/runtime/status'),
        window.koubox.get<KouboxConfig>('/config')
      ])
      setTools(nextTools); setRuntime(nextRuntime); setConfig(nextConfig)
    } catch (error) { setNotice(error instanceof Error ? error.message : '无法连接本地服务。') }
  }

  useEffect(() => { void refresh() }, [])
  const filteredTools = tools.filter((tool) => `${tool.name}${tool.description}`.toLowerCase().includes(query.toLowerCase()))
  const activeTool = focus.kind === 'tool' ? tools.find((tool) => tool.id === focus.toolId) : undefined
  const openTool = (tool: ToolManifest) => {
    setOpened((current) => current.includes(tool.id) ? current : [...current, tool.id])
    setFocus({ kind: 'tool', toolId: tool.id, menu: tool.menus[0].id })
  }
  const closeTool = (toolId: ToolId) => {
    setOpened((current) => current.filter((id) => id !== toolId))
    if (focus.kind === 'tool' && focus.toolId === toolId) setFocus({ kind: 'fixed', page: 'home' })
  }
  const chooseDirectory = async (title: string, defaultPath?: string): Promise<string | undefined> => {
    const result = await window.koubox.post<{ path: string | null }>('/dialog/select-directory', { title, defaultPath })
    return result.path ?? undefined
  }
  const saveConfig = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!config) return
    try { setConfig(await window.koubox.put<KouboxConfig>('/config', config)); setNotice('本地配置已保存。'); await refresh() }
    catch (error) { setNotice(error instanceof Error ? error.message : '保存失败。') }
  }

  return <div className="desktop-shell"><div className="app-body">
    <aside className="sidebar">
      <div className="sidebar-title">工作区</div>
      <nav className="primary-nav" aria-label="主导航">
        <NavButton icon={<HardDrives />} label="工具箱" active={focus.kind === 'fixed' && focus.page === 'home'} onClick={() => setFocus({ kind: 'fixed', page: 'home' })} />
        <NavButton icon={<Cpu />} label="模型与环境" active={focus.kind === 'fixed' && focus.page === 'models'} onClick={() => setFocus({ kind: 'fixed', page: 'models' })} />
        <NavButton icon={<GearSix />} label="全局设置" active={focus.kind === 'fixed' && focus.page === 'settings'} onClick={() => setFocus({ kind: 'fixed', page: 'settings' })} />
      </nav>
      <div className="opened-label">已打开</div>
      <div className="opened-list">
        {opened.length === 0 && <div className="empty-sessions">暂无打开的工具</div>}
        {opened.map((id) => {
          const tool = tools.find((item) => item.id === id); if (!tool) return null
          const expanded = focus.kind === 'tool' && focus.toolId === id; const Icon = icons[id]
          return <div className={`tool-session ${expanded ? 'expanded' : ''}`} key={id}>
            <div className="tool-session-head"><button onClick={() => setFocus({ kind: 'tool', toolId: id, menu: tool.menus[0].id })}><Icon /><span>{tool.name}</span><CaretRight className="caret" /></button><button className="icon-button" aria-label={`关闭${tool.name}`} onClick={() => closeTool(id)}><X /></button></div>
            {expanded && <div className="tool-submenu">{tool.menus.map((menu) => <button key={menu.id} className={focus.menu === menu.id ? 'active' : ''} onClick={() => setFocus({ kind: 'tool', toolId: id, menu: menu.id })}>{menu.label}</button>)}</div>}
          </div>
        })}
      </div>
      <div className="runtime-monitor"><div><span>本地服务</span><b><span className="status-dot" />HTTP 已保护</b></div><div className="memory-meter"><span style={{ width: runtime?.gpu.totalMemoryMiB && runtime.gpu.usedMemoryMiB ? `${Math.min(100, runtime.gpu.usedMemoryMiB / runtime.gpu.totalMemoryMiB * 100)}%` : '4%' }} /></div><small>{runtime?.gpu.available ? `${formatMemory(runtime.gpu.usedMemoryMiB)} / ${formatMemory(runtime.gpu.totalMemoryMiB)}` : '等待 GPU 运行时'}</small></div>
    </aside>
    <main className="workspace">
      {focus.kind === 'fixed' && focus.page === 'home' && <Home tools={filteredTools} query={query} onQuery={setQuery} onOpen={openTool} />}
      {focus.kind === 'fixed' && focus.page === 'models' && <Models runtime={runtime} onRefresh={() => void refresh()} />}
      {focus.kind === 'fixed' && focus.page === 'settings' && config && <Settings config={config} onChange={setConfig} onSave={saveConfig} onChoose={chooseDirectory} />}
      {activeTool && <ToolWorkspace tool={activeTool} menu={focus.kind === 'tool' ? focus.menu : 'run'} defaultOutputDirectory={config?.outputDirectory ?? ''} onChoose={chooseDirectory} onNotice={setNotice} />}
    </main>
  </div>{notice && <div className="toast" role="status">{notice}<button aria-label="关闭提示" onClick={() => setNotice(null)}><X /></button></div>}</div>
}

function NavButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick(): void }) { return <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span></button> }
function ArtifactTag({ tag }: { tag: string }) { return <span className={`artifact-tag artifact-${tag.toLowerCase()}`}>{tag}</span> }

function Home({ tools, query, onQuery, onOpen }: { tools: ToolManifest[]; query: string; onQuery(value: string): void; onOpen(tool: ToolManifest): void }) {
  return <section className="home-page"><div className="workspace-toolbar"><form className="search-box" onSubmit={(event) => event.preventDefault()}><MagnifyingGlass /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索工具、能力或流程…" autoFocus /><button className="search-submit" type="submit">搜索</button></form></div><div className="page-heading"><h1>工具箱</h1></div><div className="tool-grid">{tools.map((tool) => { const Icon = icons[tool.id]; return <article className={`tool-card ${tool.accent}`} key={tool.id}><div className="card-top"><div className="tool-icon"><Icon weight="duotone" /></div></div><h2>{tool.name}</h2><p>{tool.description}</p><div className="artifact-row">{tool.artifactTags.map((tag) => <ArtifactTag key={tag} tag={tag} />)}</div><button onClick={() => onOpen(tool)}>打开工具 <CaretRight weight="bold" /></button></article> })}</div>{tools.length === 0 && <div className="empty-results">没有匹配的工具。</div>}</section>
}

function Models({ runtime, onRefresh }: { runtime: RuntimeStatus | null; onRefresh(): void }) {
  const gpu = runtime?.gpu; const vendorReady = runtime?.vendor.ffmpeg && runtime?.vendor.ytdlp
  return <section className="detail-page"><div className="page-heading"><h1>模型与环境</h1></div><div className="environment-summary"><div><Cpu weight="duotone" /><span>计算设备</span><b>{gpu?.name ?? '未检测到 NVIDIA GPU'}</b><small>{gpu?.message ?? '读取中…'}</small>{gpu?.available && <div className="gpu-memory"><span>总显存 <b>{formatMemory(gpu.totalMemoryMiB)}</b></span><span>已用 <b>{formatMemory(gpu.usedMemoryMiB)}</b></span><span>剩余 <b>{formatMemory(gpu.freeMemoryMiB)}</b></span></div>}</div><div className={`embedded-check ${vendorReady ? 'ready' : 'warning'}`}><CheckCircle weight="fill" /><span>{vendorReady ? '媒体组件可用' : '媒体组件不可用'}</span></div><button onClick={onRefresh}><ArrowClockwise />重新检测</button></div><div className="model-list">{runtime?.models.map((model) => <article className="model-row" key={model.id}><div className={`model-state ${model.ready ? 'good' : 'warn'}`}>{model.ready ? <CheckCircle weight="fill" /> : <FolderSimple weight="fill" />}</div><div className="model-info"><span>{model.id === 'asr' ? '语音识别' : '翻译'}</span><h2>{model.label}</h2><p>{model.directory}</p></div><div className="model-files"><b>{model.foundFiles} / {model.expectedFiles}</b><span>文件</span></div></article>)}</div></section>
}

function Settings({ config, onChange, onSave, onChoose }: { config: KouboxConfig; onChange(value: KouboxConfig): void; onSave(event: React.FormEvent<HTMLFormElement>): void; onChoose(title: string, defaultPath?: string): Promise<string | undefined> }) {
  const field = (key: keyof KouboxConfig, label: string, hint: string) => <label className="field"><span>{label}</span><div className="path-input"><input type="text" value={config[key]} onChange={(event) => onChange({ ...config, [key]: event.target.value })} /><button type="button" onClick={async () => { const path = await onChoose(`选择${label}`, config[key]); if (path) onChange({ ...config, [key]: path }) }}><FolderOpen />选择</button></div><small>{hint}</small></label>
  return <section className="detail-page"><div className="page-heading"><h1>全局设置</h1></div><form className="settings-form" onSubmit={onSave}>{field('modelsDirectory', 'Models 目录', '模型所在的文件夹。')}{field('outputDirectory', '输出目录', '下载和生成的文件保存位置。')}<button className="primary-action" type="submit"><CheckCircle weight="fill" />保存</button></form></section>
}

function ToolWorkspace({ tool, menu, defaultOutputDirectory, onChoose, onNotice }: { tool: ToolManifest; menu: string; defaultOutputDirectory: string; onChoose(title: string, defaultPath?: string): Promise<string | undefined>; onNotice(message: string): void }) {
  const isRequirementOne = tool.id === 'viral-materials'
  if (!isRequirementOne || menu !== 'run') return <section className="tool-workspace"><div className="workspace-title"><div className={`tool-icon ${tool.accent}`}><(icons[tool.id]) weight="duotone" /></div><h1>{tool.name}</h1></div><div className="empty-panel"><ClipboardText weight="duotone" /><h2>{tool.menus.find((item) => item.id === menu)?.label}</h2><p>这里还没有内容。</p></div></section>
  return <RequirementOne defaultOutputDirectory={defaultOutputDirectory} onChoose={onChoose} onNotice={onNotice} />
}

function RequirementOne({ defaultOutputDirectory, onChoose, onNotice }: { defaultOutputDirectory: string; onChoose(title: string, defaultPath?: string): Promise<string | undefined>; onNotice(message: string): void }) {
  const [url, setUrl] = useState(''); const [outputDirectory, setOutputDirectory] = useState(defaultOutputDirectory); const [task, setTask] = useState<TaskSnapshot | null>(null); const [starting, setStarting] = useState(false); const [translating, setTranslating] = useState(false)
  useEffect(() => { if (!outputDirectory && defaultOutputDirectory) setOutputDirectory(defaultOutputDirectory) }, [defaultOutputDirectory, outputDirectory])
  useEffect(() => { if (!task?.taskId) return window.koubox.events<TaskEvent>(`/tasks/${encodeURIComponent(task.taskId)}/events`, (event) => setTask(event.task)) }, [task?.taskId])
  const start = async () => { if (!/^https?:\/\//i.test(url.trim())) return onNotice('请输入有效的视频链接。'); if (!outputDirectory.trim()) return onNotice('请选择输出目录。'); setStarting(true); try { const next = await window.koubox.post<TaskSnapshot>('/pipelines/req1', { url: url.trim(), outputDirectory }); setTask(next) } catch (error) { onNotice(error instanceof Error ? error.message : '任务启动失败。') } finally { setStarting(false) } }
  const translate = async () => { if (!task) return; setTranslating(true); try { setTask(await window.koubox.post<TaskSnapshot>(`/tasks/${encodeURIComponent(task.taskId)}/translate`, { source: 'transcript' })) } catch (error) { onNotice(error instanceof Error ? error.message : '翻译失败。') } finally { setTranslating(false) } }
  const cancel = async () => { if (task) setTask(await window.koubox.post<TaskSnapshot>(`/tasks/${encodeURIComponent(task.taskId)}/cancel`)) }
  const exportFiles = async () => { if (!task) return; const directory = await onChoose('选择另存目录', outputDirectory); if (!directory) return; try { await window.koubox.post(`/tasks/${encodeURIComponent(task.taskId)}/export`, { targetDirectory: directory }); onNotice('文件已另存。') } catch (error) { onNotice(error instanceof Error ? error.message : '另存失败。') } }
  const copy = async (text: string) => { await navigator.clipboard.writeText(text); onNotice('内容已复制。') }
  const steps: Array<[string, string]> = [['下载视频', 'download'], ['提取音频', 'extract-audio'], ['语音识别', 'asr'], ['翻译', 'translation']]
  const stateFor = (stage: string, index: number) => !task ? 'pending' : task.stage === stage ? 'current' : ['complete'].includes(task.status) || steps.findIndex((item) => item[1] === task.stage) > index ? 'done' : 'pending'
  return <section className="tool-workspace"><div className="workspace-title"><div className="tool-icon"><Play weight="duotone" /></div><h1>爆款素材获取</h1></div><div className="pipeline-layout"><div className="input-panel"><h2>视频链接</h2><label className="field"><span>链接</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="粘贴 YouTube / TikTok / Instagram / Facebook 链接" disabled={Boolean(task)} /></label><label className="field"><span>输出目录</span><div className="path-input"><input value={outputDirectory} onChange={(event) => setOutputDirectory(event.target.value)} disabled={Boolean(task)} /><button type="button" onClick={async () => { const path = await onChoose('选择输出目录', outputDirectory); if (path) setOutputDirectory(path) }} disabled={Boolean(task)}><FolderOpen />选择</button></div></label>{!task ? <button className="primary-action" onClick={() => void start()} disabled={starting}><DownloadSimple />{starting ? '正在启动…' : '开始处理'}</button> : <button className="primary-action" onClick={() => void cancel()} disabled={['complete', 'error', 'cancelled'].includes(task.status)}><X />取消任务</button>}</div><div className="pipeline-panel"><h2>处理步骤</h2><div className="pipeline">{steps.map(([label, stage], index) => <div className={`pipeline-step ${stateFor(stage, index)}`} key={stage}><span>{index + 1}</span><b>{label}</b><small>{task?.stage === stage ? `${task.percent}%` : task && stateFor(stage, index) === 'done' ? '完成' : '未开始'}</small></div>)}</div>{task && <p className="input-note">{task.message}</p>}</div></div>{task?.transcript && <ResultPanel title={`原文${task.language ? ` · ${task.language}` : ''}`} text={task.transcript.segments.map((segment) => segment.text.trim()).filter(Boolean).join('\n')} onCopy={copy} action={task.translation ? undefined : translate} actionLabel={translating ? '翻译中…' : '翻译成中文'} disabled={translating || task.status === 'error'} />}{task?.translation && <ResultPanel title="中文译文" text={task.translation} onCopy={copy} action={exportFiles} actionLabel="另存文件" />}{task && <div className="task-footer"><span>{task.taskDirectory}</span>{task.status === 'error' && <b>{task.error?.message}</b>}{task.status === 'complete' && <button onClick={() => void exportFiles()}>另存全部文件</button>}</div>}</section>
}

function ResultPanel({ title, text, onCopy, action, actionLabel, disabled }: { title: string; text: string; onCopy(text: string): void; action?: () => void; actionLabel?: string; disabled?: boolean }) { return <section className="result-panel"><div className="result-head"><h2>{title}</h2><div><button onClick={() => void onCopy(text)}><Copy />复制</button>{action && <button onClick={action} disabled={disabled}>{actionLabel}</button>}</div></div><pre>{text}</pre></section> }
