import type { ReactNode } from 'react'

type TranslationBusyFrameProps = {
  active: boolean
  expanded?: boolean
  children: ReactNode
}

/** 翻译进行中：光点沿文案面板边框环绕（操场跑道式进度） */
export function TranslationBusyFrame({ active, expanded = false, children }: TranslationBusyFrameProps) {
  return (
    <div
      className={`translation-busy-frame${active ? ' is-active' : ''}${expanded ? ' is-expanded' : ''}`}
      aria-busy={active || undefined}
    >
      {active ? <div className="translation-busy-track" aria-hidden /> : null}
      <section className={`panel-box viral-text-panel translation-busy-panel${expanded ? ' expanded' : ''}`}>
        {children}
      </section>
    </div>
  )
}
