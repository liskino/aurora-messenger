import { useEffect, useRef, useState } from 'react'
import { measureRefreshRate } from '@/lib/perf'

/**
 * Хук плавности.
 *
 * 1. Один раз измеряет реальную частоту монитора (не верит navigator).
 * 2. Держит индикатор FPS на актуальной частоте экрана.
 * 3. Включает быстрый режим анимаций на 120+ Гц, чтобы на быстром дисплее
 *    движение не выглядело вялым.
 */
export function useRefreshProfile() {
  const [hz, setHz] = useState(60)
  const [fps, setFps] = useState(60)
  const [p95, setP95] = useState(16.7)
  const [worst, setWorst] = useState(16.7)
  const measured = useRef(false)

  useEffect(() => {
    if (measured.current) return
    measured.current = true
    measureRefreshRate().then((h) => {
      setHz(h)
      document.documentElement.classList.toggle('fast-motion', h >= 120)
      document.documentElement.dataset.refresh = String(h)
    })
  }, [])

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let published = performance.now()
    const deltas: number[] = []

    const tick = (now: number) => {
      const dt = now - last
      last = now
      if (dt > 0 && dt < 200) {
        deltas.push(dt)
        if (deltas.length > 180) deltas.shift()
      }
      if (now - published > 500 && deltas.length > 15) {
        published = now
        const sorted = [...deltas].sort((a, b) => a - b)
        const avg = deltas.reduce((s, x) => s + x, 0) / deltas.length
        setFps(Math.min(hz, Math.round(1000 / avg)))
        setP95(sorted[Math.floor(sorted.length * 0.95)])
        setWorst(sorted[sorted.length - 1])
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [hz])

  return { hz, fps, p95, worst, fastMode: hz >= 120 }
}