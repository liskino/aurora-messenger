import { memo, useEffect, useMemo, useState } from 'react'
import { Loader2, MessageSquarePlus, Search, Settings, UsersRound, X } from 'lucide-react'
import { engine } from '@/lib/engine'
import { createGroup } from '@/lib/groups'
import * as api from '@/lib/api'
import type { Chat, DecryptedMessage, Profile } from '@/lib/types'
import { Avatar } from './Avatar'

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
}: Props) {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<Profile[]>([])
  const [creating, setCreating] = useState<string | null>(null)
  /** Выбранные для группы — до нажатия «создать». */
  const [groupPick, setGroupPick] = useState<Profile[]>([])
  const [groupMode, setGroupMode] = useState(false)
  const [groupTitle, setGroupTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [unreadTick, setUnreadTick] = useState(0)

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([])
      return
    }
    let cancelled = false
    setSearching(true)
    // Дебаунс: не бьём по базе на каждую букву.
    const t = setTimeout(async () => {
      try {
        const found = await api.searchProfiles(query, selfId)
        if (!cancelled) setResults(found)
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 260)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, selfId])

  // Счётчики непрочитанных обновляем по событиям, а не по таймеру.
  useEffect(() => {
    const off = engine.on((e) => {
      if (e.type === 'message' || e.type === 'receipts') setUnreadTick((t) => t + 1)
    })
    return () => {
      off()
    }
  }, [])

  const sorted = useMemo(() => {
    return [...chats].sort((a, b) => {
      const la = lastMessage.get(a.id)?.created_at ?? a.created_at
      const lb = lastMessage.get(b.id)?.created_at ?? b.created_at
      return lb.localeCompare(la)
    })
  }, [chats, lastMessage])

  const startChat = async (peer: Profile) => {
    setCreating(peer.id)
    setError(null)
    try {
      const chat = await engine.startDirectChat(peer)
      onCreated(chat, peer)
      setQuery('')
      setResults([])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCreating(null)
    }
  }

  const createNewGroup = async () => {
    if (groupPick.length < 2) {
      setError('Выберите хотя бы двух участников')
      return
    }
    setCreating('group')
    setError(null)
    try {
      const chat = await createGroup(groupPick, groupTitle.trim() || 'Группа')
      onCreated(chat, undefined)
      setGroupMode(false)
      setGroupPick([])
      setGroupTitle('')
      setQuery('')
      setResults([])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCreating(null)
    }
  }

  const togglePick = (p: Profile) => {
    setGroupPick((prev) =>
      prev.some((x) => x.id === p.id) ? prev.filter((x) => x.id !== p.id) : [...prev, p],
    )
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
            placeholder={groupMode ? 'Добавьте людей в группу…' : 'Поиск людей по логину…'}
            className="w-full bg-transparent text-sm outline-none placeholder:text-mist-400/60"
          />
          {(query || groupMode) && (
            <button
              onClick={() => {
                setQuery('')
                setResults([])
                setGroupMode(false)
                setGroupPick([])
                setError(null)
              }}
              className="text-mist-400 hover:text-white"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {!groupMode && (
          <button
            onClick={() => setGroupMode(true)}
            className="mt-2 flex w-full items-center gap-2 rounded-xl bg-ink-800/60 px-3 py-2 text-xs text-mist-300 transition-transform hover:scale-[1.01] active:scale-[0.99]"
          >
            <UsersRound size={14} className="text-brand-400" />
            Создать группу
          </button>
        )}

        {groupMode && (
          <div className="anim-fade mt-2 rounded-xl border border-brand-500/25 bg-brand-500/5 p-2">
            <input
              value={groupTitle}
              onChange={(e) => setGroupTitle(e.target.value)}
              placeholder="Название группы"
              maxLength={60}
              className="mb-2 w-full rounded-lg bg-ink-800 px-2.5 py-2 text-sm outline-none placeholder:text-mist-400/60"
            />
            {groupPick.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1">
                {groupPick.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => togglePick(p)}
                    className="flex items-center gap-1 rounded-full bg-brand-500/20 px-2 py-0.5 text-xs text-brand-400"
                    title="Убрать"
                  >
                    {p.display_name || p.username}
                    <X size={10} />
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => void createNewGroup()}
              disabled={groupPick.length < 2 || creating === 'group'}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 py-2 text-xs font-medium text-white transition-transform hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40"
            >
              {creating === 'group' && <Loader2 size={12} className="anim-spin" />}
              Создать группу · {groupPick.length}/2
            </button>
            <p className="mt-1.5 text-[0.625rem] leading-relaxed text-mist-400">
              Ключ шифрования группы будет выдан каждому участнику отдельно.
            </p>
          </div>
        )}
      </div>

      <div className="scroll-area flex-1 overflow-y-auto px-2 pb-3">
        {results.length > 0 && (
          <div className="anim-fade mb-2 rounded-xl border border-brand-500/20 bg-brand-500/5 p-1.5">
            <p className="px-2 py-1 text-[0.6875rem] uppercase tracking-wide text-mist-400">
              {groupMode ? 'Нажмите, чтобы добавить' : 'Найденные пользователи'}
            </p>
            {results.map((p) => {
              const picked = groupPick.some((x) => x.id === p.id)
              return (
                <button
                  key={p.id}
                  onClick={() => (groupMode ? togglePick(p) : void startChat(p))}
                  disabled={creating === p.id}
                  className={`row flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-white/5 disabled:opacity-50 ${
                    picked ? 'bg-brand-500/15 ring-1 ring-brand-500/30' : ''
                  }`}
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
              )
            })}
          </div>
        )}

        {error && (
          <p className="anim-fade mb-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
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

        {!loading && !sorted.length && !results.length && !groupMode && (
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
            unread={chat.id === activeId ? 0 : engine.unreadCount(chat.id)}
            online={peers.get(chat.id) ? engine.isOnline(peers.get(chat.id)!.id) : false}
            onSelect={onSelect}
            tick={unreadTick}
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
  unread,
  online,
  onSelect,
}: {
  chat: Chat
  peer?: Profile
  last?: DecryptedMessage
  active: boolean
  unread: number
  online: boolean
  onSelect: (chat: Chat, peer: Profile | undefined) => void
  tick: number
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
      <Avatar name={title} id={peer?.id ?? chat.id} size={40} online={online} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white">{title}</p>
        <p
          className={`truncate text-xs ${
            unread > 0 ? 'font-medium text-mist-200' : 'text-mist-400'
          }`}
        >
          {preview}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {last && (
          <span className="text-[0.6875rem] text-mist-400">
            {new Date(last.created_at).toLocaleTimeString('ru-RU', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        )}
        {unread > 0 && (
          <span className="anim-pop grid min-w-5 place-items-center rounded-full bg-brand-500 px-1.5 text-[0.6875rem] font-semibold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </div>
    </button>
  )
})