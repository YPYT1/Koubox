import { useEffect, useState } from 'react'
import type { LanTransfer } from '@koubox/shared'

export function LanTransferDialog({ transfers, onClose }: { transfers: LanTransfer[]; onClose: () => void }) {
  const [current, setCurrent] = useState(transfers)
  useEffect(() => {
    setCurrent(transfers)
    const timer = window.setInterval(() => {
      void window.koubox.get<LanTransfer[]>('/lan/transfers').then((all) => {
        const ids = new Set(transfers.map((item) => item.id))
        setCurrent(all.filter((item) => ids.has(item.id)))
      }).catch(() => undefined)
    }, 800)
    return () => window.clearInterval(timer)
  }, [transfers])
  const cancel = async (id: string) => { await window.koubox.post(`/lan/transfers/${encodeURIComponent(id)}/cancel`, {}); setCurrent((items) => items.map((item) => item.id === id ? { ...item, status: 'cancelled' } : item)) }
  return <div className="modal-backdrop"><div className="modal-card lan-picker-card"><div className="modal-card-head"><h3>分享进度</h3><button className="icon-button" onClick={onClose}>×</button></div><div className="lan-transfer-list">{current.map((transfer) => <div className="lan-transfer-row" key={transfer.id}><div><strong>{transfer.peerAlias}</strong><span>{transfer.status === 'complete' ? '已完成' : transfer.status === 'waiting' ? '等待接收' : transfer.status === 'rejected' ? '已拒绝' : transfer.status === 'cancelled' ? '已取消' : transfer.status === 'error' ? '失败' : '发送中'}</span></div><div className="lan-progress"><i style={{ width: `${transfer.percent}%` }} /></div><small>{transfer.error ?? `${transfer.percent}%`}</small>{!['complete', 'rejected', 'cancelled', 'error'].includes(transfer.status) && <button className="btn-ghost" onClick={() => void cancel(transfer.id)}>取消此接收方</button>}</div>)}</div></div></div>
}
