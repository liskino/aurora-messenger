import { memo, useEffect, useMemo, useState } from 'react'
import { Loader2, MessageSquarePlus, Search, Settings, X } from 'lucide-react'
import { engine } from '@/lib/engine'
import * as api from '@/lib/api'
import type { Chat, DecryptedMessage, Profile } from '@/lib/types'
import { Avatar } from './ChatView'

interface Props {
  selfId: string
  selfName: string
  chats: Chat[]
  peers: Map<string, Profile>
  lastMessage: Map<string, DecryptedMessage>
  activeId?: string
  loading: boolean
  onSelect: (chat: Chat, peer: Profile | undefined) => void
  onCreated: (chat: Chat, peer: Profile | undefined) => void
  onOpenSettings: () => void
  onClose?: () => void
}

/**
 * Список чатов.
 *
 * Каждый ряд — мемоизированный компонент: приход нового сообщения обновляет
 * одну строку, а не всю колонку. Это заметно и на 100 чатах, и на слабом CPU.
 */
export function Sidebar({
  selfId,
  selfName,
  chats,
  peers,
  lastMessage,
  activeId,
  loading,
  onSelect,
  onCreated,
  onOpenSettings,
  onClose,
}: Props) {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<Profile[]>([])
  const [creating, setCreating] = useState<string | null>(null)

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([])
      return
    }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const found = await api.searchProfiles(query, selfId)
        if (!cancelled) setResults(found)
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 260) // дебаунс: не бьём по базе на каждую букву
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, selfId])

  const sorted = useMemo(() => {
    return [...chats].sort((a, b) => {
      const la = lastMessage.get(a.id)?.created_at ?? a.created_at
      const lb = lastMessage.get(b.id)?.created_at ?? b.created_at
      return lb.localeCompare(la)
    })
  }, [chats, lastMessage])

  const startChat = async (peer: Profile) => {
    setCreating(peer.id)
    try {
      const chat = await engine.startDirectChat(peer)
      onCreated(chat, peer)
      setQuery('')
      setResults([])
    } finally {
      setCreating(null)
    }
  }

  return (
    <aside className="flex h-full w-full min-w-0 flex-col border-r border-white/5 bg-ink-850 md:w-[21rem]">
      <header className="flex items-center gap-2 px-4 py-3.5">
        <Avatar name={selfName} id={selfId} size={34} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{selfName}</p>
          <p className="text-[0.6875rem] text-aqua-400">защищено сквозным шифрованием</p>
        </div>
        <button
          onClick={onOpenSettings}
          className="grid size-9 place-items-center rounded-xl text-mist-300 transition-transform duration-150 will-change-transform hover:bg-white/5 active:scale-95"
          title="Настройки и устройства"
        >
          <Settings size={17} />
        </button>
        {onClose && (
          <button
            onClick={onClose}
            className="grid size-9 place-items-center rounded-xl text-mist-300 transition-transform duration-150 hover:bg-white/5 active:scale-95 md:hidden"
          >
            <X size={17} />
          </button>
        )}
      </header>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-xl bg-ink-800 px-3 py-2 ring-1 ring-transparent transition-colors duration-150 focus-within:ring-brand-500/60">
          {searching ? (
            <Loader2 size={15} className="anim-spin text-mist-400" />
          ) : (
            <Search size={15} className="text-mist-400" />
          )}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск людей по логину…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-mist-400/60"
          />
        </div>
      </div>

      <div className="scroll-area flex-1 overflow-y-auto px-2 pb-3">
        {results.length > 0 && (
          <div className="anim-fade mb-2 rounded-xl border border-brand-500/20 bg-brand-500/5 p-1.5">
            <p className="px-2 py-1 text-[0.6875rem] uppercase tracking-wide text-mist-400">
              Найденные пользователи
            </p>
            {results.map((p) => (
              <button
                key={p.id}
                onClick={() => void startChat(p)}
                disabled={creating === p.id}
                className="row flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-white/5 disabled:opacity-50"
              >
                <Avatar name={p.display_name || p.username} id={p.id} size={34} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-white">{p.display_name || p.username}</p>
                  <p className="truncate text-xs text-mist-400">@{p.username}</p>
                </div>
                {creating === p.id ? (
                  <Loader2 size={15} className="anim-spin text-brand-400" />
                ) : (
                  <MessageSquarePlus size={16} className="text-brand-400" />
                )}
              </button>
            ))}
          </div>
        )}

        {loading && (
          <div className="space-y-1 p-1">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="shimmer flex items-center gap-3 rounded-xl px-2 py-3">
                <div className="size-9 shrink-0 rounded-full bg-ink-700" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-1/3 rounded bg-ink-700" />
                  <div className="h-2.5 w-2/3 rounded bg-ink-700/70" />
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && !sorted.length && !results.length && (
          <div className="anim-fade px-4 py-10 text-center text-sm text-mist-400">
            <Search size={22} className="mx-auto mb-3 opacity-50" />
            Найдите человека по логину и начните переписку
          </div>
        )}

        {sorted.map((chat) => (
          <ChatRow
            key={chat.id}
            chat={chat}
            peer={peers.get(chat.id)}
            last={lastMessage.get(chat.id)}
            active={chat.id === activeId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </aside>
  )
}

const ChatRow = memo(function ChatRow({
  chat,
  peer,
  last,
  active,
  onSelect,
}: {
  chat: Chat
  peer?: Profile
  last?: DecryptedMessage
  active: boolean
  onSelect: (chat: Chat, peer: Profile | undefined) => void
}) {
  const title = chat.kind === 'group' ? (chat.title ?? 'Группа') : (peer?.display_name ?? 'Чат')
  const preview = last
    ? last.kind === 'file'
      ? `📎 ${last.fileName ?? 'файл'}`
      : last.text
    : 'Нет сообщений'

  return (
    <button
      onClick={() => onSelect(chat, peer)}
      className={`row flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-transform duration-150 will-change-transform hover:bg-white/5 active:scale-[0.99] ${
        active ? 'bg-white/[0.07] ring-1 ring-brand-500/25' : ''
      }`}
    >
      <Avatar name={title} id={peer?.id ?? chat.id} size={40} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white">{title}</p>
        <p className="truncate text-xs text-mist-400">{preview}</p>
      </div>
      {last && (
        <span className="shrink-0 text-[0.6875rem] text-mist-400">
          {new Date(last.created_at).toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      )}
    </button>
  )
})