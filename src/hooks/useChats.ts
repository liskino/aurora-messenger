import { useEffect, useRef, useState } from 'react'
import { engine } from '@/lib/engine'
import type { Chat, DecryptedMessage, Profile } from '@/lib/types'

export interface ChatState {
  chats: Chat[]
  peers: Map<string, Profile>
  members: Map<string, Profile[]>
  lastMessage: Map<string, DecryptedMessage>
  loading: boolean
  error: string | null
}

/**
 * Состояние списка чатов.
 *
 * Сообщения из realtime обновляют списки точечно, а не перезагрузкой всего:
 * полная перезагрузка на каждое пришедшее сообщение — самая частая причина
 * «тормозов» в мессенджерах.
 */
export function useChats(active: boolean, selfId: string | undefined) {
  const [state, setState] = useState<ChatState>({
    chats: [],
    peers: new Map(),
    members: new Map(),
    lastMessage: new Map(),
    loading: true,
    error: null,
  })
  const loaded = useRef(false)

  useEffect(() => {
    if (!active || !selfId || loaded.current) return
    loaded.current = true

    let cancelled = false
    ;(async () => {
      try {
        const chats = await engine.listChats()
        if (cancelled) return

        const peers = new Map<string, Profile>()
        const members = new Map<string, Profile[]>()
        await Promise.all(
          chats.map(async (c) => {
            const list = await engine.chatMembers(c.id)
            members.set(c.id, list)
            const other = list.find((m) => m.id !== selfId)
            if (other) peers.set(c.id, other)
            engine.subscribeChat(c.id)
          }),
        )
        if (cancelled) return
        setState((s) => ({ ...s, chats, peers, members, loading: false }))
      } catch (e) {
        if (!cancelled) {
          setState((s) => ({ ...s, loading: false, error: (e as Error).message }))
        }
      }
    })()

    const off = engine.on((e) => {
      if (e.type === 'message') {
        setState((s) => {
          const last = new Map(s.lastMessage)
          const prev = last.get(e.chatId)
          if (!prev || prev.created_at <= e.message.created_at) last.set(e.chatId, e.message)
          return { ...s, lastMessage: last }
        })
      } else if (e.type === 'chat') {
        setState((s) =>
          s.chats.some((c) => c.id === e.chat.id) ? s : { ...s, chats: [e.chat, ...s.chats] },
        )
      }
    })

    return () => {
      cancelled = true
      off()
    }
  }, [active, selfId])

  const addChat = (chat: Chat, peer: Profile | undefined) => {
    setState((s) => {
      if (s.chats.some((c) => c.id === chat.id)) return s
      const peers = new Map(s.peers)
      if (peer) peers.set(chat.id, peer)
      return { ...s, chats: [chat, ...s.chats], peers }
    })
  }

  return { ...state, addChat }
}