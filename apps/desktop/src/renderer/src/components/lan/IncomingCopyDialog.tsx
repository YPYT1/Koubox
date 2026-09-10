import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export type IncomingCopy = { id: string; senderAlias: string; names: string[] }

export function IncomingCopyDialog({ incoming, onDecision }: { incoming: IncomingCopy | null; onDecision: (accept: boolean) => void }) {
  return (
    <Dialog open={Boolean(incoming)} onOpenChange={(open) => { if (!open && incoming) onDecision(false) }}>
      <DialogContent className="sm:max-w-md">
        {incoming && (
          <>
            <DialogHeader>
              <DialogTitle>收到文案分享</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground"><strong className="text-foreground">{incoming.senderAlias}</strong> 分享了：</p>
            <ul className="grid gap-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
              {incoming.names.map((name) => <li key={name}>{name}</li>)}
            </ul>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onDecision(false)}>否，拒绝</Button>
              <Button type="button" onClick={() => onDecision(true)}>是，接受</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
