import { useEffect, useRef, useState } from 'react'
import type { TaskEvent, TaskSnapshot } from '@koubox/shared'
import { cancelDownloadTask, startMaterialsPipeline, startVideoDownload } from './downloadApi'

type DownloadMode = 'download-only' | 'materials'

type UseVideoDownloadTaskOptions = {
  mode: DownloadMode
  onToast?: (message: string, type?: 'success' | 'warning' | 'error' | 'info') => void
  onStatus?: (status: TaskSnapshot['status'] | null) => void
}

/** 订阅下载类任务进度；mode 决定走 /pipelines/download 还是 /pipelines/req1 */
export function useVideoDownloadTask({ mode, onToast, onStatus }: UseVideoDownloadTaskOptions) {
  const [starting, setStarting] = useState(false)
  const [task, setTask] = useState<TaskSnapshot | null>(null)
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined)
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

  useEffect(() => () => unsubscribeRef.current?.(), [])

  const bindEvents = (taskId: string) => {
    unsubscribeRef.current?.()
    unsubscribeRef.current = window.koubox.events<TaskEvent>(`/tasks/${encodeURIComponent(taskId)}/events`, (event) => {
      setTask(event.task)
      onStatusRef.current?.(event.task.status)
    })
  }

  const start = async (url: string, outputDirectory: string) => {
    setStarting(true)
    try {
      const created =
        mode === 'download-only'
          ? await startVideoDownload(url, outputDirectory)
          : await startMaterialsPipeline({ url, outputDirectory })
      setTask(created)
      onStatusRef.current?.(created.status)
      bindEvents(created.taskId)
      onToast?.(mode === 'download-only' ? '下载任务已启动…' : '任务已启动…', 'info')
      return created
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : '任务启动失败', 'error')
      throw err
    } finally {
      setStarting(false)
    }
  }

  const cancel = async () => {
    if (!task) return
    try {
      const cancelled = await cancelDownloadTask(task.taskId)
      setTask(cancelled)
      onStatusRef.current?.(cancelled.status)
      onToast?.('任务已取消', 'info')
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : '取消失败', 'error')
    }
  }

  return { starting, task, setTask, start, cancel }
}
