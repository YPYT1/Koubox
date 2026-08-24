import React from 'react'

export type BadgeVariant = 'teal' | 'blue' | 'purple' | 'success' | 'warning' | 'danger' | 'neutral'

export interface BadgeProps {
  variant?: BadgeVariant
  pulse?: boolean
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}

export function Badge({ variant = 'neutral', pulse = false, children, className = '', style }: BadgeProps) {
  return (
    <span className={`badge badge-${variant} ${pulse ? 'has-pulse' : ''} ${className}`} style={style}>
      {pulse && <span className="pulse-dot" />}
      {children}
    </span>
  )
}
