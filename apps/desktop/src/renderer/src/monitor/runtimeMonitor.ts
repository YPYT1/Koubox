import type { GpuStatus, SystemMemoryStatus } from '@koubox/shared'

export const MONITOR_MAX_SAMPLES = 120
export const MEMORY_MONITOR_POLL_MS = 1000
export const GPU_MONITOR_POLL_MS = 2500
/** 两张图统一展示最近 2 分钟时间轴 */
export const MONITOR_CHART_WINDOW_MS = MEMORY_MONITOR_POLL_MS * MONITOR_MAX_SAMPLES

export type MonitorPoint = {
  at: number
  usedMiB: number
  totalMiB: number
  freeMiB: number
}

export type MemoryMonitorSnapshot = {
  current: MonitorPoint | null
  samples: MonitorPoint[]
}

export type GpuMonitorSnapshot = {
  available: boolean
  name?: string
  current: MonitorPoint | null
  samples: MonitorPoint[]
}

function pushSample(list: MonitorPoint[], point: MonitorPoint) {
  list.push(point)
  if (list.length > MONITOR_MAX_SAMPLES) {
    list.splice(0, list.length - MONITOR_MAX_SAMPLES)
  }
}

function toPoint(sample: SystemMemoryStatus): MonitorPoint {
  return {
    at: Date.now(),
    usedMiB: sample.usedMemoryMiB,
    totalMiB: sample.totalMemoryMiB,
    freeMiB: sample.freeMemoryMiB
  }
}

function toGpuPoint(gpu: GpuStatus): MonitorPoint | null {
  if (!gpu.available || gpu.usedMemoryMiB === undefined || gpu.totalMemoryMiB === undefined) return null
  return {
    at: Date.now(),
    usedMiB: gpu.usedMemoryMiB,
    totalMiB: gpu.totalMemoryMiB,
    freeMiB: gpu.freeMemoryMiB ?? gpu.totalMemoryMiB - gpu.usedMemoryMiB
  }
}

function createMonitorStore<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    setSnapshot: (next: T) => {
      snapshot = next
      listeners.forEach((listener) => listener())
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

const memoryStore = createMonitorStore<MemoryMonitorSnapshot>({ current: null, samples: [] })
const gpuStore = createMonitorStore<GpuMonitorSnapshot>({
  available: false,
  current: null,
  samples: []
})

export const memoryMonitor = {
  subscribe: memoryStore.subscribe,
  getSnapshot: memoryStore.getSnapshot
}

export const gpuMonitor = {
  subscribe: gpuStore.subscribe,
  getSnapshot: gpuStore.getSnapshot
}

let memoryTimer: number | undefined
let gpuTimer: number | undefined
let memoryStarted = false
let gpuStarted = false

async function pollMemory() {
  try {
    const next = await window.koubox.get<SystemMemoryStatus>('/runtime/memory')
    const point = toPoint(next)
    const prev = memoryStore.getSnapshot()
    const samples = [...prev.samples]
    pushSample(samples, point)
    memoryStore.setSnapshot({ current: point, samples })
  } catch (error) {
    console.error('[runtime-monitor] 内存采样失败', error)
  }
}

async function pollGpu() {
  try {
    const next = await window.koubox.get<GpuStatus>('/runtime/gpu')
    const point = toGpuPoint(next)
    const prev = gpuStore.getSnapshot()
    const samples = point ? [...prev.samples] : prev.samples
    if (point) pushSample(samples, point)
    gpuStore.setSnapshot({
      available: next.available,
      name: next.name,
      current: point,
      samples
    })
  } catch (error) {
    console.error('[runtime-monitor] GPU 采样失败', error)
  }
}

export function startRuntimeMonitor() {
  if (!memoryStarted) {
    memoryStarted = true
    void pollMemory()
    memoryTimer = window.setInterval(() => void pollMemory(), MEMORY_MONITOR_POLL_MS)
  }
  if (!gpuStarted) {
    gpuStarted = true
    void pollGpu()
    gpuTimer = window.setInterval(() => void pollGpu(), GPU_MONITOR_POLL_MS)
  }
}

export function seedGpuMonitor(gpu?: GpuStatus | null) {
  if (!gpu?.available || gpu.usedMemoryMiB === undefined) return
  const point = toGpuPoint(gpu)
  if (!point) return
  const prev = gpuStore.getSnapshot()
  if (prev.samples.length > 0) return
  gpuStore.setSnapshot({
    available: true,
    name: gpu.name,
    current: point,
    samples: [point]
  })
}
