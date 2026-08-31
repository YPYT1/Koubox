import { useEffect } from 'react'
import type { GpuStatus } from '@koubox/shared'
import { seedGpuMonitor, startRuntimeMonitor } from './runtimeMonitor'

type RuntimeMonitorBootstrapProps = {
  seedGpu?: GpuStatus | null
}

export function RuntimeMonitorBootstrap({ seedGpu }: RuntimeMonitorBootstrapProps) {
  useEffect(() => {
    startRuntimeMonitor()
  }, [])

  useEffect(() => {
    seedGpuMonitor(seedGpu)
  }, [seedGpu])

  return null
}
