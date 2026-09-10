import { useEffect, useState, type FormEvent } from 'react'
import { Key, WarningCircle } from '@phosphor-icons/react'
import type { LicenseCredentials, LicenseSnapshot } from '@koubox/license-client'
import { Button } from '../common/Button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'

type LicenseDialogProps = {
  open: boolean
  snapshot: LicenseSnapshot | null
  onClose: () => void
  onSubmit: (credentials: LicenseCredentials) => Promise<void>
  onVerify?: () => Promise<void>
}

function submitErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const clean = message.replace(/^Error invoking remote method 'license:replace': Error:\s*/, '')
  if (/授权服务 HTTP|fetch failed|timeout|aborted/i.test(clean)) return '暂时无法连接授权服务，请检查网络后重试。'
  return clean || '暂时无法验证这组凭据，请稍后重试。'
}

export function LicenseDialog({ open, snapshot, onClose, onSubmit, onVerify }: LicenseDialogProps) {
  const [token, setToken] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setToken('')
    setApiKey('')
    setSubmitError(null)
  }, [open])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setSubmitError(null)
    try {
      await onSubmit({ token: token.trim(), apiKey: apiKey.trim() })
    } catch (error) {
      setSubmitError(submitErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const handleVerify = async () => {
    if (!onVerify) return
    setVerifying(true)
    setSubmitError(null)
    try {
      await onVerify()
      onClose()
    } catch (error) {
      setSubmitError(submitErrorMessage(error))
    } finally {
      setVerifying(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving && !verifying) onClose() }}>
      <DialogContent className="license-renewal-dialog sm:max-w-lg" showCloseButton={!saving && !verifying}>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogDescription className="inline-flex items-center gap-1.5 text-primary"><Key size={15} weight="fill" /> 授权凭据</DialogDescription>
            <DialogTitle>更新授权，继续创作</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">填写同一组 Token 与 API Key。验证通过后自动更新授权；验证失败不会覆盖现有凭据。</p>
          <div className="grid gap-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <span>当前 Token：<code className="text-foreground">{snapshot?.tokenMasked ?? '—'}</code></span>
            <span>当前 API Key：<code className="text-foreground">{snapshot?.apiKeyMasked ?? '—'}</code></span>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="license-token">Token</Label>
            <Input id="license-token" disabled={saving || verifying} value={token} onChange={(event) => { setToken(event.target.value); setSubmitError(null) }} placeholder="KB-TKN-XXXX-XXXX-XXXX" autoComplete="off" spellCheck={false} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="license-key">API Key</Label>
            <Input id="license-key" type="password" disabled={saving || verifying} value={apiKey} onChange={(event) => { setApiKey(event.target.value); setSubmitError(null) }} placeholder="KB-KEY-XXXX-XXXX-XXXX-XXXX-XXXX" autoComplete="off" spellCheck={false} required />
          </div>
          {submitError && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
              <WarningCircle size={18} weight="fill" />
              <span>{submitError}</span>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={saving || verifying} onClick={onClose}>稍后处理</Button>
            {onVerify && <Button type="button" variant="secondary" loading={verifying} disabled={saving} onClick={handleVerify}>重新验证</Button>}
            <Button type="submit" variant="primary" loading={saving} disabled={verifying || saving || !token.trim() || !apiKey.trim()}>验证并保存</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
