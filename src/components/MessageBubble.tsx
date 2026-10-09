import { memo, useEffect, useRef, useState } from 'react'
import { Check, Download, FileText, Lock, ShieldAlert } from 'lucide-react'
import type { DecryptedMessage } from '@/lib/types'

function formatTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function formatSize(bytes: number | null) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

interface Props {
  message: DecryptedMessage
  own: boolean
  showTail: boolean
  /** Возвращает уже расшифрованный на устройстве файл. */
  onDownload: (m: DecryptedMessage) => Promise<Blob>
}

/**
 * Пузырь сообщения.
 *
 * memo здесь не оптимизация ради галочки: без него каждое новое сообщение
 * перерисовывает весь видимый список, и на 200 сообщениях прокрутка заметно
 * дёргается. Сравнение по ссылке на объект работает, потому что в кэше
 * движка объекты сообщений не пересоздаются.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  own,
  showTail,
  onDownload,
}: Props) {
  const isFile = message.kind === 'file'

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

  return (
    <div
      className={`bubble flex ${own ? 'justify-end' : 'justify-start'} px-4 ${
        showTail ? 'anim-pop' : ''
      }`}
    >
      <div
        className={`relative max-w-[min(78%,42rem)] rounded-2xl px-3.5 py-2.5 text-[0.9375rem] leading-relaxed shadow-lg shadow-black/20 ${
          own
            ? 'bg-gradient-to-br from-brand-600 to-brand-500 text-white'
            : 'bg-ink-800 text-mist-200 ring-1 ring-white/5'
        }`}
      >
        {isFile ? (
          <FileCard message={message} own={own} onDownload={onDownload} />
        ) : (
          <p className="whitespace-pre-wrap break-words">{message.text}</p>
        )}

        <div
          className={`mt-1 flex items-center justify-end gap-1 text-[0.6875rem] ${
            own ? 'text-white/65' : 'text-mist-400'
          }`}
        >
          <span>{formatTime(message.created_at)}</span>
          {own && <Check size={12} className="opacity-80" />}
        </div>
      </div>
    </div>
  )
})

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
        <p className="truncate text-sm font-medium">{message.fileName ?? 'зашифрованный файл'}</p>
        <p className={`text-xs ${own ? 'text-white/60' : 'text-mist-400'}`}>
          {formatSize(message.file_size)} · <Lock size={9} className="inline" /> зашифрован
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