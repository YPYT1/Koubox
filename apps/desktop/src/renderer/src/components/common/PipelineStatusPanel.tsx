import { toUserTaskMessage, type TaskSnapshot } from '@koubox/shared'
import { Badge } from './Badge'
import { PipelineStepper } from './PipelineStepper'
import { formatTaskPercent } from '../../utils/progress'

export type PipelineStep = {
  stage: string
  label: string
  desc: string
}

type PipelineStatusPanelProps = {
  task: TaskSnapshot | null
  steps: PipelineStep[]
  title?: string
}

/** 任务进度面板：步骤条 + 状态徽章 */
export function PipelineStatusPanel({ task, steps, title = '执行状态' }: PipelineStatusPanelProps) {
  const status = task?.status ?? 'idle'
  const isTaskRunning = Boolean(task && (task.status === 'queued' || task.status === 'running'))

  return (
    <section className="panel-box viral-status-panel">
      <div className="panel-title">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h3>{title}</h3>
          {status !== 'idle' && (
            <Badge
              variant={status === 'complete' ? 'success' : status === 'error' ? 'danger' : 'teal'}
              pulse={isTaskRunning}
            >
              {status === 'complete'
                ? '完成'
                : status === 'error'
                  ? '失败'
                  : status === 'cancelled'
                    ? '已取消'
                    : '进行中'}
            </Badge>
          )}
        </div>
        {task && (
          <span className={`task-percent-tag ${isTaskRunning ? 'pulsing' : ''}`}>{formatTaskPercent(task.percent)}</span>
        )}
      </div>

      <PipelineStepper
        steps={steps}
        currentStage={task?.stage}
        status={task?.status}
        percent={task?.percent}
        message={task?.status === 'error' && task.message ? toUserTaskMessage(task.message) : task?.message}
      />
    </section>
  )
}
