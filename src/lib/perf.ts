/**
 * Измерение плавности и скорости.
 *
 * FPS считается по rAF-дельтам без усреднения «на глаз»: храним скользящее
 * окно и считаем p95 — именно просадки, а не средний кадр, определяют
 * ощущение плавности.
 */
import { useEffect, useRef, useState } from 'react'

export interface FrameStats {
  fps: number
  p95FrameMs: number
  worstFrameMs: number
  refreshHz: number
  samples: number
}

export interface PerfSample {
  avg: number
  min: number
  max: number
  p95: number
  n: number
}

export interface PerfApi {
  measures: Record<string, number[]>
  report(): Record<string, PerfSample>
}

declare global {
  interface Window {
    __AURORA_PERF__?: PerfApi
  }
}

const MAX_FRAMES = 240

export function useFrameStats(refreshHint = 120): FrameStats {
  const [stats, setStats] = useState<FrameStats>({
    fps: refreshHint,
    p95FrameMs: 1000 / refreshHint,
    worstFrameMs: 1000 / refreshHint,
    refreshHz: refreshHint,
    samples: 0,
  })
  const deltas = useRef<number[]>([])

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let published = 0

    const tick = (now: number) => {
      const dt = now - last
      last = now
      if (dt > 0 && dt < 250) {
        const arr = deltas.current
        arr.push(dt)
        if (arr.length > MAX_FRAMES) arr.shift()
      }
      // Публикуем раз в 500 мс: перерисовка индикатора не должна мешать самому замеру
      if (now - published > 500 && deltas.current.length > 20) {
        published = now
        const arr = deltas.current
        const sorted = [...arr].sort((a, b) => a - b)
        const avg = arr.reduce((s, x) => s + x, 0) / arr.length
        setStats({
          fps: Math.round(1000 / avg),
          p95FrameMs: sorted[Math.floor(sorted.length * 0.95)],
          worstFrameMs: sorted[sorted.length - 1],
          refreshHz: detectRefreshHz(arr),
          samples: arr.length,
        })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return stats
}

/** Оценка частоты обновления монитора по минимальной наблюдаемой дельте. */
export function detectRefreshHz(deltas: number[]): number {
  if (!deltas.length) return 60
  const min = Math.min(...deltas)
  const candidate = Math.round(1000 / Math.max(min, 1000 / 240))
  for (const hz of [60, 75, 90, 120, 144, 165, 180, 240]) {
    if (candidate <= hz + 4) return hz
  }
  return candidate
}

/** Однократный замер частоты обновления экрана — для режима анимаций. */
export async function measureRefreshRate(): Promise<number> {
  return new Promise((resolve) => {
    const deltas: number[] = []
    let last = performance.now()
    let n = 0
    const tick = (now: number) => {
      deltas.push(now - last)
      last = now
      if (++n >= 90) {
        deltas.sort((a, b) => a - b)
        const median = deltas[Math.floor(deltas.length / 2)]
        resolve(Math.round(1000 / median))
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

// ── синхронные замеры операций ──

function emptyMeasures(): Record<string, number[]> {
  return {}
}

export const perf: PerfApi = {
  measures: emptyMeasures(),

  report() {
    const out: Record<string, PerfSample> = {}
    for (const [name, values] of Object.entries(this.measures)) {
      if (!values.length) continue
      const sorted = [...values].sort((a, b) => a - b)
      out[name] = {
        avg: values.reduce((s, x) => s + x, 0) / values.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        n: values.length,
      }
    }
    return out
  },
}

if (typeof window !== 'undefined') window.__AURORA_PERF__ = perf

/** Обёртка для замера асинхронной операции с попаданием в общий отчёт. */
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now()
  try {
    return await fn()
  } finally {
    const arr = (perf.measures[name] ??= [])
    arr.push(performance.now() - t0)
    if (arr.length > 200) arr.shift()
  }
}