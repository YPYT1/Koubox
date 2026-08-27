import { CheckCircle, CircleNotch, WarningCircle } from '@phosphor-icons/react'
import { formatTaskPercent } from '../../utils/progress'

export interface StepItemDef {
  stage: string
  label: string
  desc?: string
}

export interface PipelineStepperProps {
  steps: StepItemDef[]
  currentStage?: string
  status?: 'queued' | 'running' | 'complete' | 'error' | 'cancelled'
  percent?: number
  message?: string
  accentColor?: string
}

export function PipelineStepper({
  steps,
  currentStage,
  status,
  percent = 0,
  message,
  accentColor = 'var(--accent-teal)'
}: PipelineStepperProps) {
  const activeIdx = steps.findIndex((s) => s.stage === currentStage)

  const getStepState = (stepStage: string, index: number) => {
    if (!currentStage || status === 'queued') return 'pending'
    if (stepStage === currentStage) {
      return status === 'error' ? 'error' : status === 'complete' ? 'done' : 'current'
    }
    if (status === 'complete') return 'done'
    if (activeIdx > index) return 'done'
    return 'pending'
  }

  return (
    <div className="stepper-container">
      {steps.map((step, idx) => {
        const state = getStepState(step.stage, idx)
        return (
          <div key={step.stage} className="step-block">
            <div className={`step-item ${state}`} style={{ animationDelay: `${idx * 60}ms` }}>
              <div className="step-num">
                {state === 'done' ? (
                  <CheckCircle size={16} weight="fill" color="#10b981" />
                ) : state === 'error' ? (
                  <WarningCircle size={16} weight="fill" color="#ef4444" />
                ) : state === 'current' ? (
                  <CircleNotch className="spin" size={16} color={accentColor} />
                ) : (
                  idx + 1
                )}
              </div>
              <div className="step-info">
                <div className="step-title">{step.label}</div>
                <div className="step-status-text">
                  {state === 'current'
                    ? `${message || '处理中'} · ${formatTaskPercent(percent)}`
                    : state === 'done'
                    ? '已完成'
                    : state === 'error'
                    ? (message || '执行失败')
                    : step.desc}
                </div>
                {state === 'current' && (
                  <div className={`step-progress-track ${status === 'running' ? 'working' : ''}`}>
                    {status === 'running' && <div className="step-progress-indeterminate" />}
                    {percent > 0 && (
                      <div className="step-progress-fill" style={{ width: `${Math.max(8, Math.min(100, Number.isFinite(percent) ? percent : 0))}%` }} />
                    )}
                  </div>
                )}
              </div>
            </div>
            {idx < steps.length - 1 && (
              <div className={`step-connector ${state === 'done' || (state === 'current' && percent > 0) ? 'lit' : ''}`}>
                <span className="step-connector-flow" />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
