export type IncomingCopy = { id: string; senderAlias: string; names: string[] }

export function IncomingCopyDialog({ incoming, onDecision }: { incoming: IncomingCopy | null; onDecision: (accept: boolean) => void }) {
  if (!incoming) return null
  return <div className="modal-backdrop"><div className="modal-card incoming-copy-card"><h3>收到文案分享</h3><p><strong>{incoming.senderAlias}</strong> 分享了：</p><ul>{incoming.names.map((name) => <li key={name}>{name}</li>)}</ul><div className="modal-actions"><button className="btn-secondary animated-button" onClick={() => onDecision(false)}>否，拒绝</button><button className="btn-primary animated-button" onClick={() => onDecision(true)}>是，接受</button></div></div></div>
}
