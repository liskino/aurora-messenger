import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, Paperclip, Send, ShieldCheck } from 'lucide-react'
import { engine } from '@/lib/engine'
import { timed } from '@/lib/perf'
import type { Chat, DecryptedMessage, Profile } from '@/lib/types'
import { useVirtualList } from '@/hooks/useVirtualList'
import { MessageBubble } from './MessageBubble'

interface Props {
  chat: Chat
  peer?: Profile
  members: Profile[]
  selfId: string
  onBack: () => void
}

/**
 * Экран переписки.
 *
 * Что здесь сделано ради плавности:
 *  • список виртуализирован — рисуются только видимые сообщения;
 *  • прокрутка ставится синхронно до отрисовки кадра (useLayoutEffect),
 *    поэтому нет «прыжка» и лишнего кадра;
 *  • отправка оптимистична: пузырь появляется мгновенно, сеть догоняет;
 *  • ввод текста не трогает список — состояние ввода отделено от сообщений.
 */
export function ChatView({ chat, peer, members, selfId, onBack }: Props) {
  const [messages, setMessages] = useState<DecryptedMessage[]>(() => engine.cachedMessages(chat.id))
  const [draft, setDraft] = useState('')
  const [typingUser, setTypingUser] = useState<string | null>(null)
  const [uploading, setUploading] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stickToBottom = useRef(true)
  const fileInput = useRef<HTMLInputElement | null>(null)

  const { containerRef, virtual, total, measure, scrollToBottom, resetMetrics } =
    useVirtualList(messages)

  // Загрузка истории: замеряем, чтобы видеть реальную скорость на устройстве.
  useEffect(() => {
    let cancelled = false
    // Высоты строк другого чата не имеют отношения к этому — сбрасываем,
    // иначе первые позиции будут посчитаны по чужой геометрии.
    resetMetrics()
    setMessages(engine.cachedMessages(chat.id))
    ;(async () => {
      try {
        const history = await timed('chat_history_load', () => engine.loadHistory(chat.id))
        if (!cancelled) setMessages([...history])
        void engine.markChatRead(chat.id)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [chat.id, resetMetrics])

  // Новые сообщения и «печатает» из realtime.
  useEffect(() => {
    const off = engine.on((e) => {
      if (e.type === 'message' && e.chatId === chat.id) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === e.message.id)) return prev
          return [...prev, e.message]
        })
        if (e.message.sender_id !== selfId) {
          void engine.markChatRead(chat.id)
        }
      } else if (e.type === 'typing' && e.chatId === chat.id) {
        setTypingUser(e.userId)
      }
    })
    return () => {
      off()
    }
  }, [chat.id, selfId])

  useEffect(() => {
    if (!typingUser) return
    const t = setTimeout(() => setTypingUser(null), 3200)
    return () => clearTimeout(t)
  }, [typingUser])

  // Прокрутка вниз до отрисовки кадра — так не видно «догоняния».
  useLayoutEffect(() => {
    if (stickToBottom.current) scrollToBottom(false)
  }, [messages, scrollToBottom])

  const onScrollStick = () => {
    const el = containerRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('scroll', onScrollStick, { passive: true })
    return () => el.removeEventListener('scroll', onScrollStick)
  }, [containerRef])

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    stickToBottom.current = true
    try {
      await timed('send_message', () => engine.sendText(chat.id, text))
    } catch (e) {
      setError((e as Error).message)
      setDraft(text)
    }
  }

  const attach = async (file: File) => {
    setUploading(0)
    try {
      await engine.sendFile(chat.id, file, (r) => setUploading(r))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUploading(null)
    }
  }

  const title = chat.kind === 'group' ? (chat.title ?? 'Группа') : (peer?.display_name ?? 'Чат')
  const subtitle = chat.kind === 'group' ? `${members.length} участников` : '@' + (peer?.username ?? '')

  const typingName = useMemo(
    () => (typingUser ? (members.find((m) => m.id === typingUser)?.display_name ?? 'Кто-то') : null),
    [typingUser, members],
  )

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-ink-900">
      {/* Шапка */}
      <header className="anim-fade z-10 flex items-center gap-3 border-b border-white/5 bg-ink-850/80 px-4 py-3 backdrop-blur-xl">
        <button
          onClick={onBack}
          className="grid size-9 place-items-center rounded-xl text-mist-300 transition-transform duration-150 will-change-transform hover:bg-white/5 active:scale-95 md:hidden"
        >
          <ArrowLeft size={18} />
        </button>
        <Avatar name={title} id={peer?.id ?? chat.id} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-white">{title}</h2>
          <p className="flex items-center gap-1 truncate text-xs text-mist-400">
            {typingName ? (
              <span className="text-aqua-400">{typingName} печатает…</span>
            ) : (
              <>
                <ShieldCheck size={11} className="text-aqua-500" />
                {subtitle} · сквозное шифрование
              </>
            )}
          </p>
        </div>
      </header>

      {/* Список сообщений */}
      <div
        ref={containerRef}
        className="scroll-area relative flex-1 overflow-y-auto overscroll-contain"
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
                  own={m.sender_id === selfId}
                  showTail={!prev || prev.sender_id !== m.sender_id}
                  onDownload={(msg) => engine.downloadFile(msg)}
                />
              </div>
            )
          })}
        </div>

        {!messages.length && (
          <div className="anim-fade grid h-full place-items-center text-center text-mist-400">
            <div className="space-y-2">
              <ShieldCheck size={30} className="mx-auto text-aqua-500/60" />
              <p className="text-sm">Сообщений пока нет</p>
              <p className="text-xs opacity-70">Всё, что вы напишете, шифруется на устройстве</p>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="anim-fade flex items-center gap-2 bg-red-500/10 px-4 py-2 text-xs text-red-300">
          <AlertCircle size={13} />
          {error}
          <button onClick={() => setError(null)} className="ml-auto opacity-70 hover:opacity-100">
            скрыть
          </button>
        </div>
      )}

      {uploading !== null && (
        <div className="shimmer h-0.5 bg-brand-500/40" />
      )}

      {/* Поле ввода */}
      <div className="border-t border-white/5 bg-ink-850/80 px-3 py-3 backdrop-blur-xl">
        <div className="flex items-end gap-2">
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void attach(f)
              e.target.value = ''
            }}
          />
          <button
            onClick={() => fileInput.current?.click()}
            className="grid size-10 shrink-0 place-items-center rounded-xl text-mist-300 transition-transform duration-150 will-change-transform hover:bg-white/5 active:scale-95"
            title="Отправить файл (шифруется)"
          >
            <Paperclip size={18} />
          </button>

          <textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              engine.noteTyping(chat.id)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            rows={1}
            placeholder="Сообщение…"
            className="max-h-40 min-h-10 flex-1 resize-none rounded-xl bg-ink-800 px-3.5 py-2.5 text-[0.9375rem] placeholder:text-mist-400/60 focus:bg-ink-800"
            style={{ fieldSizing: 'content' } as React.CSSProperties}
          />

          <button
            onClick={() => void send()}
            disabled={!draft.trim()}
            className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand-600 to-brand-500 text-white shadow-lg shadow-brand-600/25 transition-transform duration-150 will-change-transform hover:scale-105 active:scale-95 disabled:opacity-35 disabled:hover:scale-100"
          >
            <Send size={17} />
          </button>
        </div>
      </div>
    </div>
  )
}

export function Avatar({ name, id, size = 40 }: { name: string; id: string; size?: number }) {
  // Цвет выводим из id: он стабилен между сессиями и не требует запроса.
  const hue = [...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 360
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
  return (
    <div
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: `linear-gradient(135deg, hsl(${hue} 70% 52%), hsl(${(hue + 55) % 360} 75% 44%))`,
      }}
    >
      {initials || '?'}
    </div>
  )
}