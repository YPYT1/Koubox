import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CopyLibraryStore } from '../src/copy-library.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('copy library store', () => {
  it('supports CRUD, search and receive dedupe without overwriting local edits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'koubox-copy-')); roots.push(root)
    const store = await CopyLibraryStore.open(join(root, 'copy-library', 'library.db'), join(root, 'copy-library', 'backups'))
    const first = store.upsert({ title: '标题', content: 'Hello Koubox', kind: 'original', tags: ['本地'] })
    expect(store.list('hello koubox')).toHaveLength(1)
    store.update(first.id, { title: '本地标题' })
    const duplicate = store.upsert({ title: '远端标题', content: 'Hello Koubox', senderAlias: 'Alice' }, true)
    expect(duplicate.title).toBe('本地标题')
    expect(duplicate.tags).toEqual(expect.arrayContaining(['本地', '分享']))
    expect(duplicate.senderAlias).toBe('Alice')
    store.renameTag('本地', '已整理')
    expect(store.get(duplicate.id)?.tags).toContain('已整理')
    store.removeTag('已整理')
    expect(store.get(duplicate.id)?.tags).not.toContain('已整理')
    store.remove(first.id)
    expect(store.list()).toHaveLength(0)
  })
})
