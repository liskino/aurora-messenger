/**
 * Стенд плавности в реальном браузере.
 *
 * Здесь измеряется то, что человек и называет «лагами»: сколько времени
 * главный поток занят в каждом кадре. Если работа в кадре меньше бюджета
 * (16.7 мс на 60 Гц, 8.3 мс на 120 Гц, 5.6 мс на 180 Гц) — движение плавное;
 * если больше, браузер пропускает кадр, и это видно глазом.
 *
 * Сравниваются два варианта на одних и тех же данных:
 *   • честный список — все сообщения в DOM;
 *   • виртуализированный — только видимые, как в самом мессенджере.
 *
 * Запускается из bench/browser.mjs через Chrome DevTools Protocol.
 */
import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot, flushSync } from 'react-dom'
import { useVirtualList } from '@/hooks/useVirtualList'
import { MessageBubble } from '@/components/MessageBubble'
import { measureRefreshRate } from '@/lib/perf'
import '@/index.css'
import type { DecryptedMessage } from '@/lib/types'

const SELF = 'user-self'

function makeMessages(count: number): DecryptedMessage[] {
  const samples = [
    'Привет! Как дела?',
    'Смотри, я доделал шифрование файлов — работает на больших файлах без задержек.',
    'Ок',
    'Встречаемся в 19:00 у входа, не опаздывай 🙂',
    'Длинное сообщение для проверки переноса строк: когда текст занимает несколько строк, высота пузыря меняется, и список должен пересчитать позиции без прыжков и без перерисовки всего содержимого.',
    'Отправил файл',
  ]
  const out: DecryptedMessage[] = []
  const base = Date.now() - count * 60_000
  for (let i = 0; i < count; i++) {
    out.push({
      id: `msg-${i}`,
      chat_id: 'bench-chat',
      sender_id: i % 3 === 0 ? SELF : 'user-peer',
      ciphertext: '',
      iv: '',
      kind: 'text',
      file_path: null,
      file_name_sealed: null,
      file_name_iv: null,
      file_type: null,
      file_size: null,
      wrapped_file_key: null,
      created_at: new Date(base + i * 60_000).toISOString(),
      edited_at: null,
      text: samples[i % samples.length],
    })
  }
  return out
}

