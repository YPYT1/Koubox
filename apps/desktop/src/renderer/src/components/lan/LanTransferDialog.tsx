import { useEffect, useState } from 'react'
import type { LanTransfer } from '@koubox/shared'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function LanTransferDialog({ open = true, transfers, onClose }: { open?: boolean; transfers: LanTransfer[]; onClose: () => void }) {
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

  const cancel = async (id: string) => {
    await window.koubox.post(`/lan/transfers/${encodeURIComponent(id)}/cancel`, {})
    setCurrent((items) => items.map((item) => item.id === id ? { ...item, status: 'cancelled' } : item))
  }

  const statusLabel = (status: LanTransfer['status']) => {
    if (status === 'complete') return '已完成'
    if (status === 'waiting') return '等待接收'
    if (status === 'rejected') return '已拒绝'
    if (status === 'cancelled') return '已取消'
    if (status === 'error') return '失败'
    return '发送中'
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>分享进度</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          {current.map((transfer) => (
            <div className="grid gap-2 rounded-xl border border-border p-3" key={transfer.id}>
              <div className="flex items-center justify-between gap-2 text-sm">
                <strong>{transfer.peerAlias}</strong>
                <span className="text-muted-foreground">{statusLabel(transfer.status)}</span>
              </div>
              <Progress value={transfer.percent} className="h-2" />
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{transfer.error ?? `${transfer.percent}%`}</span>
                {!['complete', 'rejected', 'cancelled', 'error'].includes(transfer.status) && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => void cancel(transfer.id)}>取消此接收方</Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
