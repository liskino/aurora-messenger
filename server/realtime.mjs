/**
 * Обмен событиями в реальном времени через Server-Sent Events.
 *
 * Почему SSE, а не WebSocket: нужен поток только в одну сторону — сервер
 * сообщает о новом сообщении, реакции, прочтении или входящем звонке.
 * Действия клиента и так уходят обычными запросами. SSE даёт это без ручной
 * работы с кадрами протокола (маскирование, фрагментация, ping/pong), где
 * ошибки проявляются редко и невоспроизводимо, и умеет переподключаться
 * самостоятельно — браузер делает это сам.
 *
 * Каждый подключённый клиент — одна запись в реестре. Событие адресуется
 * конкретным пользователям: участникам чата или одному получателю звонка.
 */

/** userId → набор открытых потоков. У одного человека может быть несколько вкладок. */
const streams = new Map()

/** chatId → набор userId, которые слушают звонки этого чата. */
const callRooms = new Map()

let connectionSeq = 0

export function addStream(userId, res) {
  const id = ++connectionSeq
  const stream = { id, res, userId }

  const set = streams.get(userId) ?? new Set()
  set.add(stream)
  streams.set(userId, set)

  // Заголовки для SSE. X-Accel-Buffering отключает буферизацию у прокси,
  // иначе события могут копиться и приходить пачками вместо мгновенно.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')

  const ping = setInterval(() => {
    // Комментарий-пинг держит соединение живым: молчащий прокси или
    // браузер иначе закрывают поток через минуту-две простоя.
    try {
      res.write(': ping\n\n')
    } catch {
      cleanup()
    }
  }, 25_000)

  const cleanup = () => {
    clearInterval(ping)
    const s = streams.get(userId)
    if (s) {
      s.delete(stream)
      if (!s.size) streams.delete(userId)
    }
    leaveCallRooms(userId, id)
    try {
      res.end()
    } catch {
      /* соединение уже закрыто */
    }
  }

  res.on('close', cleanup)
  res.on('error', cleanup)

  return { id, close: cleanup }
}

function leaveCallRooms(userId, streamId) {
  for (const [chatId, listeners] of callRooms) {
    listeners.delete(`${userId}:${streamId}`)
    if (!listeners.size) callRooms.delete(chatId)
  }
}

/**
 * Отправляет событие одному пользователю.
 * Ошибка доставки не должна ломать чужую операцию: сообщение всё равно
 * сохранено в базе, а клиент подтянет его при следующем открытии чата.
 */
export function emitTo(userId, event, payload) {
  const set = streams.get(userId)
  if (!set) return 0

  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  let delivered = 0
  for (const stream of set) {
    try {
      stream.res.write(frame)
      delivered++
    } catch {
      /* поток закрывается, уборка произойдёт по событию close */
    }
  }
  return delivered
}

/** Отправляет событие нескольким пользователям. */
export function emitToMany(userIds, event, payload) {
  let total = 0
  for (const id of new Set(userIds)) total += emitTo(id, event, payload)
  return total
}

/** Кто сейчас подключён — используется для списка «в сети». */
export function onlineUsers() {
  return [...streams.keys()]
}

export function isOnline(userId) {
  return streams.has(userId)
}

// ─────────────────────────── комнаты звонков ───────────────────────────

/**
 * Подписка на служебные сообщения звонка в чате.
 * Отдельно от сообщений: эти данные не сохраняются и живут, пока идёт разговор.
 */
export function joinCallRoom(chatId, userId, streamId) {
  const listeners = callRooms.get(chatId) ?? new Set()
  listeners.add(`${userId}:${streamId}`)
  callRooms.set(chatId, listeners)
}

export function leaveCallRoom(chatId, userId, streamId) {
  const listeners = callRooms.get(chatId)
  if (!listeners) return
  listeners.delete(`${userId}:${streamId}`)
  if (!listeners.size) callRooms.delete(chatId)
}

/**
 * Рассылает служебное сообщение звонка всем в комнате, кроме отправителя.
 *
 * Отправителю его же сообщение не нужно: он и так знает, что отправил, а
 * лишняя обработка привела бы к повторному разбору предложения соединения.
 * Каждому участнику шлём ровно один экземпляр, даже если у него открыто
 * несколько вкладок — иначе входящий звонок зазвенит во всех окнах сразу.
 */
export function broadcastCall(chatId, fromUserId, payload) {
  const listeners = callRooms.get(chatId)
  if (!listeners) return 0

  const frame = `event: call\ndata: ${JSON.stringify(payload)}\n\n`

  // Сначала собираем уникальных получателей, потом доставляем.
  const recipients = new Set()
  for (const key of listeners) {
    const userId = key.slice(0, key.lastIndexOf(':'))
    if (userId !== fromUserId) recipients.add(userId)
  }

  let delivered = 0
  for (const userId of recipients) {
    const set = streams.get(userId)
    if (!set?.size) continue
    const stream = [...set][0]
    try {
      stream.res.write(frame)
      delivered++
    } catch {
      /* поток закрывается: уборка произойдёт по событию close */
    }
  }
  return delivered
}

export function stats() {
  return { streams: streams.size, callRooms: callRooms.size }
}