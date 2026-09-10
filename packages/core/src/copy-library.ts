import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
// asm.js is self-contained, so packaged Electron builds do not need a loose WASM file.
// ponytail: keep one in-process SQLite instance; split workers only if write contention appears.
import initSqlJs, { type Database } from 'sql.js/dist/sql-asm.js'
import type { CopyEntry, CopyEntryKind } from '@koubox/shared'

type CopyInput = Partial<Pick<CopyEntry, 'title' | 'content' | 'kind' | 'tags' | 'sourceTool' | 'sourceTaskId' | 'sourceName' | 'senderAlias'>> & {
  title?: string
  content: string
  kind?: CopyEntryKind
}

function now(): string { return new Date().toISOString() }
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function tags(value: unknown): string[] {
  return [...new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : [])]
}
function fingerprint(content: string): string { return createHash('sha256').update(content).digest('hex') }

export class CopyLibraryStore {
  private constructor(
    private readonly db: Database,
    private readonly dbPath: string,
    private readonly backupDir: string
  ) {}

  static async open(dbPath: string, backupDir: string): Promise<CopyLibraryStore> {
    mkdirSync(dirname(dbPath), { recursive: true })
    mkdirSync(backupDir, { recursive: true })
    const SQL = await initSqlJs()
    const db = existsSync(dbPath) ? new SQL.Database(readFileSync(dbPath)) : new SQL.Database()
    db.run(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS copy_entries (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL,
        tags TEXT NOT NULL, source_tool TEXT, source_task_id TEXT, source_name TEXT,
        sender_alias TEXT, fingerprint TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, received_at TEXT
      );
      CREATE TABLE IF NOT EXISTS copy_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS share_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, transfer_id TEXT NOT NULL, direction TEXT NOT NULL,
        entry_id TEXT NOT NULL, peer_id TEXT NOT NULL, peer_alias TEXT NOT NULL, status TEXT NOT NULL,
        bytes_total INTEGER NOT NULL DEFAULT 0, bytes_transferred INTEGER NOT NULL DEFAULT 0,
        error TEXT, created_at TEXT NOT NULL, completed_at TEXT
      );
    `)
    return new CopyLibraryStore(db, dbPath, backupDir)
  }

  private persist(): void {
    writeFileSync(this.dbPath, Buffer.from(this.db.export()))
  }

  private backup(): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(join(this.backupDir, `library-${stamp}.json`), JSON.stringify(this.list(), null, 2), 'utf8')
  }

  private rowToEntry(row: Record<string, unknown>): CopyEntry {
    return {
      id: text(row.id), title: text(row.title), content: text(row.content), kind: text(row.kind) as CopyEntryKind,
      tags: JSON.parse(text(row.tags) || '[]') as string[], sourceTool: text(row.source_tool) || undefined,
      sourceTaskId: text(row.source_task_id) || undefined, sourceName: text(row.source_name) || undefined,
      senderAlias: text(row.sender_alias) || undefined, fingerprint: text(row.fingerprint),
      createdAt: text(row.created_at), updatedAt: text(row.updated_at), receivedAt: text(row.received_at) || undefined
    }
  }

  private rows(sql: string, params: unknown[] = []): CopyEntry[] {
    const result = this.db.exec(sql, params as any)
    const first = result[0]
    if (!first) return []
    return first.values.map((values) => this.rowToEntry(Object.fromEntries(first.columns.map((column, index) => [column, values[index]]))))
  }

  list(query = ''): CopyEntry[] {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const entries = this.rows('SELECT * FROM copy_entries ORDER BY updated_at DESC')
    if (words.length === 0) return entries
    return entries.filter((entry) => {
      const haystack = [entry.title, entry.content, ...entry.tags, entry.sourceTool, entry.sourceName, entry.senderAlias].filter(Boolean).join(' ').toLocaleLowerCase()
      return words.every((word) => haystack.includes(word))
    })
  }

  get(id: string): CopyEntry | undefined { return this.rows('SELECT * FROM copy_entries WHERE id = ?', [id])[0] }

  upsert(input: CopyInput, received = false): CopyEntry {
    const content = text(input.content).trim()
    if (!content) throw new Error('文案内容不能为空。')
    const kind = input.kind === 'translation' || input.kind === 'transcript' ? input.kind : 'original'
    const title = text(input.title).trim() || content.slice(0, 48)
    const nextTags = tags(input.tags)
    if (received && !nextTags.includes('分享')) nextTags.push('分享')
    const fp = fingerprint(content)
    const existing = this.getByFingerprint(fp)
    const stamp = now()
    if (existing) {
      const mergedTags = [...new Set([...existing.tags, ...nextTags])]
      this.db.run('UPDATE copy_entries SET tags = ?, source_tool = COALESCE(?, source_tool), source_task_id = COALESCE(?, source_task_id), source_name = COALESCE(?, source_name), sender_alias = COALESCE(?, sender_alias), received_at = COALESCE(?, received_at), updated_at = ? WHERE id = ?', [JSON.stringify(mergedTags), input.sourceTool ?? null, input.sourceTaskId ?? null, input.sourceName ?? null, input.senderAlias ?? null, received ? stamp : null, stamp, existing.id])
      for (const tag of mergedTags) this.db.run('INSERT OR IGNORE INTO copy_tags (name) VALUES (?)', [tag])
      this.persist(); this.backup()
      const updated = this.get(existing.id)
      if (!updated) throw new Error('文案更新后读取失败。')
      return updated
    }
    const id = text((input as { id?: unknown }).id).trim() || randomUUID()
    this.db.run('INSERT INTO copy_entries (id,title,content,kind,tags,source_tool,source_task_id,source_name,sender_alias,fingerprint,created_at,updated_at,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [id, title, content, kind, JSON.stringify(nextTags), input.sourceTool ?? null, input.sourceTaskId ?? null, input.sourceName ?? null, input.senderAlias ?? null, fp, stamp, stamp, received ? stamp : null])
    for (const tag of nextTags) this.db.run('INSERT OR IGNORE INTO copy_tags (name) VALUES (?)', [tag])
    this.persist(); this.backup()
    const created = this.get(id)
    if (!created) throw new Error('文案写入后读取失败。')
    return created
  }

  update(id: string, patch: Partial<CopyInput>): CopyEntry {
    const current = this.get(id)
    if (!current) throw new Error('文案不存在。')
    const content = text(patch.content ?? current.content).trim()
    if (!content) throw new Error('文案内容不能为空。')
    const fp = fingerprint(content)
    const duplicate = this.getByFingerprint(fp)
    if (duplicate && duplicate.id !== id) throw new Error('相同正文的文案已存在。')
    const stamp = now()
    const nextTags = tags(patch.tags ?? current.tags)
    this.db.run('UPDATE copy_entries SET title = ?, content = ?, kind = ?, tags = ?, source_tool = ?, source_task_id = ?, source_name = ?, sender_alias = ?, fingerprint = ?, updated_at = ? WHERE id = ?', [text(patch.title ?? current.title).trim() || content.slice(0, 48), content, patch.kind ?? current.kind, JSON.stringify(nextTags), patch.sourceTool ?? current.sourceTool ?? null, patch.sourceTaskId ?? current.sourceTaskId ?? null, patch.sourceName ?? current.sourceName ?? null, patch.senderAlias ?? current.senderAlias ?? null, fp, stamp, id] as any)
    for (const tag of nextTags) this.db.run('INSERT OR IGNORE INTO copy_tags (name) VALUES (?)', [tag])
    this.persist(); this.backup()
    return this.get(id)!
  }

  remove(id: string): void { this.db.run('DELETE FROM copy_entries WHERE id = ?', [id]); this.persist(); this.backup() }
  bulkRemove(ids: string[]): void { for (const id of ids) this.db.run('DELETE FROM copy_entries WHERE id = ?', [id]); this.persist(); this.backup() }
  getByFingerprint(fp: string): CopyEntry | undefined { return this.rows('SELECT * FROM copy_entries WHERE fingerprint = ?', [fp])[0] }
  listTags(): string[] { return this.db.exec('SELECT name FROM copy_tags ORDER BY name COLLATE NOCASE')[0]?.values.map((row) => text(row[0])) ?? [] }
  addTag(name: string): string { const value = name.trim(); if (!value) throw new Error('标签不能为空。'); this.db.run('INSERT OR IGNORE INTO copy_tags (name) VALUES (?)', [value]); this.persist(); return value }
  renameTag(oldName: string, newName: string): void {
    if (oldName.trim() === newName.trim()) return
    const next = this.addTag(newName)
    const entries = this.list()
    for (const entry of entries) if (entry.tags.includes(oldName)) this.db.run('UPDATE copy_entries SET tags = ?, updated_at = ? WHERE id = ?', [JSON.stringify([...new Set(entry.tags.map((tag) => tag === oldName ? next : tag))]), now(), entry.id])
    this.db.run('DELETE FROM copy_tags WHERE name = ?', [oldName]); this.persist(); this.backup()
  }
  removeTag(name: string): void {
    for (const entry of this.list()) if (entry.tags.includes(name)) this.db.run('UPDATE copy_entries SET tags = ?, updated_at = ? WHERE id = ?', [JSON.stringify(entry.tags.filter((tag) => tag !== name)), now(), entry.id])
    this.db.run('DELETE FROM copy_tags WHERE name = ?', [name]); this.persist(); this.backup()
  }

  recordHistory(entry: { transferId: string; direction: 'send' | 'receive'; entryId: string; peerId: string; peerAlias: string; status: string; bytesTotal?: number; bytesTransferred?: number; error?: string; createdAt?: string; completedAt?: string }): void {
    this.db.run('INSERT INTO share_history (transfer_id,direction,entry_id,peer_id,peer_alias,status,bytes_total,bytes_transferred,error,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [entry.transferId, entry.direction, entry.entryId, entry.peerId, entry.peerAlias, entry.status, entry.bytesTotal ?? 0, entry.bytesTransferred ?? 0, entry.error ?? null, entry.createdAt ?? now(), entry.completedAt ?? null] as any)
    this.persist()
  }

  listHistory(): Array<Record<string, unknown>> {
    const result = this.db.exec('SELECT transfer_id AS transferId, direction, entry_id AS entryId, peer_id AS peerId, peer_alias AS peerAlias, status, bytes_total AS bytesTotal, bytes_transferred AS bytesTransferred, error, created_at AS createdAt, completed_at AS completedAt FROM share_history ORDER BY id DESC')
    const first = result[0]
    return first ? first.values.map((values) => Object.fromEntries(first.columns.map((column, index) => [column, values[index]]))) : []
  }
}
