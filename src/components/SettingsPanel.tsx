import { useEffect, useState } from 'react'
import {
  Activity,
  Bell,
  Fingerprint,
  Loader2,
  LogOut,
  MonitorSmartphone,
  PhoneCall,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { engine } from '@/lib/engine'
import { fingerprint } from '@/lib/crypto'
import { checkDevices, hasTurn, rtcSupported } from '@/lib/rtc'
import { notificationsAllowed, requestNotificationPermission } from '@/lib/notify'
import type { Device } from '@/lib/types'

interface Props {
  onClose: () => void
  onLogout: () => void
  perf: { hz: number; fps: number; p95: number; worst: number }
}

/**
 * Настройки: устройства, отпечаток ключа, замеры производительности.
 *
 * Отпечаток ключа показывается не для красоты: это единственный способ
 * убедиться голосом, что собеседник — тот, за кого себя выдаёт, и что
 * шифрование идёт без посредника.
 */
export function SettingsPanel({ onClose, onLogout, perf }: Props) {
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(true)
  const [fingerprintText, setFingerprintText] = useState('')
  const [bench, setBench] = useState<Record<string, number> | null>(null)
  const [benchRunning, setBenchRunning] = useState(false)
  const [devices_, setMediaDevices] = useState({ audio: false, video: false })
  const [notifOn, setNotifOn] = useState(notificationsAllowed())

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [list, fp, media] = await Promise.all([
          engine.devices(),
          engine.session ? fingerprint(engine.session.profile.public_key) : Promise.resolve(''),
          checkDevices(),
        ])
        if (cancelled) return
        setDevices(list)
        setFingerprintText(fp)
        setMediaDevices(media)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const runBenchmark = async () => {
    setBenchRunning(true)
    try {
      setBench(await engine.benchmark())
    } finally {
      setBenchRunning(false)
    }
  }

  return (
    <div className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="anim-pop max-h-[86vh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/8 bg-ink-850 p-5 shadow-2xl">
        <div className="mb-5 flex items-center gap-2">
          <ShieldCheck size={18} className="text-aqua-500" />
          <h2 className="flex-1 font-semibold text-white">Настройки</h2>
          <button
            onClick={onClose}
            className="grid size-8 place-items-center rounded-lg text-mist-300 hover:bg-white/5 active:scale-95"
          >
            <X size={17} />
          </button>
        </div>

        {/* Устройства */}
        <section className="mb-5">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-wide text-mist-400">
            <MonitorSmartphone size={13} /> Устройства
          </h3>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-mist-400">
              <Loader2 size={14} className="anim-spin" /> Загрузка…
            </div>
          ) : (
            <ul className="space-y-1.5">
              {devices.map((d) => (
                <li
                  key={d.id}
                  className="row flex items-center gap-3 rounded-xl bg-ink-800 px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-white">{d.label}</p>
                    <p className="truncate text-[0.6875rem] text-mist-400">
                      активен {new Date(d.last_active).toLocaleString('ru-RU')}
                    </p>
                  </div>
                  <button
                    onClick={async () => {
                      await engine.forgetThisDevice()
                    }}
                    className="grid size-8 place-items-center rounded-lg text-mist-400 transition-transform hover:bg-red-500/10 hover:text-red-300 active:scale-95"
                    title="Забыть устройство: пароль потребуется снова"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
              {!devices.length && (
                <li className="rounded-xl bg-ink-800 px-3 py-2.5 text-sm text-mist-400">
                  Устройства не зарегистрированы
                </li>
              )}
            </ul>
          )}
        </section>

        {/* Звонки */}
        <section className="mb-5">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-wide text-mist-400">
            <PhoneCall size={13} /> Звонки
          </h3>
          <div className="space-y-2 rounded-xl bg-ink-800 p-3 text-xs">
            <StatusRow
              ok={rtcSupported()}
              label="WebRTC доступен"
              note={rtcSupported() ? 'HTTPS и браузер поддерживают звонки' : 'Нужен HTTPS: откройте сайт по защищённому адресу'}
            />
            <StatusRow
              ok={devices_.audio}
              label="Микрофон"
              note={devices_.audio ? 'найден' : 'не обнаружен — говорить не получится'}
            />
            <StatusRow
              ok={devices_.video}
              label="Камера"
              note={devices_.video ? 'найдена' : 'не обнаружена — видеозвонок будет только голосовым'}
            />
            <StatusRow
              ok={hasTurn()}
              label="TURN-сервер"
              note={
                hasTurn()
                  ? 'настроен — звонки пройдут через любые сети'
                  : 'не настроен: между мобильным интернетом и Wi-Fi звонок может не соединиться'
              }
              warn={!hasTurn()}
            />
            <p className="pt-1 text-[0.6875rem] leading-relaxed text-mist-400">
              Медиа идёт напрямую между участниками и шифруется DTLS-SRTP — встроенным
              шифрованием WebRTC. Сервер в разговоре не участвует.
            </p>
          </div>
        </section>

        {/* Уведомления */}
        <section className="mb-5">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-wide text-mist-400">
            <Bell size={13} /> Уведомления
          </h3>
          <div className="flex items-center gap-3 rounded-xl bg-ink-800 p-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-white">
                {notifOn ? 'Включены' : 'Выключены'}
              </p>
              <p className="text-[0.6875rem] text-mist-400">
                {notifOn
                  ? 'Показываются только когда окно неактивно или открыт другой чат'
                  : 'Разрешите, чтобы не пропускать сообщения при свёрнутом окне'}
              </p>
            </div>
            {!notifOn && (
              <button
                onClick={async () => {
                  const ok = await requestNotificationPermission()
                  setNotifOn(ok)
                }}
                className="shrink-0 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white transition-transform hover:scale-[1.03] active:scale-[0.97]"
              >
                Разрешить
              </button>
            )}
          </div>
        </section>

        {/* Отпечаток ключа */}
        {fingerprintText && (
          <section className="mb-5">
            <h3 className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-wide text-mist-400">
              <Fingerprint size={13} /> Отпечаток вашего ключа
            </h3>
            <p className="rounded-xl bg-ink-800 px-3 py-2.5 font-mono text-xs tracking-wider text-aqua-400">
              {fingerprintText}
            </p>
            <p className="mt-1.5 text-[0.6875rem] leading-relaxed text-mist-400">
              Продиктуйте его собеседнику и сверьте — так вы убедитесь, что посредника в канале нет.
            </p>
          </section>
        )}

        {/* Производительность */}
        <section className="mb-5">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-wide text-mist-400">
            <Activity size={13} /> Производительность
          </h3>
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Частота экрана" value={`${perf.hz} Гц`} />
            <Metric label="Кадров в секунду" value={`${perf.fps}`} />
            <Metric label="p95 кадра" value={`${perf.p95.toFixed(1)} мс`} />
            <Metric label="Худший кадр" value={`${perf.worst.toFixed(1)} мс`} />
          </div>

          <button
            onClick={() => void runBenchmark()}
            disabled={benchRunning}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-ink-800 py-2.5 text-sm font-medium text-white transition-transform duration-150 will-change-transform hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50"
          >
            {benchRunning && <Loader2 size={14} className="anim-spin" />}
            {benchRunning ? 'Замер…' : 'Замерить шифрование и связь'}
          </button>

          {bench && (
            <dl className="anim-fade mt-3 space-y-1 rounded-xl bg-ink-800 p-3 text-xs">
              {Object.entries(bench).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="text-mist-400">{BENCH_LABELS[k] ?? k}</dt>
                  <dd className="font-mono text-mist-200">
                    {v < 0 ? 'нет связи' : v < 1 ? `${v.toFixed(3)} мс` : `${v.toFixed(1)} мс`}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        <button
          onClick={onLogout}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-red-500/10 py-2.5 text-sm font-medium text-red-300 transition-transform duration-150 hover:bg-red-500/15 active:scale-[0.99]"
        >
          <LogOut size={15} /> Выйти на этом устройстве
        </button>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-ink-800 px-3 py-2.5">
      <p className="text-[0.6875rem] text-mist-400">{label}</p>
      <p className="font-mono text-sm text-white">{value}</p>
    </div>
  )
}

/** Строка состояния возможности: галочка или предупреждение, без «тишины». */
function StatusRow({
  ok,
  label,
  note,
  warn,
}: {
  ok: boolean
  label: string
  note: string
  warn?: boolean
}) {
  const color = ok ? 'text-emerald-400' : warn ? 'text-amber-400' : 'text-red-400'
  const mark = ok ? '✓' : warn ? '!' : '✕'
  return (
    <div className="flex items-start gap-2">
      <span className={`mt-0.5 font-mono text-xs ${color}`}>{mark}</span>
      <div className="min-w-0 flex-1">
        <p className="text-mist-200">{label}</p>
        <p className="text-[0.6875rem] leading-relaxed text-mist-400">{note}</p>
      </div>
    </div>
  )
}

const BENCH_LABELS: Record<string, string> = {
  seal_256B: 'Шифрование 256 Б',
  seal_8KB: 'Шифрование 8 КБ',
  open_256B: 'Расшифровка 256 Б',
  keygen_ecdh: 'Генерация ключей ECDH',
  pbkdf2_600k: 'Вывод ключа из пароля (600k)',
  wrap_chatkey: 'Обёртка ключа чата',
  server_rtt: 'Задержка до сервера',
}