import { useEffect } from 'react'
import { toast as sonnerToast } from 'sonner'

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
  useEffect(() => {
    if (!toast) return
    const opts = { id: toast.id, onDismiss: onClose, onAutoClose: onClose }
    if (toast.type === 'success') sonnerToast.success(toast.text, opts)
    else if (toast.type === 'warning') sonnerToast.warning(toast.text, opts)
    else if (toast.type === 'error') sonnerToast.error(toast.text, opts)
    else sonnerToast(toast.text, opts)
  }, [toast?.id])

  return null
}
