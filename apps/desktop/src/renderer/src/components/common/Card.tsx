import React from 'react'
import { Card as UiCard, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export interface CardProps {
  title?: React.ReactNode
  badge?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}

export function Card({ title, badge, actions, children, className = '', style }: CardProps) {
  return (
    <UiCard className={cn('gap-4 py-4 shadow-sm', className)} style={style}>
      {(title || badge || actions) && (
        <CardHeader className="flex flex-row items-center justify-between gap-3 px-5 py-0">
          <div className="flex min-w-0 items-center gap-2">
            {typeof title === 'string' ? <CardTitle className="text-base">{title}</CardTitle> : title}
            {badge}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </CardHeader>
      )}
      <CardContent className="px-5">{children}</CardContent>
    </UiCard>
  )
}
