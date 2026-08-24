import { X, CheckCircle, WarningCircle, Info } from '@phosphor-icons/react'

export interface ToastMessage {
  id: string
  type?: 'success' | 'warning' | 'error' | 'info'
  text: string
}

export interface ToastProps {
  toast: ToastMessage | null
  onClose: () => void
}

export function Toast({ toast, onClose }: ToastProps) {
  if (!toast) return null

  const icons = {
    success: <CheckCircle size={17} weight="fill" color="#10b981" />,
    warning: <WarningCircle size={17} weight="fill" color="#f59e0b" />,
    error: <WarningCircle size={17} weight="fill" color="#ef4444" />,
    info: <Info size={17} weight="fill" color="#0f766e" />
  }

  const type = toast.type || 'info'

  return (
    <div className="toast-notification" role="status">
      {icons[type]}
      <span>{toast.text}</span>
      <button className="toast-close" onClick={onClose} aria-label="关闭">
        <X size={14} />
      </button>
    </div>
  )
}