/** Виртуализированный список — тот же код и тот же компонент, что в приложении. */
function VirtualChat({ messages }: { messages: DecryptedMessage[] }) {
  const { containerRef, virtual, total, measure } = useVirtualList(messages)
  return (
    <div
      ref={containerRef}
      className="scroll-target h-screen overflow-y-auto"
      style={{ contain: 'strict' }}
    >
      <div style={{ height: total, position: 'relative' }}>
        {virtual.map((v) => {
          const m = messages[v.index]
          const prev = messages[v.index - 1]
          return (
            <div
              key={m.id}
              ref={measure(v.index)}
              className="row absolute inset-x-0"
              style={{ transform: `translate3d(0, ${v.offset}px, 0)`, paddingTop: 2 }}
            >
              <MessageBubble
                message={m}
                own={m.sender_id === SELF}
                showTail={!prev || prev.sender_id !== m.sender_id}
                onDownload={async () => new Blob()}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Честный список — все сообщения сразу, как было бы без виртуализации. */
function NaiveChat({ messages }: { messages: DecryptedMessage[] }) {
  return (
    <div className="scroll-target h-screen overflow-y-auto">
      {messages.map((m, i) => (
        <div key={m.id} style={{ paddingTop: 2 }}>
          <MessageBubble
            message={m}
            own={m.sender_id === SELF}
            showTail={!messages[i - 1] || messages[i - 1].sender_id !== m.sender_id}
            onDownload={async () => new Blob()}
          />
        </div>
      ))}
    </div>
  )
}

export interface FrameSample {
  count: number
  longest: number
  dropped: number
  p95: number
  median: number
  total: number
}

/**
 * Прокручивает контейнер и собирает длительности кадров.
 *
 * Кадры считаем по rAF: если между двумя кадрами прошло заметно больше
 * бюджета, значит главный поток был занят и кадр пропущен — это и есть
 * «дёрганье», которое замечает человек.
 *
 * ВАЖНО: в headless-браузере без графического ускорения rAF по умолчанию
 * даёт ровно 60 кадров в секунду независимо от мощности компьютера, поэтому
 * медиана здесь всегда около 16.7 мс. Показательны не медиана, а ХВОСТ
 * распределения (p95 и худший кадр) и число пропущенных кадров: именно они
 * меняются, когда список начинает тормозить.
 */
function measureScroll(durationMs: number, budget: number): Promise<FrameSample> {
  return new Promise((resolve) => {
    const scroller = document.querySelector('.scroll-target') as HTMLElement | null
    const deltas: number[] = []
    let last = performance.now()
    const started = last
    let direction = 1

    const step = () => {
      const now = performance.now()
      deltas.push(now - last)
      last = now

      if (scroller) {
        // Прокрутка туда-сюда: так список перерисовывается постоянно,
        // а не только первые полсекунды.
        scroller.scrollTop += 28 * direction
        if (scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 5) direction = -1
        if (scroller.scrollTop <= 5) direction = 1
      }

      if (now - started < durationMs) {
        requestAnimationFrame(step)
      } else {
        const sorted = [...deltas].sort((a, b) => a - b)
        resolve({
          count: deltas.length,
          longest: sorted[sorted.length - 1] ?? 0,
          dropped: deltas.filter((d) => d > budget * 1.5).length,
          p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
          median: sorted[Math.floor(sorted.length / 2)] ?? 0,
          total: now - started,
        })
      }
    }
    requestAnimationFrame(step)
  })
}

/**
 * Сколько главный поток занят отрисовкой списка.
 *
 * Меряем именно блокировку, а не «время до следующего кадра»: flushSync
 * заставляет React отрисовать и применить изменения синхронно, поэтому
 * замер честно показывает, на сколько миллисекунд список задерживает кадр.
 *
 * Отдельно замеряется раскладка: вызов offsetHeight заставляет браузер
 * посчитать геометрию — это вторая половина реальной стоимости прокрутки.
 *
 * Делаем три прогона и берём лучший: первый включает разогрев JIT, и
 * показывать его было бы нечестно по отношению к обоим вариантам.
 */
async function renderCost(
  messages: DecryptedMessage[],
  virtual: boolean,
): Promise<{ render: number; layout: number; nodes: number }> {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:900px;height:800px'
  document.body.appendChild(host)
  const root = createRoot(host)

  let best = { render: Infinity, layout: Infinity, nodes: 0 }

  for (let run = 0; run < 3; run++) {
    const t0 = performance.now()
    flushSync(() => {
      root.render(virtual ? <VirtualChat messages={messages} /> : <NaiveChat messages={messages} />)
    })
    const afterRender = performance.now()
    // Принудительная раскладка: без неё стоимость пересчёта геометрии
    // просто отложилась бы до следующего кадра и не попала в замер.
    const h = host.offsetHeight
    const afterLayout = performance.now()

    if (afterRender - t0 < best.render) {
      best = {
        render: afterRender - t0,
        layout: afterLayout - afterRender,
        nodes: host.querySelectorAll('*').length,
      }
    }
    void h
    await new Promise((r) => requestAnimationFrame(() => r(null)))
  }

  root.unmount()
  host.remove()
  return best
}

function Harness() {
  const [messages, setMessages] = useState<DecryptedMessage[]>([])
  const [mode, setMode] = useState<'virtual' | 'naive'>('virtual')
  const ready = useRef(false)

  useEffect(() => {
    // Частоту экрана измеряем до сценариев: от неё зависит бюджет кадра,
    // по которому драйвер решает, есть ли пропуски.
    measureRefreshRate().then((hz) => {
      ;(window as unknown as Record<string, unknown>).__AURORA_HZ__ = hz
    })

    // Публикуем управление для внешнего драйвера (CDP).
    ;(window as unknown as Record<string, unknown>).__harness__ = {
      setSize: (n: number) => setMessages(makeMessages(n)),
      setMode,
      count: () => document.querySelectorAll('.bubble').length,
      nodes: () => document.querySelectorAll('*').length,
      renderCost,
      measureScroll,
      makeMessages,
      reset: () => {
        ready.current = true
      },
    }
    ready.current = true
  }, [])

  if (!messages.length) {
    return <div style={{ padding: 40 }}>Стенд готов, ожидает команды драйвера…</div>
  }

  return mode === 'virtual' ? (
    <VirtualChat messages={messages} />
  ) : (
    <NaiveChat messages={messages} />
  )
}

createRoot(document.getElementById('bench-root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
)