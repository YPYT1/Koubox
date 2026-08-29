import { useEffect, useRef, useState } from 'react'
import { toUserTaskMessage, type TaskEvent, type TaskKind, type TaskSnapshot } from '@koubox/shared'
import { cancelDownloadTask } from './downloadApi'

type UsePipelineTaskOptions = {
  kind: TaskKind
  onStatus?: (status: TaskSnapshot['status'] | null) => void
  onError?: (message: string) => void
}

/** 按 TaskKind 订阅任务进度，供各工具页复用 */
export function usePipelineTask({ kind, onStatus, onError }: UsePipelineTaskOptions) {
  const [task, setTask] = useState<TaskSnapshot | null>(null)
  const onStatusRef = useRef(onStatus)
  const onErrorRef = useRef(onError)
  const shownErrorRef = useRef<string | null>(null)
  onStatusRef.current = onStatus
  onErrorRef.current = onError

  const taskId = task?.taskId

  useEffect(() => {
    let closed = false
    void window.koubox
      .get<TaskSnapshot[]>('/tasks')
      .then((all) => {
        if (closed) return
        const active = all
          .filter((item) => item.kind === kind && (item.status === 'queued' || item.status === 'running'))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]
        if (!active) return
        setTask((current) => current ?? active)
      })
      .catch((err) => {
        onErrorRef.current?.(err instanceof Error ? err.message : '无法读取进行中的任务')
      })
    return () => {
      closed = true
    }
  }, [kind])

  useEffect(() => {
    if (!taskId) return
    return window.koubox.events<TaskEvent>(`/tasks/${encodeURIComponent(taskId)}/events`, (event) => {
      setTask(event.task)
      onStatusRef.current?.(event.task.status)
    })
  }, [taskId])

  useEffect(() => {
    if (!task || task.status !== 'error') return
    const key = `${task.taskId}:${task.error?.code ?? task.message}`
    if (shownErrorRef.current === key) return
    shownErrorRef.current = key
    onErrorRef.current?.(toUserTaskMessage(task.message || task.error?.message || '任务失败'))
  }, [task])

  const cancel = async () => {
    if (!task) return
    const cancelled = await cancelDownloadTask(task.taskId)
    setTask(cancelled)
    onStatusRef.current?.(cancelled.status)
    return cancelled
  }

  const isTaskRunning = Boolean(task && (task.status === 'queued' || task.status === 'running'))

  return { task, setTask, cancel, isTaskRunning }
}
