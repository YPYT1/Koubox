import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CopyEntry, CopyEntryKind, LanDevice, LanTransfer } from '@koubox/shared'
import { ArrowLeft, Check, ChevronDown, FileText, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { LanDevicePickerDialog } from '../components/lan/LanDevicePickerDialog'
import { LanTransferDialog } from '../components/lan/LanTransferDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

type Props = {
  onShowToast: (text: string, type?: 'info' | 'success' | 'warning' | 'error') => void
  registerLeaveGuard: (guard: ((proceed: () => void) => void) | null) => void
}
type TagDialog = { mode: 'create' | 'rename' | 'delete'; original: string; value: string; attachToDraft?: boolean }
const TAG_PALETTE = ['#2563eb', '#7c3aed', '#0f766e', '#be185d']
const kindLabel = (kind: CopyEntryKind) => kind === 'original' ? '原文' : kind === 'translation' ? '译文' : '转写'
function tagColor(tag: string) {
  let hash = 0
  for (const char of tag) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return TAG_PALETTE[hash % TAG_PALETTE.length]
}
function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
const draftSignature = (entry: CopyEntry) => JSON.stringify([entry.title, entry.content, entry.kind, entry.tags])
const renderTag = (tag: string) => <span key={tag} className="copy-capsule" style={{ ['--tag-tint' as string]: tagColor(tag) }}>{tag}</span>

export function CopyLibraryPage({ onShowToast, registerLeaveGuard }: Props) {
  const [entries, setEntries] = useState<CopyEntry[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [editing, setEditing] = useState<CopyEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null)
  const [detailVisible, setDetailVisible] = useState(false)
  const [compact, setCompact] = useState(false)
  const [editorWidth, setEditorWidth] = useState(0)
  const [tagDialog, setTagDialog] = useState<TagDialog | null>(null)
  const [devices, setDevices] = useState<LanDevice[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [deviceSelection, setDeviceSelection] = useState<string[]>([])
  const [transfers, setTransfers] = useState<LanTransfer[]>([])
  const [transferOpen, setTransferOpen] = useState(false)
  const containerRef = useRef<HTMLElement>(null)
  const detailRef = useRef<HTMLElement>(null)
  const noteScrollRef = useRef<HTMLElement>(null)
  const focusNewNote = useRef(false)
  const noteBodyRef = useRef<HTMLTextAreaElement>(null)
  const noteTitleRef = useRef<HTMLTextAreaElement>(null)
  const requestSequence = useRef(0)
  const savingRef = useRef(false)
  const busyRef = useRef(false)
  const initialDraft = useRef('')
  const draftRef = useRef<CopyEntry | null>(null)
  const saveInFlight = useRef<Promise<boolean> | null>(null)
  const transitionInFlight = useRef(false)
  const queuedTransition = useRef<(() => void) | null>(null)
  const [lastSaved, setLastSaved] = useState('')
  draftRef.current = editing
  const preferredId = useRef<string | null>(null)
  const shareIds = useRef<string[]>([])
  const dirty = Boolean(editing && draftSignature(editing) !== initialDraft.current)
  const shown = useMemo(() => selectedTags.length
    ? entries.filter((entry) => (dirty && entry.id === editing?.id) || selectedTags.some((tag) => entry.tags.includes(tag)))
    : entries, [entries, selectedTags, editing?.id, dirty])
  const visibleSelected = selected.filter((id) => shown.some((entry) => entry.id === id))
  const allSelected = shown.length > 0 && visibleSelected.length === shown.length
  const characterCount = editing ? Array.from(editing.content.replace(/\s/g, '')).length : 0
  const previewEntry = shown.find((entry) => entry.id === previewId) ?? null

  const refresh = async (search = query) => {
    const sequence = ++requestSequence.current
    setLoading(true)
    setLoadError('')
    try {
      const [next, nextTags] = await Promise.all([
        window.koubox.get<CopyEntry[]>(`/copy-library?q=${encodeURIComponent(search)}`),
        window.koubox.get<string[]>('/copy-library/tags')
      ])
      if (sequence !== requestSequence.current) return
      setEntries(next)
      setTags(nextTags)
      const currentDraft = draftRef.current
      if (currentDraft?.id && draftSignature(currentDraft) === initialDraft.current) {
        const refreshed = next.find((entry) => entry.id === currentDraft.id)
        if (refreshed) {
          const draft = { ...refreshed, tags: [...refreshed.tags] }
          initialDraft.current = draftSignature(draft)
          draftRef.current = draft
          setEditing(draft)
        }
      }
      setSelectedTags((current) => current.filter((tag) => nextTags.includes(tag)))
    } catch (error) {
      if (sequence !== requestSequence.current) return
      setEntries([])
      setLoadError(error instanceof Error ? error.message : '文案加载失败')
    } finally {
      if (sequence === requestSequence.current) setLoading(false)
    }
  }
  useEffect(() => {
    void refresh()
    return () => { requestSequence.current += 1 }
  }, [query])
  useEffect(() => {
    if (loading) return
    setSelected((current) => current.filter((id) => shown.some((entry) => entry.id === id)))
    if (editing && !editing.id) return
    setPreviewId((current) => {
      const desired = preferredId.current
      if (desired && shown.some((entry) => entry.id === desired)) {
        preferredId.current = null
        return desired
      }
      return shown.some((entry) => entry.id === current) ? current : shown[0]?.id ?? null
    })
  }, [shown, loading])
  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < 720))
    observer.observe(containerRef.current)
    const editorObserver = new ResizeObserver(([entry]) => setEditorWidth(entry.contentRect.width))
    if (detailRef.current) editorObserver.observe(detailRef.current)
    return () => { observer.disconnect(); editorObserver.disconnect() }
  }, [])
  useLayoutEffect(() => {
    const scroller = noteScrollRef.current
    if (!scroller || scroller.clientWidth === 0) return
    const scrollTop = scroller.scrollTop
    for (const field of [noteTitleRef.current, noteBodyRef.current]) {
      if (!field) continue
      field.style.height = '0px'
      field.style.height = `${field.scrollHeight + 2}px`
    }
    scroller.scrollTop = scrollTop
    if (focusNewNote.current && noteTitleRef.current) {
      noteTitleRef.current.focus({ preventScroll: true })
      focusNewNote.current = false
    }
  }, [editing?.id, editing?.content, editing?.title, editorWidth, detailVisible])
  useLayoutEffect(() => { noteScrollRef.current?.scrollTo({ top: 0 }) }, [previewId])
  const requestTransition = (action: () => void) => {
    if (busyRef.current) return
    queuedTransition.current = action
    if (transitionInFlight.current) return
    const proceed = async () => {
      transitionInFlight.current = true
      try {
        const flushed = await flushDraft()
        const next = queuedTransition.current
        queuedTransition.current = null
        if (!flushed) { setPendingAction(() => next); return }
        draftRef.current = null
        setEditing(null)
        setSaveError('')
        next?.()
      } finally { transitionInFlight.current = false }
    }
    void proceed()
  }
  useEffect(() => {
    registerLeaveGuard(requestTransition)
    return () => registerLeaveGuard(null)
  })
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])
  const updateDraft = (draft: CopyEntry) => {
    draftRef.current = draft
    setEditing(draft)
    setSaveError('')
  }
  const beginDraft = (entry: CopyEntry) => {
    const draft = { ...entry, tags: [...entry.tags] }
    initialDraft.current = draftSignature(draft)
    updateDraft(draft)
    setLastSaved(entry.updatedAt)
    setDetailVisible(true)
  }
  useEffect(() => {
    if (previewEntry && (!editing || (editing.id && editing.id !== previewEntry.id && !dirty))) {
      const draft = { ...previewEntry, tags: [...previewEntry.tags] }
      initialDraft.current = draftSignature(draft)
      draftRef.current = draft
      setEditing(draft)
      setLastSaved(previewEntry.updatedAt)
    }
    if (!loading && !previewEntry && editing?.id && !dirty) {
      draftRef.current = null
      setEditing(null)
    }
  }, [previewEntry, editing, dirty, loading])
  const newEntry = () => requestTransition(() => {
    setPreviewId(null)
    focusNewNote.current = true
    beginDraft({ id: '', title: '', content: '', kind: 'original', tags: [], fingerprint: '', createdAt: '', updatedAt: '' })
  })
  const save = async (): Promise<boolean> => {
    if (saveInFlight.current) return saveInFlight.current
    const draft = draftRef.current
    if (!draft || draftSignature(draft) === initialDraft.current) return true
    if (!draft.content.trim()) { setSaveError('填写正文后即可自动保存。'); return false }
    const signature = draftSignature(draft)
    savingRef.current = true
    setSaving(true)
    setSaveError('')
    const operation = async () => {
      try {
        const payload = { ...draft, title: draft.title.trim() || draft.content.trim().slice(0, 48) }
        const saved = draft.id
          ? await window.koubox.put<CopyEntry>(`/copy-library/${encodeURIComponent(draft.id)}`, payload)
          : await window.koubox.post<CopyEntry>('/copy-library', payload)
        initialDraft.current = draft.title.trim() ? signature : draftSignature({ ...draft, title: saved.title })
        const current = draftRef.current
        if (current && current.id === draft.id) {
          const next = { ...current, title: !draft.title.trim() && current.title === draft.title ? saved.title : current.title, id: saved.id, createdAt: saved.createdAt, updatedAt: saved.updatedAt }
          draftRef.current = next
          setEditing(next)
        }
        setEntries((currentEntries) => currentEntries.some((entry) => entry.id === saved.id)
          ? currentEntries.map((entry) => entry.id === saved.id ? saved : entry)
          : [saved, ...currentEntries])
        setPreviewId(saved.id)
        setLastSaved(saved.updatedAt)
        return true
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : '自动保存失败，请重试。')
        return false
      } finally {
        savingRef.current = false
        saveInFlight.current = null
        setSaving(false)
      }
    }
    saveInFlight.current = operation()
    return saveInFlight.current
  }
  const flushDraft = async (): Promise<boolean> => {
    if (saveInFlight.current && !await saveInFlight.current) return false
    while (draftRef.current && draftSignature(draftRef.current) !== initialDraft.current) {
      if (!await save()) return false
    }
    return true
  }
  useEffect(() => {
    if (!editing || !dirty || saveError || !editing.content.trim()) return
    const timer = window.setTimeout(() => { void save() }, 700)
    return () => window.clearTimeout(timer)
  }, [editing, dirty, saveError])
  const continuePending = async (shouldSave: boolean) => {
    const action = pendingAction
    if (!action || savingRef.current) return
    if (shouldSave && !await flushDraft()) return
    setPendingAction(null)
    draftRef.current = null
    setEditing(null)
    setSaveError('')
    action()
  }
  const selectEntry = (id: string) => {
    if (id === previewId) { setDetailVisible(true); return }
    requestTransition(() => { setPreviewId(id); setDetailVisible(true) })
  }
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const toggleTag = (tag: string) => requestTransition(() => setSelectedTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]))
  const toggleEditingTag = (tag: string) => {
    if (!editing) return
    updateDraft({ ...editing, tags: editing.tags.includes(tag) ? editing.tags.filter((item) => item !== tag) : [...editing.tags, tag] })
  }
  const deleteEntries = async () => {
    if (!deleteIds?.length || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    const currentIndex = shown.findIndex((entry) => entry.id === previewId)
    const next = shown.slice(currentIndex + 1).find((entry) => !deleteIds.includes(entry.id))
      ?? [...shown.slice(0, currentIndex)].reverse().find((entry) => !deleteIds.includes(entry.id))
    try {
      if (deleteIds.length === 1) await window.koubox.del(`/copy-library/${encodeURIComponent(deleteIds[0])}`)
      else await window.koubox.post('/copy-library/bulk-delete', { ids: deleteIds })
      preferredId.current = deleteIds.includes(previewId ?? '') ? next?.id ?? null : previewId
      if (deleteIds.includes(draftRef.current?.id ?? '')) { draftRef.current = null; setEditing(null) }
      setEntries((current) => current.filter((entry) => !deleteIds.includes(entry.id)))
      setSelected((current) => current.filter((id) => !deleteIds.includes(id)))
      setPreviewId(preferredId.current)
      setDeleteIds(null)
      await refresh()
      onShowToast('文案已删除', 'success')
    } catch (error) { onShowToast(error instanceof Error ? error.message : '删除失败', 'error') }
    finally { busyRef.current = false; setBusy(false) }
  }
  const refreshDevices = async () => {
    await window.koubox.post('/lan/discovery/announce', {})
    setDevices(await window.koubox.get<LanDevice[]>('/lan/devices'))
  }
  const startShare = async () => {
    try {
      if (!await flushDraft()) { onShowToast('请先处理当前文案的保存错误，再分享。', 'error'); return }
      shareIds.current = [...visibleSelected]; await refreshDevices(); setDeviceSelection([]); setPickerOpen(true)
    }
    catch (error) { onShowToast(error instanceof Error ? error.message : '设备发现失败', 'error') }
  }
  const confirmShare = async () => {
    try {
      setTransfers(await window.koubox.post<LanTransfer[]>('/lan/transfers', { entryIds: shareIds.current, deviceIds: deviceSelection }))
      setPickerOpen(false); setTransferOpen(true); onShowToast('分享任务已发送', 'success')
    } catch (error) { onShowToast(error instanceof Error ? error.message : '分享失败', 'error') }
  }
  const openCreateTag = () => setTagDialog({ mode: 'create', original: '', value: '' })
  const copyNote = async () => {
    if (!draftRef.current) return
    try {
      await navigator.clipboard.writeText(draftRef.current.content)
      onShowToast('正文已复制', 'success')
    } catch (error) { onShowToast(error instanceof Error ? error.message : '复制失败，请重试。', 'error') }
  }
  const submitTagDialog = async () => {
    if (!tagDialog || busyRef.current) return
    const name = tagDialog.value.trim()
    if (!name) { onShowToast('标签不能为空。', 'error'); return }
    busyRef.current = true; setBusy(true)
    try {
      if (tagDialog.mode === 'create') {
        await window.koubox.post('/copy-library/tags', { name })
        const draft = draftRef.current
        if (tagDialog.attachToDraft && draft && !draft.tags.includes(name)) updateDraft({ ...draft, tags: [...draft.tags, name] })
      }
      else if (tagDialog.mode === 'rename') {
        await window.koubox.put(`/copy-library/tags/${encodeURIComponent(tagDialog.original)}`, { name })
        setSelectedTags((current) => current.map((tag) => tag === tagDialog.original ? name : tag))
      } else {
        await window.koubox.del(`/copy-library/tags/${encodeURIComponent(tagDialog.original)}`)
        setSelectedTags((current) => current.filter((tag) => tag !== tagDialog.original))
      }
      setTagDialog(null); await refresh(); onShowToast('标签已更新', 'success')
    } catch (error) { onShowToast(error instanceof Error ? error.message : '标签操作失败', 'error') }
    finally { busyRef.current = false; setBusy(false) }
  }

  return (
    <section ref={containerRef} className={cn('copy-library-page copy-workspace', compact && 'is-compact', detailVisible && 'show-detail')}>
      <header className="copy-workspace-header">
        <div><h1>文案库 <span>{entries.length}</span></h1></div>
        <Button type="button" onClick={newEntry} disabled={busy}><Plus size={16} />新建文案</Button>
      </header>
      <div className="copy-workspace-toolbar">
        <div className="copy-search"><Search size={17} aria-hidden="true" /><Input aria-label="搜索文案" placeholder="搜索标题、正文、标签或来源" value={query} onChange={(event) => { const value = event.target.value; requestTransition(() => { setSelected([]); setQuery(value) }) }} disabled={busy} /></div>
        <Button type="button" disabled={!visibleSelected.length || loading || saving || busy} onClick={() => void startShare()}>分享选中 ({visibleSelected.length})</Button>
        <Button type="button" variant="outline" disabled={!visibleSelected.length || loading || saving || busy} onClick={() => requestTransition(() => setDeleteIds(visibleSelected))}>批量删除</Button>
      </div>
      <div className="copy-filter-bar">
        <span className="copy-filter-label">标签</span>
        <button type="button" className={cn('copy-filter-all', !selectedTags.length && 'is-active')} aria-pressed={!selectedTags.length} onClick={() => requestTransition(() => setSelectedTags([]))}>全部</button>
        {tags.map((tag) => <ContextMenu key={tag}><ContextMenuTrigger asChild>
          <button type="button" className={cn('copy-capsule copy-tag-filter', selectedTags.includes(tag) && 'is-active')} style={{ ['--tag-tint' as string]: tagColor(tag) }} aria-pressed={selectedTags.includes(tag)} onClick={() => toggleTag(tag)} title={`${tag} · 右键管理`}>
            {selectedTags.includes(tag) && <Check size={12} />}<span>{tag}</span><em>{entries.filter((entry) => entry.tags.includes(tag)).length}</em>
          </button>
        </ContextMenuTrigger><ContextMenuContent><ContextMenuItem onClick={() => requestTransition(() => setTagDialog({ mode: 'rename', original: tag, value: tag }))}><Pencil size={14} />重命名标签</ContextMenuItem><ContextMenuSeparator /><ContextMenuItem variant="destructive" onClick={() => requestTransition(() => setTagDialog({ mode: 'delete', original: tag, value: tag }))}><Trash2 size={14} />删除标签</ContextMenuItem></ContextMenuContent></ContextMenu>)}
        {selectedTags.length > 0 && <Button variant="ghost" size="sm" onClick={() => requestTransition(() => setSelectedTags([]))}>清除筛选</Button>}
        <Button className="copy-add-tag" variant="ghost" size="sm" onClick={openCreateTag}><Plus size={14} />新建标签</Button>
      </div>
      <div className="copy-master-detail" aria-busy={loading}>
        <aside className="copy-master" aria-label="文案列表">
          <div className="copy-list-toolbar">
            <label><Checkbox aria-label="全选当前结果" disabled={!shown.length || loading} checked={allSelected ? true : visibleSelected.length ? 'indeterminate' : false} onCheckedChange={() => setSelected(allSelected ? [] : shown.map((entry) => entry.id))} />全选</label>
            <span>{loading ? '加载中…' : visibleSelected.length ? `已选 ${visibleSelected.length} / ${shown.length}` : `${shown.length} 条文案`}</span>
            {visibleSelected.length > 0 && <button type="button" className="copy-selection-clear" onClick={() => setSelected([])}>取消选择</button>}
          </div>
          <div className="copy-list-scroll">
            {loading ? <div className="copy-state" role="status">正在加载文案…</div> : loadError ? <div className="copy-state" role="alert"><p>{loadError}</p><Button variant="outline" onClick={() => void refresh()}>重新加载</Button></div> : shown.length === 0 ? <div className="copy-state"><FileText size={28} /><strong>暂无匹配文案</strong><p>调整搜索或标签，或新建一条文案。</p></div> : shown.map((entry) => (
              <div key={entry.id} className={cn('copy-list-item', previewId === entry.id && 'is-current', visibleSelected.includes(entry.id) && 'is-checked')}>
                <Checkbox aria-label={`选择 ${entry.title}`} checked={visibleSelected.includes(entry.id)} onCheckedChange={() => toggle(entry.id)} />
                <button type="button" className="copy-list-open" aria-current={previewId === entry.id ? 'true' : undefined} aria-label={`打开 ${entry.title}`} onClick={() => selectEntry(entry.id)}>
                  <span className="copy-list-title">{entry.title || '无标题便签'}</span>
                  <span className="copy-list-excerpt">{entry.content}</span>
                  <span className="copy-list-meta">
                    <span className="copy-kind-label">{kindLabel(entry.kind)}</span>
                    <span className="copy-list-tags">{entry.tags.slice(0, 2).map(renderTag)}{entry.tags.length > 2 && <span className="copy-tag-overflow" title={entry.tags.slice(2).join('、')}>+{entry.tags.length - 2}</span>}</span>
                  </span>
                </button>
              </div>
            ))}
          </div>
        </aside>
        <section ref={detailRef} className="copy-detail" aria-label="文案便签">
          <div className="copy-note-toolbar">
            <div className="copy-note-status">
              <button type="button" className="copy-back" onClick={() => requestTransition(() => setDetailVisible(false))}><ArrowLeft size={15} />列表</button>
              {editing ? <span className={cn('copy-autosave-state', saving && 'is-saving', dirty && !saving && 'is-pending', saveError && 'has-error')} role="status" aria-live="polite">{saving ? '正在保存…' : saveError ? '保存失败' : dirty ? editing.content.trim() ? '等待保存…' : '填写正文后保存' : editing.id ? '已自动保存' : '新便签'}</span> : <span className="copy-note-placeholder">文案内容</span>}
            </div>
            {editing && <div className="copy-note-actions">
              <span className="copy-character-count">{characterCount.toLocaleString()} 字</span>
              <Button type="button" variant="ghost" size="sm" disabled={!editing.content.trim()} onClick={() => void copyNote()}>复制正文</Button>
              {editing.id && <DropdownMenu><DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label="更多文案操作" title="更多操作" disabled={saving || busy}><MoreHorizontal size={17} /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" onSelect={() => requestTransition(() => setDeleteIds([editing.id]))}><Trash2 size={14} />删除文案</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
            </div>}
          </div>
          {saveError && <div className="copy-save-error" role="alert"><span>{saveError}</span><Button variant="outline" size="sm" disabled={saving} onClick={() => void save()}>重试保存</Button></div>}
          {editing ? <article ref={noteScrollRef} className="copy-note">
            <div className="copy-note-content">
              <Textarea ref={noteTitleRef} rows={1} className="copy-note-title" aria-label="文案标题" placeholder="无标题便签" value={editing.title} onChange={(event) => updateDraft({ ...editing, title: event.target.value })} />
              <div className="copy-note-meta">
                <Select value={editing.kind} onValueChange={(kind) => updateDraft({ ...editing, kind: kind as CopyEntryKind })}><SelectTrigger aria-label="文案类型"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="original">原文</SelectItem><SelectItem value="translation">译文</SelectItem><SelectItem value="transcript">转写</SelectItem></SelectContent></Select>
                <span className="copy-note-source" title={editing.sourceTool ?? '手动创建'}>{editing.sourceTool ?? '手动创建'}</span>
                {editing.senderAlias && <span className="copy-note-source" title={editing.senderAlias}>来自 {editing.senderAlias}</span>}
                {lastSaved && <time dateTime={lastSaved} title={`最后保存于 ${formatDate(lastSaved)}`}>{formatDate(lastSaved)}</time>}
              </div>
              <div className="copy-note-tags">
                <span className="copy-note-field-label">标签</span>
                <DropdownMenu><DropdownMenuTrigger asChild>
                  <button type="button" className="copy-note-tag-trigger" aria-label="编辑文案标签">
                    {editing.tags.length ? editing.tags.map(renderTag) : <span className="copy-note-add-label">添加标签</span>}
                    <ChevronDown size={13} aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger><DropdownMenuContent className="copy-note-tag-menu" align="start">
                  <DropdownMenuLabel>文案标签 · 可多选</DropdownMenuLabel>
                  {tags.length === 0 && <p className="copy-tag-menu-empty">还没有标签，新建一个分类吧。</p>}
                  {tags.map((tag) => <DropdownMenuCheckboxItem key={tag} checked={editing.tags.includes(tag)} onSelect={(event) => event.preventDefault()} onCheckedChange={() => toggleEditingTag(tag)}>{renderTag(tag)}</DropdownMenuCheckboxItem>)}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setTagDialog({ mode: 'create', original: '', value: '', attachToDraft: true })}><Plus size={14} />新建并添加标签</DropdownMenuItem>
                </DropdownMenuContent></DropdownMenu>
              </div>
              <Textarea ref={noteBodyRef} className="copy-note-body" aria-label="文案正文" placeholder="在这里写下正文，修改会自动保存…" value={editing.content} onChange={(event) => updateDraft({ ...editing, content: event.target.value })} />
            </div>
          </article> : <div className="copy-state copy-detail-empty"><FileText size={30} /><h2>选择一条文案</h2><p>直接编辑标题、正文和标签，修改自动保存。</p><Button type="button" variant="outline" size="sm" onClick={newEntry}>新建文案</Button></div>}
        </section>
      </div>
      <Dialog open={Boolean(pendingAction)} onOpenChange={(open) => { if (!open && !saving) setPendingAction(null) }}>
        <DialogContent showCloseButton={!saving}><DialogHeader><DialogTitle>自动保存尚未完成</DialogTitle><DialogDescription>当前修改还未保存成功。可以重试保存，或留在当前便签继续处理。</DialogDescription></DialogHeader>{saveError && <p role="alert" className="copy-save-error">{saveError}</p>}<DialogFooter><Button variant="outline" disabled={saving} onClick={() => setPendingAction(null)}>继续编辑</Button><Button variant="outline" disabled={saving} onClick={() => void continuePending(false)}>放弃修改</Button><Button disabled={saving} onClick={() => void continuePending(true)}>{saving ? '保存中…' : '重试并继续'}</Button></DialogFooter></DialogContent>
      </Dialog>
      <Dialog open={Boolean(deleteIds)} onOpenChange={(open) => { if (!open && !busy) setDeleteIds(null) }}><DialogContent showCloseButton={!busy}><DialogHeader><DialogTitle>删除文案？</DialogTitle><DialogDescription>将删除 {deleteIds?.length ?? 0} 条文案，此操作不可撤销。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDeleteIds(null)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => void deleteEntries()}>{busy ? '删除中…' : '确认删除'}</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={Boolean(tagDialog)} onOpenChange={(open) => { if (!open && !busy) setTagDialog(null) }}>
        <DialogContent showCloseButton={!busy}>{tagDialog && <><DialogHeader><DialogTitle>{tagDialog.mode === 'create' ? '新建标签' : tagDialog.mode === 'rename' ? '重命名标签' : '删除标签'}</DialogTitle><DialogDescription>{tagDialog.mode === 'delete' ? '仅移除标签，不删除文案正文。' : '为文案添加易于查找的分类。'}</DialogDescription></DialogHeader>
          {tagDialog.mode === 'delete' ? <p>确认删除标签「{tagDialog.original}」？</p> : <div className="grid gap-2"><Label htmlFor="copy-tag-name">标签名称</Label><Input id="copy-tag-name" autoFocus disabled={busy} value={tagDialog.value} onChange={(event) => setTagDialog({ ...tagDialog, value: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') void submitTagDialog() }} /></div>}
          <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setTagDialog(null)}>取消</Button><Button disabled={busy} variant={tagDialog.mode === 'delete' ? 'destructive' : 'default'} onClick={() => void submitTagDialog()}>{busy ? '处理中…' : tagDialog.mode === 'delete' ? '确认删除' : '保存标签'}</Button></DialogFooter></>}</DialogContent>
      </Dialog>
      <LanDevicePickerDialog open={pickerOpen} devices={devices} selected={deviceSelection} onToggle={(id) => setDeviceSelection((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])} onClose={() => setPickerOpen(false)} onConfirm={() => void confirmShare()} onRefresh={() => void refreshDevices()} />
      <LanTransferDialog open={transferOpen} transfers={transfers} onClose={() => setTransferOpen(false)} />
    </section>
  )
}
