import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  Image as ImageIcon,
  Paperclip,
  Phone,
  Send,
  Settings2,
  ShieldCheck,
  Video,
} from 'lucide-react'
import { engine } from '@/lib/engine'
import { calls, rtcSupported } from '@/lib/rtc'
import { timed } from '@/lib/perf'
import type { Chat, DecryptedMessage, Profile } from '@/lib/types'
import { useVirtualList } from '@/hooks/useVirtualList'
import { MessageBubble } from './MessageBubble'
import { Avatar } from './Avatar'

interface Props {
  chat: Chat
  peer?: Profile
  members: Profile[]
  selfId: string
  onBack: () => void
  onOpenGroup: () => void
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
export function ChatView({ chat, peer, members, selfId, onBack, onOpenGroup }: Props) {
  const [messages, setMessages] = useState<DecryptedMessage[]>(() => engine.cachedMessages(chat.id))
  const [draft, setDraft] = useState('')
  const [typingUser, setTypingUser] = useState<string | null>(null)
  const [uploading, setUploading] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ url: string; type: string } | null>(null)
  /** Перерисовка реакций и отметок: данные живут в движке, здесь повод обновиться. */
  const [reactionsTick, setReactionsTick] = useState(0)
  const [receiptsTick, setReceiptsTick] = useState(0)
  const stickToBottom = useRef(true)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const imageInput = useRef<HTMLInputElement | null>(null)

  const { containerRef, virtual, total, measure, scrollToBottom, resetMetrics } =
    useVirtualList(messages)

