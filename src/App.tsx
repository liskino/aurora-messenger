import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, MessageSquare, ShieldCheck } from 'lucide-react'
import { engine, type EngineSession } from '@/lib/engine'
import { isConfigured } from '@/lib/api'
import { calls } from '@/lib/rtc'
import {
  isWindowActive,
  notifyMessage,
  playTone,
  requestNotificationPermission,
  resetTitle,
  setUnreadTitle,
  unlockAudio,
} from '@/lib/notify'
import { useChats } from '@/hooks/useChats'
import { useRefreshProfile } from '@/hooks/useRefreshProfile'
import { AuthView } from '@/components/AuthView'
import { ChatView } from '@/components/ChatView'
import { Sidebar } from '@/components/Sidebar'
import { SettingsPanel } from '@/components/SettingsPanel'
import { GroupPanel } from '@/components/GroupPanel'
import { CallOverlay } from '@/components/CallOverlay'
import { ConnectionWarning } from '@/components/ConnectionWarning'
import type { Chat, Profile } from '@/lib/types'

type Phase = 'booting' | 'auth' | 'ready'

export default function App() {
  const [phase, setPhase] = useState<Phase>('booting')
  const [session, setSession] = useState<EngineSession | null>(null)
  const [activeChat, setActiveChat] = useState<Chat | null>(null)
  const [activePeer, setActivePeer] = useState<Profile | undefined>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false)
  const [callOpen, setCallOpen] = useState(false)
  const [mobilePane, setMobilePane] = useState<'list' | 'chat'>('list')
  const perf = useRefreshProfile()

  const activeChatRef = useRef<Chat | null>(null)
  activeChatRef.current = activeChat

  const { chats, peers, members, lastMessage, loading, addChat } = useChats(
    phase === 'ready',
    session?.userId,
  )

  // Автовход: сессия Supabase жива и устройство запомнено → пароль не нужен.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!isConfigured) {
        setPhase('auth')
        return
      }
      try {
        const s = await engine.resume()
        if (cancelled) return
        if (s) {
          setSession(s)
          setPhase('ready')
        } else {
          setPhase('auth')
        }
      } catch {
        if (!cancelled) setPhase('auth')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Звонок начался или пришёл — открываем экран звонка.
  useEffect(() => {
    const off = calls.on((e) => {
      if (e.type === 'state' && e.state !== 'idle' && e.state !== 'ended') setCallOpen(true)
      if (e.type === 'incoming') {
        playTone('call')
        setCallOpen(true)
      }
    })
    return off
  }, [])

  /**
   * Уведомления и звук.
   *
   * Правило простое: сигналим только о том, чего человек не видит. Если окно
   * активно и открыт именно этот чат — ни звука, ни всплывающего окна, ни
   * счётчика: сообщение уже перед глазами.
   */
  useEffect(() => {
    if (phase !== 'ready') return

    const off = engine.on((e) => {
      if (e.type !== 'message') return
      if (e.message.sender_id === session?.userId) return

      const chatId = e.chatId
      const isOpen = activeChatRef.current?.id === chatId && isWindowActive()
      if (isOpen) return

      playTone('message')

      const title = chats.find((c) => c.id === chatId)?.title ?? peers.get(chatId)?.display_name
      notifyMessage({
        title: title ?? 'Новое сообщение',
        body: e.message.kind === 'file' ? '📎 Прислан файл' : e.message.text.slice(0, 120),
        active: false,
        tag: chatId,
        onClick: () => {
          const chat = chats.find((c) => c.id === chatId)
          if (chat) {
            setActiveChat(chat)
            setActivePeer(peers.get(chatId))
            setMobilePane('chat')
          }
        },
      })

      // Счётчик в заголовке вкладки: (3) Aurora — ...
      const total = chats.reduce((sum, c) => sum + engine.unreadCount(c.id), 0)
      setUnreadTitle(total + 1)
    })
    return off
  }, [phase, session?.userId, chats, peers])

  // Сбрасываем заголовок, когда окно снова стало активным.
  useEffect(() => {
    const onFocus = () => {
      if (isWindowActive()) resetTitle()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [])

  // Звук в браузере разрешён только после действия пользователя —
  // используем первое касание, чтобы сигнал работал сразу.
  useEffect(() => {
    const once = () => {
      unlockAudio()
      if (phase === 'ready') void requestNotificationPermission()
      window.removeEventListener('pointerdown', once)
      window.removeEventListener('keydown', once)
    }
    window.addEventListener('pointerdown', once)
    window.addEventListener('keydown', once)
    return () => {
      window.removeEventListener('pointerdown', once)
      window.removeEventListener('keydown', once)
    }
  }, [phase])

  const onAuthed = useCallback(() => {
    setSession(engine.session)
    setPhase('ready')
  }, [])

  const logout = useCallback(async () => {
    setSettingsOpen(false)
    await calls.hangup()
    await engine.logout()
    setSession(null)
    setActiveChat(null)
    setActivePeer(undefined)
    resetTitle()
    setPhase('auth')
  }, [])

  const selectChat = useCallback((chat: Chat, peer: Profile | undefined) => {
    setActiveChat(chat)
    setActivePeer(peer)
    setMobilePane('chat')
    resetTitle()
  }, [])

  const onCreated = useCallback(
    (chat: Chat, peer: Profile | undefined) => {
      addChat(chat, peer)
      setActiveChat(chat)
      setActivePeer(peer)
      setMobilePane('chat')
    },
    [addChat],
  )

  if (phase === 'booting') {
    return (
      <div className="grid h-full place-items-center">
        <div className="anim-fade flex flex-col items-center gap-3 text-mist-400">
          <Loader2 size={22} className="anim-spin text-brand-400" />
          <p className="text-sm">Расшифровка устройства…</p>
        </div>
      </div>
    )
  }

  if (phase === 'auth') {
    return (
      <>
        {!isConfigured && <ConnectionWarning />}
        <AuthView onAuthed={onAuthed} />
      </>
    )
  }

  const activeMembers = activeChat ? (members.get(activeChat.id) ?? []) : []

  return (
    <div className="flex h-full overflow-hidden">
      {/* Колонка чатов: на телефоне показывается одна панель за раз */}
      <div className={`${mobilePane === 'chat' ? 'hidden' : 'flex'} h-full w-full md:flex md:w-auto`}>
        <Sidebar
          selfId={session!.userId}
          selfName={session!.profile.display_name || session!.profile.username}
          chats={chats}
          peers={peers}
          lastMessage={lastMessage}
          activeId={activeChat?.id}
          loading={loading}
          onSelect={selectChat}
          onCreated={onCreated}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </div>

      <div className={`${mobilePane === 'list' ? 'hidden' : 'flex'} min-w-0 flex-1 md:flex`}>
        {activeChat ? (
          <ChatView
            chat={activeChat}
            peer={activePeer}
            members={activeMembers}
            selfId={session!.userId}
            onBack={() => setMobilePane('list')}
            onOpenGroup={() => setGroupOpen(true)}
          />
        ) : (
          <EmptyState />
        )}
      </div>

      {groupOpen && activeChat && (
        <GroupPanel
          chat={activeChat}
          selfId={session!.userId}
          onClose={() => setGroupOpen(false)}
          onLeft={() => {
            setGroupOpen(false)
            setActiveChat(null)
            setActivePeer(undefined)
            setMobilePane('list')
          }}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onLogout={() => void logout()}
          perf={perf}
        />
      )}

      {callOpen && <CallOverlay onClose={() => setCallOpen(false)} />}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="relative grid h-full flex-1 place-items-center overflow-hidden">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="anim-drift absolute left-1/4 top-1/4 size-[34rem] rounded-full bg-brand-500/12 blur-[110px]" />
        <div
          className="anim-drift absolute bottom-1/4 right-1/4 size-[30rem] rounded-full bg-aqua-500/10 blur-[110px]"
          style={{ animationDelay: '-10s' }}
        />
      </div>
      <div className="anim-rise max-w-sm px-6 text-center">
        <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-aqua-500 shadow-2xl shadow-brand-600/25">
          <MessageSquare size={24} className="text-white" />
        </div>
        <h2 className="text-lg font-semibold text-white">Выберите чат</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-mist-400">
          Или найдите человека по логину слева. Все сообщения шифруются на вашем устройстве —
          сервер видит только шифротекст.
        </p>
        <p className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-aqua-500/10 px-3 py-1.5 text-xs text-aqua-400">
          <ShieldCheck size={12} /> AES-256-GCM · ECDH P-256 · WebRTC
        </p>
      </div>
    </div>
  )
}