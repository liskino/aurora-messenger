import { memo, useEffect, useRef, useState } from 'react'
import { Check, CheckCheck, Copy, Download, FileText, Lock, Pencil, ShieldAlert, Trash2 } from 'lucide-react'
import type { DecryptedMessage } from '@/lib/types'

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function formatSize(bytes: number | null) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

const QUICK_REACTIONS = ['👍', '❤️', '😂', '🔥', '😮', '🙏']

export interface MessageActions {
  onDownload: (m: DecryptedMessage) => Promise<Blob>
  onDelete: (m: DecryptedMessage) => void
  onEdit: (m: DecryptedMessage, text: string) => void
  onReact: (m: DecryptedMessage, emoji: string) => void
}

interface Props {
  message: DecryptedMessage
  own: boolean
  showTail: boolean
  /** Статус доставки: undefined — сообщение ещё не отправлено на сервер. */
  delivered?: boolean
  read?: boolean
  /** Моя реакция на это сообщение. */
  myReaction?: string
  reactions: { emoji: string; count: number }[]
  actions: MessageActions
}

/**
 * Пузырь сообщения.
 *
 * memo здесь не оптимизация ради галочки: без него каждое новое сообщение
 * перерисовывает весь видимый список, и прокрутка заметно дёргается.
 * Сравнение по ссылке работает, потому что объекты сообщений в кэше движка
 * не пересоздаются.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  own,
  showTail,
  delivered,
  read,
  myReaction,
  reactions,
  actions,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.text)
  const [copied, setCopied] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Закрытие по клику вне меню и по Esc — без этого меню «залипает».
  useEffect(() => {
    if (!menuOpen) return
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  if (message.failed) {
    return (
      <div className={`flex ${own ? 'justify-end' : 'justify-start'} px-4`}>
        <div className="anim-fade flex items-center gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-sm text-amber-200/90">
          <ShieldAlert size={15} className="shrink-0" />
          Сообщение не расшифровано на этом устройстве
        </div>
      </div>
    )
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* буфер обмена может быть недоступен без разрешения */
    }
  }

  return (
    <div
      className={`bubble flex ${own ? 'justify-end' : 'justify-start'} px-4 ${
        showTail ? 'anim-pop' : ''
      }`}
    >
      <div className="relative max-w-[min(78%,42rem)]">
        <div
          onContextMenu={(e) => {
            e.preventDefault()
            setMenuOpen((v) => !v)
          }}
          onDoubleClick={() => actions.onReact(message, '❤️')}
          className={`rounded-2xl px-3.5 py-2.5 text-[0.9375rem] leading-relaxed shadow-lg shadow-black/20 ${
            own
              ? 'bg-gradient-to-br from-brand-600 to-brand-500 text-white'
              : 'bg-ink-800 text-mist-200 ring-1 ring-white/5'
          }`}
        >
          {editing ? (
            <div className="min-w-[14rem]">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoFocus
                rows={2}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    actions.onEdit(message, draft)
                    setEditing(false)
                  }
                  if (e.key === 'Escape') {
                    setDraft(message.text)
                    setEditing(false)
                  }
                }}
                className="w-full resize-none rounded-lg bg-black/20 px-2 py-1.5 text-sm outline-none"
              />
              <div className="mt-1.5 flex justify-end gap-2 text-xs">
                <button
                  onClick={() => {
                    setDraft(message.text)
                    setEditing(false)
                  }}
                  className="opacity-75 hover:opacity-100"
                >
                  отмена
                </button>
                <button
                  onClick={() => {
                    actions.onEdit(message, draft)
                    setEditing(false)
                  }}
                  className="font-medium underline"
                >
                  сохранить
                </button>
              </div>
            </div>
          ) : message.kind === 'file' ? (
            <FileCard message={message} own={own} onDownload={actions.onDownload} />
          ) : (
            <p className="whitespace-pre-wrap break-words">{message.text}</p>
          )}

          <div
            className={`mt-1 flex items-center justify-end gap-1 text-[0.6875rem] ${
              own ? 'text-white/65' : 'text-mist-400'
            }`}
          >
            {message.edited_at && <span className="italic">изменено</span>}
            <span>{formatTime(message.created_at)}</span>
            {/* Две галочки = прочитано, одна = доставлено. */}
            {own &&
              (read ? (
                <CheckCheck size={13} className="text-aqua-400" />
              ) : (
                <Check size={12} className={delivered ? 'opacity-90' : 'opacity-50'} />
              ))}
          </div>
        </div>

        {/* Реакции: показываются под пузырём, не сдвигая соседей при появлении */}
        {reactions.length > 0 && (
          <div className={`anim-fade mt-1 flex gap-1 ${own ? 'justify-end' : 'justify-start'}`}>
            {reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => actions.onReact(message, r.emoji)}
                className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-transform hover:scale-110 active:scale-95 ${
                  r.emoji === myReaction
                    ? 'bg-brand-500/25 ring-1 ring-brand-500/40'
                    : 'bg-ink-800 ring-1 ring-white/8'
                }`}
              >
                <span>{r.emoji}</span>
                {r.count > 1 && <span className="text-mist-300">{r.count}</span>}
              </button>
            ))}
          </div>
        )}

        {/* Меню действий */}
        {menuOpen && (
          <div
            ref={menuRef}
            className={`anim-pop absolute z-30 mt-1 w-52 rounded-xl border border-white/10 bg-ink-800 p-1.5 shadow-2xl ${
              own ? 'right-0' : 'left-0'
            }`}
          >
            <div className={`mb-1 flex justify-between px-1 ${own ? '' : ''}`}>
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => {
                    actions.onReact(message, emoji)
                    setMenuOpen(false)
                  }}
                  className="grid size-7 place-items-center rounded-lg text-base transition-transform hover:scale-125 active:scale-95"
                >
                  {emoji}
                </button>
              ))}
            </div>

            <MenuItem
              icon={<Copy size={13} />}
              label={copied ? 'Скопировано' : 'Копировать текст'}
              onClick={() => {
                void copy()
                setMenuOpen(false)
              }}
            />
            {own && message.kind === 'text' && (
              <MenuItem
                icon={<Pencil size={13} />}
                label="Изменить"
                onClick={() => {
                  setEditing(true)
                  setMenuOpen(false)
                }}
              />
            )}
            {own && (
              <MenuItem
                icon={<Trash2 size={13} />}
                label="Удалить"
                danger
                onClick={() => {
                  actions.onDelete(message)
                  setMenuOpen(false)
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
})

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
        danger ? 'text-red-300 hover:bg-red-500/10' : 'text-mist-200 hover:bg-white/5'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

function FileCard({
  message,
  own,
  onDownload,
}: {
  message: DecryptedMessage
  own: boolean
  onDownload: (m: DecryptedMessage) => Promise<Blob>
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const urlRef = useRef<string | null>(null)

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    },
    [],
  )

  const handle = async () => {
    setState('busy')
    try {
      const blob = await onDownload(message)
      const url = URL.createObjectURL(blob)
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      urlRef.current = url
      const a = document.createElement('a')
      a.href = url
      a.download = message.fileName ?? 'file'
      a.click()
      setState('done')
    } catch {
      setState('error')
    }
  }

  const isImage = message.file_type?.startsWith('image/')

  return (
    <div className="flex min-w-[13rem] items-center gap-3">
      <div
        className={`grid size-10 shrink-0 place-items-center rounded-xl ${
          own ? 'bg-white/15' : 'bg-ink-700'
        }`}
      >
        <FileText size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {message.fileName ?? 'зашифрованный файл'}
        </p>
        <p className={`text-xs ${own ? 'text-white/60' : 'text-mist-400'}`}>
          {isImage ? 'изображение' : 'файл'} · {formatSize(message.file_size)} ·{' '}
          <Lock size={9} className="inline" /> зашифрован
        </p>
      </div>
      <button
        onClick={handle}
        disabled={state === 'busy'}
        className={`grid size-8 shrink-0 place-items-center rounded-lg transition-transform duration-150 will-change-transform hover:scale-105 active:scale-95 disabled:opacity-50 ${
          own ? 'bg-white/15' : 'bg-ink-700'
        }`}
        title="Расшифровать и скачать"
      >
        <Download size={14} className={state === 'busy' ? 'anim-spin' : ''} />
      </button>
    </div>
  )
}