  // Загрузка истории: замеряем, чтобы видеть реальную скорость на устройстве.
  useEffect(() => {
    let cancelled = false
    // Высоты строк другого чата не имеют отношения к этому — сбрасываем.
    resetMetrics()
    setMessages(engine.cachedMessages(chat.id))
    ;(async () => {
      try {
        const history = await timed('chat_history_load', () => engine.loadHistory(chat.id))
        if (cancelled) return
        setMessages([...history])
        void engine.markChatRead(chat.id)
        // Реакции и отметки грузим отдельно: без них история откроется быстрее.
        void engine.loadReactions(chat.id).then(() => setReactionsTick((t) => t + 1))
        void engine.loadReceipts(chat.id).then(() => setReceiptsTick((t) => t + 1))
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [chat.id, resetMetrics])

  // Слушаем входящие звонки, пока открыт этот чат.
  useEffect(() => {
    calls.listenForCalls(chat.id, selfId)
    return () => calls.stopListening()
  }, [chat.id, selfId])

  // Новые сообщения, правки, удаления, реакции и «печатает» из realtime.
  useEffect(() => {
    const off = engine.on((e) => {
      if (e.type === 'message' && e.chatId === chat.id) {
        setMessages((prev) => (prev.some((m) => m.id === e.message.id) ? prev : [...prev, e.message]))
        if (e.message.sender_id !== selfId) void engine.markChatRead(chat.id)
      } else if (e.type === 'typing' && e.chatId === chat.id) {
        setTypingUser(e.userId)
      } else if (e.type === 'deleted' && e.chatId === chat.id) {
        setMessages((prev) => prev.filter((m) => m.id !== e.messageId))
      } else if (e.type === 'edited' && e.chatId === chat.id) {
        setMessages((prev) => prev.map((m) => (m.id === e.message.id ? e.message : m)))
      } else if (e.type === 'reactions' && e.chatId === chat.id) {
        setReactionsTick((t) => t + 1)
      } else if (e.type === 'receipts' && e.chatId === chat.id) {
        setReceiptsTick((t) => t + 1)
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

  const onScrollStick = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140
  }, [containerRef])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('scroll', onScrollStick, { passive: true })
    return () => el.removeEventListener('scroll', onScrollStick)
  }, [containerRef, onScrollStick])

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    stickToBottom.current = true
    try {
      await timed('send_message', () => engine.sendText(chat.id, text))
    } catch (e) {
      setError((e as Error).message)
      setDraft(text) // возвращаем текст: терять написанное из-за сети нельзя
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

  /** Картинку показываем прямо в переписке, не заставляя скачивать файл. */
  const previewImage = async (m: DecryptedMessage) => {
    try {
      const blob = await engine.downloadFile(m)
      const url = URL.createObjectURL(blob)
      setPreview({ url, type: m.file_type ?? 'image/png' })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePreview()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview])

  const closePreview = () => {
    if (preview) URL.revokeObjectURL(preview.url)
    setPreview(null)
  }

  const title = chat.kind === 'group' ? (chat.title ?? 'Группа') : (peer?.display_name ?? 'Чат')
  const subtitle = chat.kind === 'group' ? `${members.length} участников` : '@' + (peer?.username ?? '')
  const peerOnline = peer ? engine.isOnline(peer.id) : false

  const typingName = useMemo(
    () =>
      typingUser ? (members.find((m) => m.id === typingUser)?.display_name ?? 'Кто-то') : null,
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
        <div className="relative">
          <Avatar name={title} id={peer?.id ?? chat.id} />
          {peerOnline && (
            <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-ink-850 bg-emerald-400" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-white">{title}</h2>
          <p className="flex items-center gap-1 truncate text-xs text-mist-400">
            {typingName ? (
              <span className="text-aqua-400">{typingName} печатает…</span>
            ) : (
              <>
                <ShieldCheck size={11} className="text-aqua-500" />
                {peerOnline && chat.kind === 'direct' ? 'в сети · ' : ''}
                {subtitle}
              </>
            )}
          </p>
        </div>

        {/* Звонки */}
        <button
          onClick={() => {
            void calls
              .startCall(chat.id, selfId, 'audio', title)
              .catch((e) => setError((e as Error).message))
          }}
          disabled={!rtcSupported()}
          title={rtcSupported() ? 'Голосовой звонок' : 'Звонки работают только по HTTPS'}
          className="grid size-9 place-items-center rounded-xl text-mist-300 transition-transform duration-150 hover:bg-white/5 active:scale-95 disabled:opacity-35"
        >
          <Phone size={17} />
        </button>
        <button
          onClick={() => {
            void calls
              .startCall(chat.id, selfId, 'video', title)
              .catch((e) => setError((e as Error).message))
          }}
          disabled={!rtcSupported()}
          title={rtcSupported() ? 'Видеозвонок' : 'Звонки работают только по HTTPS'}
          className="grid size-9 place-items-center rounded-xl text-mist-300 transition-transform duration-150 hover:bg-white/5 active:scale-95 disabled:opacity-35"
        >
          <Video size={17} />
        </button>
        {chat.kind === 'group' && (
          <button
            onClick={onOpenGroup}
            title="Участники и настройки группы"
            className="grid size-9 place-items-center rounded-xl text-mist-300 transition-transform duration-150 hover:bg-white/5 active:scale-95"
          >
            <Settings2 size={17} />
          </button>
        )}
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
                  delivered={!m.id.startsWith('local-')}
                  read={engine.isRead(m.id)}
                  myReaction={engine.reactionFor(m.id, selfId)}
                  reactions={engine.reactionsOf(m.id)}
                  actions={{
                    onDownload: async (msg) => {
                      const blob = await engine.downloadFile(msg)
                      if (msg.file_type?.startsWith('image/')) {
                        void previewImage(msg)
                      }
                      return blob
                    },
                    onDelete: (msg) => {
                      void engine
                        .deleteMessage(chat.id, msg.id)
                        .catch((e) => setError((e as Error).message))
                    },
                    onEdit: (msg, text) => {
                      void engine
                        .editMessage(chat.id, msg.id, text)
                        .catch((e) => setError((e as Error).message))
                    },
                    onReact: (msg, emoji) => {
                      void engine
                        .toggleReaction(chat.id, msg.id, emoji)
                        .catch((e) => setError((e as Error).message))
                    },
                  }}
                />
              </div>
            )
          })}
          {/* Тики нужны, чтобы перерисовка произошла при изменении реакций
              и отметок прочтения: сами данные живут в движке. */}
          <span style={{ display: 'none' }}>
            {reactionsTick}
            {receiptsTick}
          </span>
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
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="opacity-70 hover:opacity-100">
            скрыть
          </button>
        </div>
      )}

      {uploading !== null && <div className="shimmer h-0.5 bg-brand-500/40" />}

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
          <input
            ref={imageInput}
            type="file"
            accept="image/*"
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
          <button
            onClick={() => imageInput.current?.click()}
            className="grid size-10 shrink-0 place-items-center rounded-xl text-mist-300 transition-transform duration-150 will-change-transform hover:bg-white/5 active:scale-95"
            title="Отправить изображение (шифруется)"
          >
            <ImageIcon size={18} />
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

      {/* Просмотр изображения */}
      {preview && (
        <div
          className="anim-fade fixed inset-0 z-50 grid place-items-center bg-black/85 p-4"
          onClick={closePreview}
        >
          <img
            src={preview.url}
            alt=""
            className="anim-pop max-h-full max-w-full rounded-xl object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <p className="absolute bottom-5 text-xs text-mist-400">
            Расшифровано на вашем устройстве · нажмите, чтобы закрыть
          </p>
        </div>
      )}
    </div>
  )
}