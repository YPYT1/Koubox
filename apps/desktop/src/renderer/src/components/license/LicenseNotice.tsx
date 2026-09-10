import { useEffect, useState } from 'react'
import { AlertCircle, Clock3, ShieldAlert, WifiOff } from 'lucide-react'
import { LICENSE_INVALID_REASON, type LicenseSnapshot } from '@koubox/license-client/types'
import { Button } from '@/components/ui/button'

type Props = { snapshot: LicenseSnapshot | null; onManage: () => void; onVerify: () => Promise<void> }

export function LicenseNotice({ snapshot, onManage, onVerify }: Props) {
  const [clock, setClock] = useState(Date.now())
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    setError('')
    if (snapshot?.phase !== 'grace') return
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [snapshot?.phase, snapshot?.invalidCode, snapshot?.graceEndsAt])
  if (!snapshot || snapshot.phase === 'valid' || snapshot.phase === 'unverified') return null
  const locked = snapshot.phase === 'locked'
  const networkError = snapshot.phase === 'network-error'
  const expiry = snapshot.invalidCode === 'TOKEN_EXPIRED' || snapshot.invalidCode === 'API_KEY_EXPIRED'
  const Icon = locked ? ShieldAlert : networkError ? WifiOff : Clock3
  const reason = snapshot.invalidCode ? LICENSE_INVALID_REASON[snapshot.invalidCode] : ''
  const remaining = Math.max(0, Date.parse(snapshot.graceEndsAt ?? '') - clock)
  const countdown = Number.isFinite(remaining)
    ? `${String(Math.floor(remaining / 3600000)).padStart(2, '0')}:${String(Math.floor(remaining / 60000) % 60).padStart(2, '0')}:${String(Math.floor(remaining / 1000) % 60).padStart(2, '0')}`
    : null
  const title = networkError ? '暂时未能连接认证服务' : locked ? '授权已暂停' : expiry ? '授权已到期，请及时更新' : '授权验证未通过'
  const description = networkError
    ? `${snapshot.allowed ? '当前仍可使用。' : '请恢复连接后重新验证。'}检查网络后可重试。`
    : locked ? `${reason ? `${reason}。` : ''}更新有效授权后恢复使用，已有文件不受影响。`
      : `${reason ? `${reason}。` : ''}当前处于宽限期，请在结束前更新授权。`
  const verify = async () => {
    if (verifying) return
    setVerifying(true)
    setError('')
    try { await onVerify() }
    catch (failure) { setError(failure instanceof Error ? failure.message : '验证失败，请稍后重试。') }
    finally { setVerifying(false) }
  }
  return (
    <section className={`license-notice ${locked ? 'is-locked' : 'is-warning'}`} aria-label="授权状态">
      <div className="license-notice-symbol"><Icon size={20} strokeWidth={1.8} /></div>
      <div className="license-notice-copy"><div role="status"><strong>{title}</strong><p>{description}</p></div>{error && <p className="license-notice-error" role="alert"><AlertCircle size={13} />{error}</p>}</div>
      {snapshot.phase === 'grace' && countdown && <div className="license-notice-countdown"><span>宽限期剩余</span><time aria-label={`宽限期剩余 ${countdown}`}>{countdown}</time></div>}
      <div className="license-notice-actions"><Button variant="ghost" disabled={verifying} onClick={() => void verify()}>{verifying ? '验证中…' : '重新验证'}</Button><Button variant="outline" onClick={onManage}>更新授权</Button></div>
    </section>
  )
}
