/**
 * Виртуализация списка сообщений.
 *
 * Зачем: при 10 000 сообщениях честный DOM даёт десятки тысяч узлов, и любая
 * перерисовка стоит сотни миллисекунд — это и есть «лаги». Здесь рисуются
 * только видимые строки плюс небольшой запас.
 *
 * Как устроено и почему именно так:
 *
 *  • Позиции строк хранятся как массив префиксных сумм. Пересобирается он
 *    ТОЛЬКО когда меняются измеренные высоты или число сообщений — но не на
 *    каждой прокрутке. Это принципиально: если пересчитывать суммы в кадре
 *    прокрутки, на 10 000 сообщениях уходит больше миллисекунды на кадр плюс
 *    постоянные аллокации, и список начинает дёргаться от сборщика мусора.
 *  • Высоты строк неизвестны заранее (текст переносится), поэтому они
 *    измеряются на месте и запоминаются. Замеры применяются одним пакетом
 *    раз в кадр, чтобы не вызывать лавину перерисовок.
 *  • Границы видимой области ищутся бинарным поиском: O(log n) вместо O(n).
 *  • Событие прокрутки обрабатывается через requestAnimationFrame, иначе
 *    состояние обновляется чаще, чем браузер успевает рисовать.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface VirtualItem {
  index: number
  offset: number
  height: number
}

export function useVirtualList<T>(items: T[], estimate = 64, overscan = 6) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const heights = useRef<Map<number, number>>(new Map())
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(600)
  /** Увеличивается, когда набор измеренных высот изменился и суммы устарели. */
  const [metricsVersion, setMetricsVersion] = useState(0)

  const rafPending = useRef(false)
  const metricsDirty = useRef(false)
  const metricsRaf = useRef(0)

  // ─── прокрутка ───

  const onScroll = useCallback(() => {
    const el = containerRef.current
    if (!el || rafPending.current) return
    rafPending.current = true
    requestAnimationFrame(() => {
      rafPending.current = false
      const node = containerRef.current
      if (node) setScrollTop(node.scrollTop)
    })
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('scroll', onScroll, { passive: true })

    const ro = new ResizeObserver(() => setViewport(el.clientHeight))
    ro.observe(el)
    setViewport(el.clientHeight)

    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [onScroll])

  // ─── префиксные суммы ───

  // Пересчитываем только при смене данных или измерений, а не при прокрутке.
  const offsets = useMemo(() => {
    const next: number[] = new Array(items.length)
    let acc = 0
    for (let i = 0; i < items.length; i++) {
      next[i] = acc
      acc += heights.current.get(i) ?? estimate
    }
    return next
  }, [items, estimate, metricsVersion])

  const total = useMemo(() => {
    if (!offsets.length) return 0
    const last = items.length - 1
    return offsets[last] + (heights.current.get(last) ?? estimate)
  }, [offsets, items.length, estimate])

  // ─── видимый диапазон ───

  const range = useMemo(() => {
    if (!items.length) return { start: 0, end: 0, virtual: [] as VirtualItem[] }

    const top = Math.max(0, scrollTop - estimate * overscan)
    const limit = scrollTop + viewport + estimate * overscan

    // Бинарный поиск первой строки, попадающей в область.
    let lo = 0
    let hi = items.length - 1
    let start = items.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid] >= top) {
        start = mid
        hi = mid - 1
      } else {
        lo = mid + 1
      }
    }
    start = Math.max(0, start - overscan)

    let end = start
    while (end < items.length && offsets[end] < limit) end++
    end = Math.min(items.length, end + overscan)

    const virtual: VirtualItem[] = []
    for (let i = start; i < end; i++) {
      virtual.push({ index: i, offset: offsets[i], height: heights.current.get(i) ?? estimate })
    }
    return { start, end, virtual }
  }, [offsets, scrollTop, viewport, estimate, overscan, items.length])

  // ─── измерение высот ───

  /**
   * Регистрирует реальную высоту строки.
   *
   * Все изменения за кадр собираются вместе и применяются один раз: иначе
   * на первом рендере мы получили бы по перерисовке на каждую строку.
   */
  const measure = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      if (!el) return
      const h = el.offsetHeight
      if (!h) return
      if (heights.current.get(index) === h) return

      heights.current.set(index, h)
      metricsDirty.current = true
      if (metricsRaf.current) return

      metricsRaf.current = requestAnimationFrame(() => {
        metricsRaf.current = 0
        if (metricsDirty.current) {
          metricsDirty.current = false
          setMetricsVersion((v) => v + 1)
        }
      })
    },
    [],
  )

  useEffect(
    () => () => {
      if (metricsRaf.current) cancelAnimationFrame(metricsRaf.current)
    },
    [],
  )

  /** Сбрасывает измерения — нужен при полной смене списка (другой чат). */
  const resetMetrics = useCallback(() => {
    heights.current.clear()
    setMetricsVersion((v) => v + 1)
    setScrollTop(0)
    const el = containerRef.current
    if (el) el.scrollTop = 0
  }, [])

  const scrollToBottom = useCallback((smooth = false) => {
    const el = containerRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  return {
    containerRef,
    virtual: range.virtual,
    total,
    measure,
    scrollToBottom,
    resetMetrics,
    range: { start: range.start, end: range.end },
  }
}