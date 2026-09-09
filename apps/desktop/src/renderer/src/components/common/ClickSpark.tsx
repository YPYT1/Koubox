import type { MouseEvent } from 'react'

export function showClickSpark(event: MouseEvent<HTMLButtonElement>): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const button = event.currentTarget
  const rect = button.getBoundingClientRect()
  const spark = document.createElement('i')
  spark.className = 'click-spark'
  spark.style.left = `${event.clientX - rect.left}px`
  spark.style.top = `${event.clientY - rect.top}px`
  button.appendChild(spark)
  spark.addEventListener('animationend', () => spark.remove(), { once: true })
}
