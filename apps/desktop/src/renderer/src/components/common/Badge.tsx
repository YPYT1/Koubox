import React from 'react'
import { Badge as ShadcnBadge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export type BadgeVariant = 'teal' | 'blue' | 'purple' | 'success' | 'warning' | 'danger' | 'neutral'

export interface BadgeProps {
  variant?: BadgeVariant
  pulse?: boolean
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}

const variantClass: Record<BadgeVariant, string> = {
  teal: 'border-teal-200 bg-teal-50 text-teal-800',
  blue: 'border-blue-200 bg-blue-50 text-blue-800',
  purple: 'border-violet-200 bg-violet-50 text-violet-800',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  danger: 'border-red-200 bg-red-50 text-red-800',
  neutral: 'border-slate-200 bg-slate-50 text-slate-700'
}

export function Badge({ variant = 'neutral', pulse = false, children, className = '', style }: BadgeProps) {
  return (
    <ShadcnBadge variant="outline" className={cn('gap-1.5 font-semibold', variantClass[variant], className)} style={style}>
      {pulse ? <span className="size-1.5 rounded-full bg-current animate-pulse" /> : null}
      {children}
    </ShadcnBadge>
  )
}
