import { useEffect, useRef, useState } from 'react'
import {
  Mic,
  MicOff,
  MonitorUp,
  MonitorX,
  Phone,
  PhoneOff,
  Video,
  VideoOff,
  Wifi,
} from 'lucide-react'
import { calls, hasTurn, rtcSupported, type CallInfo, type CallParticipant } from '@/lib/rtc'
import { playTone } from '@/lib/notify'
import { Avatar } from './Avatar'

/**
 * Экран звонка.
 *
 * Видео выводится напрямую в <video> через srcObject, без промежуточных
 * состояний React: поток меняется десятки раз в секунду, и прогонять его
 * через ререндеры — верный способ получить рывки.
 *
 * Своё видео показывается маленьким окном в углу: так человек видит, что
 * именно передаёт, и замечает, если камера случайно закрыта.
 */
export function CallOverlay({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<CallInfo | null>(calls.currentCall)
  const [state, setState] = useState(calls.currentState)
  const [participants, setParticipants] = useState<CallParticipant[]>(calls.listParticipants())
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [sharing, setSharing] = useState(false)
  const [quality, setQuality] = useState({ rtt: 0, bitrate: 0 })
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const off = calls.on((e) => {
      switch (e.type) {
        case 'state':
          setState(e.state)
          break
        case 'incoming':
          setInfo(e.call)
          break
        case 'participants':
          setParticipants(e.participants)
          break
        case 'local':
          setLocalStream(e.stream)
          break
        case 'quality':
          setQuality({ rtt: e.rtt, bitrate: e.bitrate })
          break
        case 'ended':
          playTone('end')
          onClose()
          break
        case 'error':
          setError(e.error.message)
          break
      }
    })
    return off
  }, [onClose])

  // Таймер разговора: включается только когда связь действительно есть.
  useEffect(() => {
    if (state !== 'active') return
    const started = Date.now()
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(t)
  }, [state])

  if (!info) return null

  const isIncoming = state === 'incoming'
  const isRinging = state === 'inviting'
  const connected = state === 'active'

  return (
    <div className="anim-fade fixed inset-0 z-[60] flex flex-col bg-ink-950/97 backdrop-blur-xl">
      {/* Шапка */}
      <header className="flex items-center gap-3 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-white">{info.title}</h2>
          <p className="flex items-center gap-2 text-sm text-mist-400">
            {connected ? (
              <>
                <Wifi size={12} className={quality.rtt > 200 ? 'text-amber-400' : 'text-aqua-400'} />
                {formatDuration(elapsed)}
                {quality.rtt > 0 && ` · задержка ${Math.round(quality.rtt)} мс`}
                {quality.bitrate > 0 && ` · ${quality.bitrate.toFixed(0)} кбит/с`}
              </>
            ) : isIncoming ? (
              'Входящий звонок'
            ) : isRinging ? (
              'Соединяю…'
            ) : (
              'Подключаюсь…'
            )}
          </p>
        </div>
        {sharing && (
          <span className="anim-fade rounded-full bg-brand-500/20 px-3 py-1 text-xs text-brand-400">
            идёт демонстрация экрана
          </span>
        )}
      </header>

      {/* Ошибка связи — самая частая причина именно отсутствие TURN */}
      {error && (
        <div className="anim-fade mx-5 mb-2 rounded-xl bg-amber-500/12 px-4 py-3 text-sm text-amber-200">
          {error}
          {!hasTurn() && (
            <p className="mt-1.5 text-xs opacity-80">
              Ретранслятор не отвечает. Звонки внутри одной сети будут работать, между разными —
              могут не соединиться.
            </p>
          )}
        </div>
      )}

      {/* Видео участников */}
      <div className="flex min-h-0 flex-1 flex-wrap items-center justify-center gap-3 p-3">
        {/* Свой поток: маленький, в углу */}
        {localStream && !isIncoming && (
          <div className="fixed bottom-32 right-4 z-10 w-40 overflow-hidden rounded-2xl ring-1 ring-white/10 md:w-56">
            <LocalVideo stream={localStream} muted micOn={micOn} />
          </div>
        )}

        {participants.map((p) => (
          <ParticipantTile key={p.userId} participant={p} />
        ))}

        {/* Ожидание: показываем, что происходит, а не пустой экран */}
        {!participants.length && (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="relative">
              <Avatar name={info.title} id={info.chatId} size={96} />
              {(isRinging || isIncoming) && (
                <>
                  <span className="absolute inset-0 animate-ping rounded-full bg-brand-500/30" />
                  <span
                    className="absolute inset-0 animate-ping rounded-full bg-brand-500/20"
                    style={{ animationDelay: '0.6s' }}
                  />
                </>
              )}
            </div>
            <p className="text-mist-300">
              {isIncoming ? 'Вас вызывают' : isRinging ? 'Ждём ответа…' : 'Соединяю…'}
            </p>
            {info.kind === 'video' && !isIncoming && (
              <p className="max-w-xs text-xs text-mist-400">
                Камера и микрофон уже работают — вас увидят и услышат после ответа.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Кнопки управления */}
      <footer className="flex items-center justify-center gap-3 px-5 pb-8 pt-4">
        {isIncoming ? (
          <>
            <CallButton
              onClick={() => void calls.reject()}
              danger
              label="Отклонить"
              icon={<PhoneOff size={22} />}
            />
            <CallButton
              onClick={() => {
                playTone('call')
                void calls.accept().catch((e) => setError((e as Error).message))
              }}
              success
              label="Ответить"
              icon={<Phone size={22} />}
            />
          </>
        ) : (
          <>
            <CallButton
              onClick={() => setMicOn(calls.toggleMic())}
              active={!micOn}
              label={micOn ? 'Микрофон' : 'Включить микрофон'}
              icon={micOn ? <Mic size={20} /> : <MicOff size={20} />}
            />
            {info.kind === 'video' && (
              <CallButton
                onClick={() => setCamOn(calls.toggleCamera())}
                active={!camOn}
                label={camOn ? 'Камера' : 'Включить камеру'}
                icon={camOn ? <Video size={20} /> : <VideoOff size={20} />}
              />
            )}
            <CallButton
              onClick={async () => {
                try {
                  if (sharing) {
                    await calls.stopScreenShare()
                    setSharing(false)
                  } else {
                    await calls.startScreenShare()
                    setSharing(true)
                  }
                } catch (e) {
                  // Отказ от выбора окна — не ошибка, просто ничего не делаем.
                  const msg = (e as Error).message
                  if (!/Permission denied|aborted|отменено/i.test(msg)) setError(msg)
                }
              }}
              active={sharing}
              label={sharing ? 'Остановить показ' : 'Показать экран'}
              icon={sharing ? <MonitorX size={20} /> : <MonitorUp size={20} />}
            />
            <CallButton
              onClick={() => void calls.hangup()}
              danger
              label="Завершить"
              icon={<PhoneOff size={22} />}
            />
          </>
        )}
      </footer>

      {!rtcSupported() && (
        <div className="absolute inset-x-0 bottom-0 bg-red-500/15 px-4 py-2 text-center text-xs text-red-200">
          Звонки работают только по HTTPS. Откройте страницу по защищённому адресу.
        </div>
      )}
    </div>
  )
}

/** Своё видео: показываем именно то, что передаётся, и гасим, если камера выключена. */
function LocalVideo({
  stream,
  muted,
  micOn,
}: {
  stream: MediaStream
  muted: boolean
  micOn: boolean
}) {
  const ref = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.srcObject = stream
    // play() возвращает промис и может быть отклонён, если элемент ещё не готов.
    void el.play().catch(() => undefined)
  }, [stream])

  return (
    <div className="relative aspect-video bg-ink-800">
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted}
        className={`size-full object-cover ${micOn ? '' : ''}`}
        // Своё изображение зеркалим: так привычнее, как в зеркале.
        style={{ transform: 'scaleX(-1)' }}
      />
      <span className="absolute bottom-1.5 left-2 rounded bg-black/50 px-1.5 py-0.5 text-[0.625rem] text-white">
        Вы
      </span>
    </div>
  )
}

