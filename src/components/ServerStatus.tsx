import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, WifiOff } from 'lucide-react'
import { health } from '@/lib/api'

/**
 * Состояние своего сервера на экране входа.
 *
 * Зачем это нужно: сервер поднимается вместе с приложением, и если его
 * нет — например, страницу открыли из старой вкладки после остановки —
 * человек должен увидеть причину, а не молча неработающую кнопку «Войти».
 *
 * Проверка занимает миллисекунды и заодно показывает задержку ответа:
 * по ней сразу видно, работает ли всё нормально.
 */
export function ServerStatus() {
  const [state, setState] = useState<'checking' | 'ok' | 'offline' | 'error'>('checking')
  const [rtt, setRtt] = useState(0)
  const [version, setVersion] = useState('')

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    const check = async () => {
      const t0 = performance.now()
      try {
        const info = await health()
        if (cancelled) return
        setRtt(Math.round(performance.now() - t0))
        setVersion(info.version)
        setState(info.ok ? 'ok' : 'error')
      } catch {
        if (!cancelled) setState('offline')
      }
    }

    void check()
    // Пока сервер не отвечает, проверяем снова: он мог ещё подниматься.
    timer = setInterval(() => {
      if (state === 'offline') void check()
    }, 3000)

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  if (state === 'checking') {
    return (
      <div className="anim-fade mx-auto mb-4 flex w-full max-w-sm items-center gap-2 rounded-xl bg-ink-800/60 px-3 py-2 text-xs text-mist-400">
        <Loader2 size={13} className="anim-spin" />
        Соединяюсь с сервером…
      </div>
    )
  }

  if (state === 'offline') {
    return (
      <div className="anim-fade mx-auto mb-4 w-full max-w-sm rounded-xl bg-red-500/10 px-3.5 py-3 text-xs text-red-300">
        <div className="mb-1.5 flex items-center gap-2 font-medium">
          <WifiOff size={14} />
          Сервер не отвечает
        </div>
        <p className="leading-relaxed opacity-90">
          Мессенджер не запущен. Закройте эту страницу и снова запустите{' '}
          <code className="font-mono">start.bat</code> — сервер поднимется вместе с приложением.
        </p>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="anim-fade mx-auto mb-4 flex w-full max-w-sm items-center gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
        <AlertTriangle size={13} />
        Сервер запущен, но отвечает с ошибкой
      </div>
    )
  }

  return (
    <div className="anim-fade mx-auto mb-4 flex w-full max-w-sm items-center gap-2 rounded-xl bg-emerald-500/8 px-3 py-2 text-xs text-emerald-300/90">
      <CheckCircle2 size={13} />
      <span className="flex-1">Сервер работает · свой, локальный</span>
      <span className="font-mono opacity-70">{rtt} мс</span>
      {version && <span className="font-mono opacity-50">v{version}</span>}
    </div>
  )
}