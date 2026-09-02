import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { ChartLineUp } from '@phosphor-icons/react'
import {
  gpuMonitor,
  GPU_MONITOR_POLL_MS,
  memoryMonitor,
  MONITOR_CHART_WINDOW_MS,
  MONITOR_MAX_SAMPLES,
  type MonitorPoint
} from '../../monitor/runtimeMonitor'

/** 图表走线比下方阴影更深，文字颜色由 CSS 控制为黑色系 */
const CHART_GOLD = {
  line: '#C9B07A',
  fillTop: 'rgba(212, 188, 130, 0.2)',
  fillBottom: 'rgba(212, 188, 130, 0.04)'
}

function formatGiB(mib?: number): string {
  if (mib === undefined) return '—'
  return `${(mib / 1024).toFixed(1)} GB`
}

function formatAxisTime(at: number): string {
  const date = new Date(at)
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${mm}:${ss}`
}

function fixedChartWindow(windowMs: number) {
  const windowEnd = Date.now()
  return {
    start: windowEnd - windowMs,
    end: windowEnd,
    spanMs: windowMs
  }
}

function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  pad: { left: number },
  chartW: number,
  height: number,
  windowStart: number,
  windowEnd: number
) {
  const ticks: Array<{ text: string; x: number; align: CanvasTextAlign }> = [
    { text: formatAxisTime(windowStart), x: pad.left, align: 'left' },
    { text: formatAxisTime(windowEnd), x: pad.left + chartW, align: 'right' }
  ]

  ctx.fillStyle = 'rgba(100, 116, 139, 0.85)'
  ctx.font = '10px var(--font-sans, system-ui, sans-serif)'
  for (const tick of ticks) {
    ctx.textAlign = tick.align
    ctx.fillText(tick.text, tick.x, height - 8)
  }
}

function drawChart(canvas: HTMLCanvasElement, samples: MonitorPoint[], windowMs: number) {
  const rect = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const width = Math.max(1, Math.floor(rect.width))
  const height = Math.max(1, Math.floor(rect.height))
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr
    canvas.height = height * dpr
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const pad = { top: 10, right: 10, bottom: 28, left: 40 }
  const chartW = width - pad.left - pad.right
  const chartH = height - pad.top - pad.bottom
  const visible = samples.slice(-MONITOR_MAX_SAMPLES)
  const totalMiB = visible[visible.length - 1]?.totalMiB ?? visible[0]?.totalMiB ?? 1024
  const maxY = totalMiB > 0 ? totalMiB : Math.max(...visible.map((item) => item.usedMiB), 1024)

  ctx.fillStyle = '#f8fafc'
  ctx.fillRect(0, 0, width, height)

  ctx.strokeStyle = 'rgba(15, 23, 42, 0.08)'
  ctx.fillStyle = 'rgba(100, 116, 139, 0.8)'
  ctx.font = '10px var(--font-sans, system-ui, sans-serif)'
  ctx.textAlign = 'right'
  ctx.lineWidth = 1

  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (chartH * i) / 4
    ctx.beginPath()
    ctx.moveTo(pad.left, y)
    ctx.lineTo(pad.left + chartW, y)
    ctx.stroke()
    ctx.fillText(`${((maxY * (4 - i)) / 4 / 1024).toFixed(0)}G`, pad.left - 6, y + 3)
  }

  const { start: windowStart, end: windowEnd, spanMs } = fixedChartWindow(windowMs)

  if (visible.length === 0) {
    drawTimeAxis(ctx, pad, chartW, height, windowStart, windowEnd)
    return
  }

  const plotted = visible.filter((sample) => sample.at >= windowStart)
  if (plotted.length === 0) {
    drawTimeAxis(ctx, pad, chartW, height, windowStart, windowEnd)
    return
  }

  const toX = (at: number) => {
    const ratio = (at - windowStart) / spanMs
    const clamped = Math.max(0, Math.min(1, ratio))
    return pad.left + clamped * chartW
  }

  const points = plotted.map((sample) => {
    const x = toX(sample.at)
    const y = pad.top + chartH - (sample.usedMiB / maxY) * chartH
    return { x, y, at: sample.at }
  })

  const baseline = pad.top + chartH
  ctx.beginPath()
  ctx.moveTo(points[0].x, baseline)
  for (const point of points) ctx.lineTo(point.x, point.y)
  ctx.lineTo(points[points.length - 1].x, baseline)
  ctx.closePath()

  const gradient = ctx.createLinearGradient(0, pad.top, 0, baseline)
  gradient.addColorStop(0, CHART_GOLD.fillTop)
  gradient.addColorStop(1, CHART_GOLD.fillBottom)
  ctx.fillStyle = gradient
  ctx.fill()

  ctx.beginPath()
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y)
    else ctx.lineTo(point.x, point.y)
  })
  ctx.strokeStyle = CHART_GOLD.line
  ctx.lineWidth = 1.75
  ctx.lineJoin = 'round'
  ctx.stroke()

  drawTimeAxis(ctx, pad, chartW, height, windowStart, windowEnd)
}

type MemoryLiveChartProps = {
  title: string
  ariaLabel: string
  metricLabel: string
  pollHint: string
  windowMs: number
  samples: MonitorPoint[]
  current: MonitorPoint | null
  available?: boolean
  emptyText?: string
  extraLine?: string
  headerBadge?: ReactNode
}

function MemoryLiveChart({
  title,
  ariaLabel,
  metricLabel,
  pollHint,
  windowMs,
  samples,
  current,
  available = true,
  emptyText,
  extraLine,
  headerBadge
}: MemoryLiveChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const samplesRef = useRef(samples)
  samplesRef.current = samples

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const redraw = () => drawChart(canvas, samplesRef.current, windowMs)
    redraw()
    const timer = window.setInterval(redraw, 1000)
    return () => window.clearInterval(timer)
  }, [windowMs])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    drawChart(canvas, samples, windowMs)
  }, [samples, windowMs])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas?.parentElement) return
    const observer = new ResizeObserver(() => drawChart(canvas, samplesRef.current, windowMs))
    observer.observe(canvas.parentElement)
    return () => observer.disconnect()
  }, [windowMs])

  const used = current?.usedMiB ?? 0
  const total = current?.totalMiB ?? 0
  const free = current?.freeMiB ?? 0
  const usedPercent = total > 0 ? Math.min(100, (used / total) * 100) : 0
  const showEmpty = !available || !current

  return (
    <section className="memory-live-panel" aria-label={ariaLabel}>
      <div className="memory-live-head">
        <div className="memory-live-title">
          <ChartLineUp weight="bold" />
          <span>{title}</span>
        </div>
        <div className="memory-live-head-right">
          {headerBadge}
          <span className="memory-live-hint">{pollHint}</span>
        </div>
      </div>

      <div className="memory-live-body">
        <div className="memory-live-stats">
          <div className="memory-live-value">{available && current ? formatGiB(used) : '—'}</div>
          <div className="memory-live-meta">
            <span>{metricLabel}</span>
            <strong>{available && current ? `${usedPercent.toFixed(0)}%` : '不可用'}</strong>
          </div>
          <div className="memory-live-detail">
            <span>总量 {formatGiB(total)}</span>
            <span>可用 {formatGiB(free)}</span>
          </div>
          {extraLine && <div className="memory-live-extra">{extraLine}</div>}
        </div>

        <div className="memory-live-chart-wrap">
          <canvas ref={canvasRef} className="memory-live-chart" />
          {showEmpty && emptyText && (
            <div className="memory-live-empty">{emptyText}</div>
          )}
        </div>
      </div>
    </section>
  )
}

export function SystemMemoryLiveChart() {
  const snapshot = useSyncExternalStore(memoryMonitor.subscribe, memoryMonitor.getSnapshot)
  return (
    <MemoryLiveChart
      title="内存监控"
      ariaLabel="内存监控"
      metricLabel="已用内存"
      pollHint="每秒采样 · 最近 2 分钟"
      windowMs={MONITOR_CHART_WINDOW_MS}
      samples={snapshot.samples}
      current={snapshot.current}
    />
  )
}

export function GpuMemoryLiveChart() {
  const snapshot = useSyncExternalStore(gpuMonitor.subscribe, gpuMonitor.getSnapshot)
  return (
    <MemoryLiveChart
      title="GPU监控"
      ariaLabel="GPU监控"
      metricLabel="已用显存"
      pollHint={`每 ${GPU_MONITOR_POLL_MS / 1000} 秒采样 · 最近 2 分钟`}
      windowMs={MONITOR_CHART_WINDOW_MS}
      samples={snapshot.samples}
      current={snapshot.current}
      available={snapshot.available}
      extraLine={snapshot.name}
      emptyText="未检测到 NVIDIA GPU，图表将保持空白"
      headerBadge={(
        <span
          className={`panel-title-badge ${snapshot.available ? 'ready' : ''}`}
          style={{
            color: snapshot.available ? '#10b981' : '#f59e0b',
            background: snapshot.available ? '#ecfdf5' : '#fffbeb'
          }}
        >
          {snapshot.available ? 'CUDA 就绪' : 'GPU 不可用'}
        </span>
      )}
    />
  )
}
