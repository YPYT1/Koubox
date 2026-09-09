import type { CopySharePayload, CopyEntryKind } from '@koubox/shared'

export function assertCopySharePayload(value: unknown): CopySharePayload {
  if (!value || typeof value !== 'object') throw new Error('分享载荷无效。')
  const body = value as Record<string, unknown>
  const sender = body.sender as Record<string, unknown> | undefined
  if (body.protocol !== 'koubox-copy-library' || body.version !== 1 || !sender || typeof sender.alias !== 'string' || typeof sender.deviceId !== 'string') throw new Error('分享协议不匹配。')
  if (!Array.isArray(body.entries) || body.entries.length === 0) throw new Error('分享内容为空。')
  const entries = body.entries.map((raw) => {
    const entry = raw as Record<string, unknown>
    if (typeof entry.title !== 'string' || typeof entry.content !== 'string' || !['original', 'translation', 'transcript'].includes(String(entry.kind))) throw new Error('分享文案字段无效。')
    return { id: String(entry.id ?? ''), title: entry.title, content: entry.content, kind: entry.kind as CopyEntryKind, tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === 'string') : [], sourceTool: typeof entry.sourceTool === 'string' ? entry.sourceTool : undefined, sourceTaskId: typeof entry.sourceTaskId === 'string' ? entry.sourceTaskId : undefined, sourceName: typeof entry.sourceName === 'string' ? entry.sourceName : undefined }
  })
  return { protocol: 'koubox-copy-library', version: 1, sender: { alias: sender.alias, deviceId: sender.deviceId }, entries }
}
