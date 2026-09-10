import type { LanDevice } from '@koubox/shared'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export function LanDevicePickerDialog({
  open,
  devices,
  selected,
  onToggle,
  onClose,
  onConfirm,
  onRefresh
}: {
  open: boolean
  devices: LanDevice[]
  selected: string[]
  onToggle: (id: string) => void
  onClose: () => void
  onConfirm: () => void
  onRefresh?: () => void
}) {
  const onlineDevices = devices.filter((device) => device.online)
  const offlineDevices = devices.filter((device) => !device.online)
  const ordered = [...onlineDevices, ...offlineDevices]
  const allSelected = onlineDevices.length > 0 && onlineDevices.every((device) => selected.includes(device.id))
  const toggleAll = () => {
    onlineDevices.forEach((device) => {
      if (allSelected ? selected.includes(device.id) : !selected.includes(device.id)) onToggle(device.id)
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>分享给设备</DialogTitle>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>已选择 {selected.length} 台 · 在线 {onlineDevices.length} / 共 {devices.length}</span>
          <div className="flex gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={toggleAll} disabled={onlineDevices.length === 0}>{allSelected ? '取消全选' : '全选在线设备'}</Button>
            {onRefresh && <Button type="button" variant="ghost" size="sm" onClick={onRefresh}>刷新</Button>}
          </div>
        </div>
        <ScrollArea className="max-h-[50vh]">
          <div className="grid gap-2 pr-3">
            {ordered.length === 0 ? (
              <div className="grid place-items-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 px-6 py-12 text-center">
                <strong className="text-sm">暂未发现其他口播匣</strong>
                <p className="max-w-sm text-xs text-muted-foreground">请确认对方已开启局域网分享，并与本机在同一网段，然后点击「刷新」。</p>
              </div>
            ) : ordered.map((device) => (
              <label
                key={device.id}
                className={cn(
                  'grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl border p-3',
                  selected.includes(device.id) ? 'border-primary bg-primary/5' : 'border-border',
                  !device.online && 'cursor-not-allowed opacity-70'
                )}
              >
                <Checkbox checked={selected.includes(device.id)} disabled={!device.online} onCheckedChange={() => onToggle(device.id)} />
                <span className="grid min-w-0 gap-1">
                  <strong className="truncate text-sm">{device.alias || '未命名设备'}</strong>
                  <small className="font-semibold tabular-nums text-foreground">{device.host}:{device.port}</small>
                </span>
                <Badge variant="outline" className={device.online ? 'border-teal-200 bg-teal-50 text-teal-800' : ''}>{device.online ? '在线' : '离线'}</Badge>
              </label>
            ))}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>取消</Button>
          <Button type="button" disabled={selected.length === 0} onClick={onConfirm}>开始分享</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
