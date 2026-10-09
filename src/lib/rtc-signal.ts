/**
 * Логика управления звонком — чистая, без WebRTC и сети.
 *
 * Вынесена отдельно по одной причине: это самая ошибкоопасная часть звонков,
 * и её нужно проверять тестами напрямую. Здесь нет ни медиапотока, ни
 * браузерных API — только решение «что делать с пришедшим служебным
 * сообщением». Всё, что связано с RTCPeerConnection, осталось в rtc.ts.
 *
 * Правило, которое здесь закодировано и которое важнее остальных:
 * присоединяющийся участник НИКОГДА не отправляет предложение первым.
 * Предложения ему присылают уже подключённые. Без этого правила две стороны
 * одновременно отправляют предложение, соединение рвётся, и звонок не
 * поднимается — причём не всегда, а «иногда», что делает ошибку особенно
 * неприятной.
 */

export type CallKind = 'audio' | 'video'
export type CallState = 'idle' | 'inviting' | 'incoming' | 'connecting' | 'active' | 'ended'

export type Signal =
  | {
      kind: 'invite'
      callId: string
      chatId: string
      from: string
      callType: CallKind
      title: string
      ts: number
    }
  | { kind: 'join'; callId: string; from: string }
  | { kind: 'offer'; callId: string; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { kind: 'answer'; callId: string; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { kind: 'ice'; callId: string; from: string; to: string; candidate: RTCIceCandidateInit }
  | {
      kind: 'media'
      callId: string
      from: string
      muted: boolean
      videoOff: boolean
      sharing: boolean
    }
  | { kind: 'leave'; callId: string; from: string }
  | { kind: 'reject'; callId: string; from: string }

/** Состояние звонка, которым управляет эта логика. */
export interface SignalState {
  selfId: string
  state: CallState
  callId: string | null
  chatId: string | null
  initiator: string | null
  /** Участники, с которыми идёт обмен описаниями. */
  peers: Set<string>
  /** Кандидаты, пришедшие до описания сессии: userId → очередь. */
  pendingCandidates: Map<string, RTCIceCandidateInit[]>
  /** Участники, для которых уже получено описание сессии. */
  described: Set<string>
  /** Что этот узел должен отправить в ответ. */
  outgoing: Signal[]
  /** Почему звонок завершился, если завершился. */
  endedReason: string | null
  /** Участники с изменённым состоянием микрофона/камеры. */
  mediaUpdates: { userId: string; muted: boolean; videoOff: boolean; sharing: boolean }[]
}

export function initialState(selfId: string): SignalState {
  return {
    selfId,
    state: 'idle',
    callId: null,
    chatId: null,
    initiator: null,
    peers: new Set(),
    pendingCandidates: new Map(),
    described: new Set(),
    outgoing: [],
    endedReason: null,
    mediaUpdates: [],
  }
}

/** Создаёт состояние для исходящего звонка. */
export function beginOutgoing(
  selfId: string,
  chatId: string,
  callId: string,
  kind: CallKind,
  title: string,
): SignalState {
  const s = initialState(selfId)
  s.state = 'inviting'
  s.callId = callId
  s.chatId = chatId
  s.initiator = selfId
  s.outgoing.push({ kind: 'invite', callId, chatId, from: selfId, callType: kind, title, ts: Date.now() })
  return s
}

/**
 * Обрабатывает пришедшее служебное сообщение и возвращает НОВОЕ состояние.
 *
 * Функция чистая: одинаковый вход всегда даёт одинаковый выход, никаких
 * побочных эффектов. Благодаря этому её поведение можно проверить тестами
 * полностью — что и делает bench/rtc.mjs.
 */
export function receive(state: SignalState, signal: Signal): SignalState {
  const s: SignalState = {
    ...state,
    peers: new Set(state.peers),
    pendingCandidates: new Map([...state.pendingCandidates].map(([k, v]) => [k, [...v]])),
    described: new Set(state.described),
    outgoing: [],
    mediaUpdates: [],
    endedReason: state.endedReason,
  }

  // Свои же сообщения возвращаются при некоторых настройках канала.
  // Обрабатывать их нельзя: получится бесконечный цикл.
  if (signal.from === s.selfId) return s

  // Сообщение из другого звонка игнорируется целиком.
  if (signal.kind !== 'invite' && s.callId && signal.callId !== s.callId) return s

  switch (signal.kind) {
    case 'invite': {
      // Уже в звонке — вежливо отказываем, а не молчим.
      if (s.state !== 'idle') {
        s.outgoing.push({ kind: 'reject', callId: signal.callId, from: s.selfId })
        return s
      }
      s.state = 'incoming'
      s.callId = signal.callId
      s.chatId = signal.chatId
      s.initiator = signal.from
      s.peers.add(signal.from)
      return s
    }

    case 'join': {
      s.peers.add(signal.from)
      // Предлагает только уже подключённая сторона.
      if (['inviting', 'connecting', 'active'].includes(s.state)) {
        s.state = 'active'
        // Настоящее описание подставит WebRTC-слой: здесь решается лишь то,
        // что предложение нужно отправить и кому именно.
        s.outgoing.push({
          kind: 'offer',
          callId: s.callId!,
          from: s.selfId,
          to: signal.from,
          sdp: { type: 'offer' },
        })
      }
      return s
    }

    case 'offer': {
      if (signal.to !== s.selfId) return s
      s.peers.add(signal.from)
      s.described.add(signal.from)
      // Отложенные кандидаты применяются вместе с описанием.
      s.pendingCandidates.delete(signal.from)
      s.state = 'active'
      s.outgoing.push({
        kind: 'answer',
        callId: s.callId!,
        from: s.selfId,
        to: signal.from,
        sdp: { type: 'answer' },
      })
      return s
    }

    case 'answer': {
      if (signal.to !== s.selfId) return s
      s.peers.add(signal.from)
      s.described.add(signal.from)
      s.pendingCandidates.delete(signal.from)
      s.state = 'active'
      return s
    }

    case 'ice': {
      if (signal.to !== s.selfId) return s
      if (!s.described.has(signal.from)) {
        const q = s.pendingCandidates.get(signal.from) ?? []
        q.push(signal.candidate)
        s.pendingCandidates.set(signal.from, q)
      }
      return s
    }

    case 'media': {
      s.mediaUpdates.push({
        userId: signal.from,
        muted: signal.muted,
        videoOff: signal.videoOff,
        sharing: signal.sharing,
      })
      return s
    }

    case 'leave': {
      s.peers.delete(signal.from)
      // В разговоре один на один выход собеседника завершает звонок.
      if (s.peers.size === 0 && s.state !== 'inviting') {
        s.state = 'idle'
        s.endedReason = 'Собеседник вышел'
        s.callId = null
      }
      return s
    }

    case 'reject': {
      s.peers.delete(signal.from)
      s.state = 'idle'
      s.endedReason = 'Звонок отклонён'
      s.callId = null
      return s
    }

    default:
      return s
  }
}

/** Разворачивает состояние в действия для WebRTC-слоя. */
export function actionsOf(state: SignalState) {
  return {
    send: state.outgoing,
    media: state.mediaUpdates,
    finished: state.state === 'idle' && state.endedReason !== null,
    endedReason: state.endedReason,
  }
}

/**
 * Сколько соединений нужно установить при текущем составе участников.
 * Для топологии «каждый с каждым» это n·(n−1)/2.
 */
export function expectedConnections(participantCount: number): number {
  return (participantCount * (participantCount - 1)) / 2
}