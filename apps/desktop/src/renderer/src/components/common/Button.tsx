import React from 'react'
import { CircleNotch } from '@phosphor-icons/react'

export type ButtonVariant = 'primary' | 'primary-blue' | 'secondary' | 'danger' | 'ghost'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: React.ReactNode
  children?: React.ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  disabled,
  children,
  className = '',
  style,
  ...props
}: ButtonProps) {
  let variantClass = 'btn-secondary'
  if (variant === 'primary') variantClass = 'btn-primary'
  else if (variant === 'primary-blue') variantClass = 'btn-primary blue'
  else if (variant === 'danger') variantClass = 'btn-danger'
  else if (variant === 'ghost') variantClass = 'btn-ghost'

  const sizeStyles: Record<ButtonSize, React.CSSProperties> = {
    sm: { height: 32, padding: '0 10px', fontSize: 12 },
    md: { height: 38, padding: '0 14px', fontSize: 12.5 },
    lg: { height: 44, padding: '0 20px', fontSize: 13.5 }
  }

  return (
    <button
      className={`${variantClass} ${className}`}
      style={{ ...sizeStyles[size], ...style }}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <CircleNotch className="spin" size={size === 'sm' ? 14 : 16} />
      ) : (
        icon
      )}
      {children && <span>{children}</span>}
    </button>
  )
}