/** Плитка участника: видео или аватар, если камера выключена. */
function ParticipantTile({ participant }: { participant: CallParticipant }) {
  const ref = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || !participant.stream) return
    el.srcObject = participant.stream
    void el.play().catch(() => undefined)
  }, [participant.stream])

  const hasVideo = Boolean(participant.stream?.getVideoTracks().length) && !participant.videoOff

  return (
    <div className="relative aspect-video w-full max-w-3xl overflow-hidden rounded-2xl bg-ink-850 ring-1 ring-white/8">
      {hasVideo ? (
        <video ref={ref} autoPlay playsInline className="size-full object-cover" />
      ) : (
        <div className="grid size-full place-items-center">
          <Avatar name={participant.userId.slice(0, 6)} id={participant.userId} size={72} />
        </div>
      )}

      <div className="absolute bottom-2 left-2 flex items-center gap-2">
        <span className="rounded bg-black/55 px-2 py-0.5 text-xs text-white">
          {participant.connection === 'connected' ? 'на связи' : 'подключение…'}
        </span>
        {participant.muted && (
          <span className="grid size-6 place-items-center rounded bg-black/55">
            <MicOff size={12} className="text-red-300" />
          </span>
        )}
        {participant.sharing && (
          <span className="rounded bg-brand-500/70 px-2 py-0.5 text-xs text-white">экран</span>
        )}
      </div>
    </div>
  )
}

function CallButton({
  onClick,
  icon,
  label,
  danger,
  success,
  active,
}: {
  onClick: () => void
  icon: React.ReactNode
  label: string
  danger?: boolean
  success?: boolean
  active?: boolean
}) {
  const tone = danger
    ? 'bg-red-500 hover:bg-red-400 text-white shadow-red-500/25'
    : success
      ? 'bg-emerald-500 hover:bg-emerald-400 text-white shadow-emerald-500/25'
      : active
        ? 'bg-white text-ink-900'
        : 'bg-ink-700 hover:bg-ink-600 text-mist-200'

  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid size-14 place-items-center rounded-full shadow-lg transition-transform duration-150 will-change-transform hover:scale-105 active:scale-95 ${tone}`}
    >
      {icon}
    </button>
  )
}

function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m < 60) return `${m}:${String(s).padStart(2, '0')}`
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}