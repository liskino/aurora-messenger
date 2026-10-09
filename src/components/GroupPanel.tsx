import { useEffect, useState } from 'react'
import { Crown, Loader2, LogOut, Search, UserMinus, UserPlus, X } from 'lucide-react'
import * as api from '@/lib/api'
import {
  addGroupMember,
  leaveGroup,
  listGroupMembers,
  removeGroupMember,
  renameGroup,
  type GroupMemberView,
} from '@/lib/groups'
import { engine } from '@/lib/engine'
import type { Chat, Profile } from '@/lib/types'
import { Avatar } from './Avatar'

interface Props {
  chat: Chat
  selfId: string
  onClose: () => void
  onLeft: () => void
}

/**
 * Панель группы: состав, приглашение, переименование, выход.
 *
 * Приглашать может любой участник, у кого развёрнут ключ чата — это ровно те,
 * кто уже читает переписку. Ограничение не административное, а техническое:
 * без ключа выдать его новому участнику невозможно.
 */
export function GroupPanel({ chat, selfId, onClose, onLeft }: Props) {
  const [members, setMembers] = useState<GroupMemberView[]>([])
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState(chat.title ?? '')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Profile[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const reload = async () => {
    setMembers(await listGroupMembers(chat.id))
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const list = await listGroupMembers(chat.id)
        if (!cancelled) setMembers(list)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [chat.id])

  // Поиск людей: исключаем тех, кто уже в группе — иначе непонятно, почему
  // повторное добавление ничего не меняет.
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([])
      return
    }
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const found = await api.searchProfiles(query, selfId)
        const existing = new Set(members.map((m) => m.profile.id))
        if (!cancelled) setResults(found.filter((p) => !existing.has(p.id)))
      } catch {
        if (!cancelled) setResults([])
      }
    }, 260)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, selfId, members])

  const invite = async (profile: Profile) => {
    setBusy(profile.id)
    setError(null)
    try {
      await addGroupMember(chat.id, profile)
      await reload()
      setNotice(`${profile.display_name || profile.username} добавлен в группу`)
      setQuery('')
      setResults([])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const kick = async (userId: string) => {
    setBusy(userId)
    try {
      await removeGroupMember(chat.id, userId)
      await reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  /**
   * Удалённый участник должен перестать получать новые сообщения.
   * Ключ чата у него остаётся, поэтому честно предупреждаем: это исключение
   * из переписки, а не отзыв уже полученной истории.
   */
  const confirmKick = (m: GroupMemberView) => {
    const name = m.profile.display_name || m.profile.username
    setNotice(
      `${name} больше не будет получать сообщения группы. Ранее полученную переписку он сохранит — ключ уже у него.`,
    )
    void kick(m.profile.id)
  }

  const amCreator = members.find((m) => m.isSelf)?.isCreator ?? false

  return (
    <div className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="anim-pop max-h-[86vh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/8 bg-ink-850 p-5 shadow-2xl">
        <div className="mb-5 flex items-center gap-2">
          <h2 className="flex-1 font-semibold text-white">Группа</h2>
          <button
            onClick={onClose}
            className="grid size-8 place-items-center rounded-lg text-mist-300 hover:bg-white/5 active:scale-95"
          >
            <X size={17} />
          </button>
        </div>

        {/* Название */}
        <div className="mb-5">
          <label className="mb-1.5 block text-xs uppercase tracking-wide text-mist-400">
            Название
          </label>
          <div className="flex gap-2">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={60}
              className="flex-1 rounded-xl bg-ink-800 px-3 py-2.5 text-sm outline-none"
            />
            <button
              onClick={async () => {
                setError(null)
                try {
                  await renameGroup(chat.id, title)
                  setNotice('Название изменено')
                } catch (e) {
                  setError((e as Error).message)
                }
              }}
              disabled={title === chat.title}
              className="rounded-xl bg-brand-500 px-3.5 py-2.5 text-sm font-medium text-white transition-transform hover:scale-[1.03] active:scale-[0.97] disabled:opacity-40"
            >
              Сохранить
            </button>
          </div>
        </div>

        {/* Приглашение */}
        <div className="mb-5">
          <label className="mb-1.5 block text-xs uppercase tracking-wide text-mist-400">
            Пригласить
          </label>
          <div className="flex items-center gap-2 rounded-xl bg-ink-800 px-3 py-2.5">
            <Search size={15} className="text-mist-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="поиск по логину…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-mist-400/60"
            />
          </div>

          {results.map((p) => (
            <button
              key={p.id}
              onClick={() => void invite(p)}
              disabled={busy === p.id}
              className="row mt-1.5 flex w-full items-center gap-3 rounded-xl bg-ink-800 px-3 py-2.5 text-left transition-transform hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50"
            >
              <Avatar name={p.display_name || p.username} id={p.id} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-white">{p.display_name || p.username}</p>
                <p className="truncate text-xs text-mist-400">@{p.username}</p>
              </div>
              {busy === p.id ? (
                <Loader2 size={15} className="anim-spin text-brand-400" />
              ) : (
                <UserPlus size={16} className="text-brand-400" />
              )}
            </button>
          ))}
        </div>

        {/* Состав */}
        <div className="mb-5">
          <label className="mb-1.5 block text-xs uppercase tracking-wide text-mist-400">
            Участники · {members.length}
          </label>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-mist-400">
              <Loader2 size={14} className="anim-spin" /> Загрузка…
            </div>
          ) : (
            <ul className="space-y-1.5">
              {members.map((m) => (
                <li
                  key={m.profile.id}
                  className="row flex items-center gap-3 rounded-xl bg-ink-800 px-3 py-2.5"
                >
                  <Avatar
                    name={m.profile.display_name || m.profile.username}
                    id={m.profile.id}
                    size={32}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-sm text-white">
                      {m.profile.display_name || m.profile.username}
                      {m.isCreator && <Crown size={11} className="shrink-0 text-amber-400" />}
                      {engine.isOnline(m.profile.id) && (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-emerald-400"
                          title="в сети"
                        />
                      )}
                    </p>
                    <p className="truncate text-xs text-mist-400">
                      @{m.profile.username}
                      {m.isSelf && ' · это вы'}
                    </p>
                  </div>

                  {/* Себя не выкидывают кнопкой — для этого есть «выйти».
                      Создателя не удаляем: без него группа останется без ключа. */}
                  {!m.isSelf && !m.isCreator && (
                    <button
                      onClick={() => confirmKick(m)}
                      disabled={busy === m.profile.id}
                      title="Исключить из группы"
                      className="grid size-8 place-items-center rounded-lg text-mist-400 transition-transform hover:bg-red-500/10 hover:text-red-300 active:scale-95 disabled:opacity-40"
                    >
                      {busy === m.profile.id ? (
                        <Loader2 size={13} className="anim-spin" />
                      ) : (
                        <UserMinus size={14} />
                      )}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {notice && (
          <p className="anim-fade mb-3 rounded-xl bg-aqua-500/10 px-3 py-2 text-xs leading-relaxed text-aqua-400">
            {notice}
          </p>
        )}
        {error && (
          <p className="anim-fade mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        <button
          onClick={async () => {
            try {
              await leaveGroup(chat.id)
              await engine.session?.chatKeys.delete(chat.id)
              onLeft()
            } catch (e) {
              setError((e as Error).message)
            }
          }}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-red-500/10 py-2.5 text-sm font-medium text-red-300 transition-transform hover:bg-red-500/15 active:scale-[0.99]"
        >
          <LogOut size={15} /> Выйти из группы
        </button>

        <p className="mt-3 text-[0.6875rem] leading-relaxed text-mist-400">
          Исключённый участник перестанет получать новые сообщения. Уже полученную переписку он
          сохранит — ключ чата к нему уже попал, и отозвать его задним числом невозможно без
          смены ключа для всех.
        </p>
        {amCreator && (
          <p className="mt-2 text-[0.6875rem] text-mist-400">
            Вы создатель группы — только у вас есть ключ, чтобы приглашать новых участников.
          </p>
        )}
      </div>
    </div>
  )
}