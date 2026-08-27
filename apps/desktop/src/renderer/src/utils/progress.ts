export function formatTaskPercent(percent: number | undefined): string {
  const value = Number.isFinite(percent) ? Math.round(percent as number) : 0
  return `${Math.max(0, Math.min(100, value))}%`
}
