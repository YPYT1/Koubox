import React from 'react'

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
    <div className={`panel-box ${className}`} style={style}>
      {(title || badge || actions) && (
        <div className="panel-title">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {typeof title === 'string' ? <h3>{title}</h3> : title}
            {badge}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  )
}
