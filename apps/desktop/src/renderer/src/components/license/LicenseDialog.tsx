import { useEffect, useState, type FormEvent } from 'react'
import { Key, WarningCircle, X } from '@phosphor-icons/react'
import type { LicenseCredentials, LicenseSnapshot } from '@koubox/license-client'
import { Button } from '../common/Button'

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

  if (!open) return null

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
    <div className="license-dialog-overlay" onMouseDown={onClose}>
      <form className="license-dialog" role="dialog" aria-modal="true" aria-labelledby="license-dialog-title" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="license-dialog-head">
          <div>
            <span className="license-dialog-kicker"><Key size={15} weight="fill" /> 授权凭据</span>
            <h2 id="license-dialog-title">更换 Token 与 API Key</h2>
          </div>
          <button type="button" className="license-dialog-close" onClick={onClose} aria-label="关闭授权凭据窗口"><X size={18} /></button>
        </div>
        <p className="license-dialog-note">必须输入相互绑定的一整组新凭据。验证成功后才会覆盖本机旧凭据，并立即解除宽限或锁定。</p>
        <div className="license-current-pair">
          <span>当前 Token：<code>{snapshot?.tokenMasked ?? '—'}</code></span>
          <span>当前 API Key：<code>{snapshot?.apiKeyMasked ?? '—'}</code></span>
        </div>
        <label className="form-group">
          <span>Token</span>
          <input className="input-text license-secret-input" value={token} onChange={(event) => { setToken(event.target.value); setSubmitError(null) }} placeholder="KB-TKN-XXXX-XXXX-XXXX" autoComplete="off" spellCheck={false} required />
        </label>
        <label className="form-group">
          <span>API Key</span>
          <input className="input-text license-secret-input" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setSubmitError(null) }} placeholder="KB-KEY-XXXX-XXXX-XXXX-XXXX-XXXX" autoComplete="off" spellCheck={false} required />
        </label>
        {submitError && (
          <div className="license-dialog-error" role="alert" aria-live="assertive">
            <WarningCircle size={18} weight="fill" />
            <span>{submitError}</span>
          </div>
        )}
        <div className="license-dialog-actions">
          <Button type="button" variant="secondary" onClick={onClose}>取消</Button>
          {onVerify && (
            <Button type="button" variant="secondary" loading={verifying} onClick={handleVerify}>立即进行认证</Button>
          )}
          <Button type="submit" variant="primary" loading={saving} disabled={!token.trim() || !apiKey.trim()}>验证并保存</Button>
        </div>
      </form>
    </div>
  )
}
