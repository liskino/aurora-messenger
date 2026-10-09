/**
 * Клиент API автономного сервера.
 *
 * Заменяет собой облачный слой: тот же набор операций, но запросы идут на
 * свой сервер, который поднимается вместе с приложением. Ни регистраций на
 * сторонних сайтах, ни ключей, ни интернета — всё работает локально.
 *
 * Правило слоя остаётся прежним: сюда приходит только шифротекст. Ни одна
 * функция этого модуля не знает, что внутри сообщения.
 *
 * Обмен событиями — один поток на клиента (Server-Sent Events), а не канал
 * на каждый чат: меньше соединений, меньше кода и автоматическое
 * переподключение средствами браузера.
 */
import type {
  Chat,
  ChatMember,
  Device,
  Message,
  Profile,
  Receipt,
} from './types'

/**
 * Адрес сервера.
 *
 * В обычной работе клиент и сервер живут на одном порту, поэтому путь
 * относительный. Переменная нужна только для раздельной разработки,
 * когда Vite отдаёт страницу на 5173, а API слушает 8787.
 */
const API_BASE = import.meta.env.VITE_API_URL || ''

const TOKEN_KEY = 'aurora.token'

let token: string | null = null

// ─────────────────────────── токен сессии ───────────────────────────

function loadToken(): string | null {
  if (token !== null) return token
  try {
    token = localStorage.getItem(TOKEN_KEY)
  } catch {
    token = null
  }
  return token
}

function saveToken(value: string | null) {
  token = value
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* приватный режим может запрещать localStorage */
  }
}

export function authToken(): string | null {
  return loadToken()
}

// ─────────────────────────── запросы ───────────────────────────

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(
  method: string,
  path: string,
  options: { body?: unknown; raw?: BodyInit; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { ...options.headers }
  const current = loadToken()
  if (current) headers.Authorization = `Bearer ${current}`

  let body: BodyInit | undefined
  if (options.raw !== undefined) {
    body = options.raw
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { method, headers, body })
  } catch (e) {
    // Сеть отвалилась или сервер не запущен — это самая частая проблема,
    // и сообщение должно объяснять причину, а не показывать «Failed to fetch».
    throw new ApiError(
      'Нет связи с сервером Aurora. Проверьте, что он запущен, и обновите страницу.',
      0,
      'OFFLINE',
    )
  }

  if (res.status === 204) return undefined as T

  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }

  if (!res.ok) {
    const payload = data as { error?: string; code?: string } | null
    if (res.status === 401) saveToken(null)
    throw new ApiError(payload?.error ?? `Ошибка ${res.status}`, res.status, payload?.code)
  }

  return data as T
}

const get = <T>(path: string) => request<T>('GET', path)
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, { body })
const patch = <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body })
const del = <T>(path: string) => request<T>('DELETE', path)

// ─────────────────────────── служебное ───────────────────────────

export interface HealthInfo {
  ok: boolean
  name: string
  version: string
  time: string
  capabilities: { calls: boolean; files: boolean; groups: boolean; e2e: boolean }
}

/** Проверка: поднят ли сервер. Нужна экрану входа и замерам скорости. */
export async function health(): Promise<HealthInfo> {
  return get<HealthInfo>('/api/health')
}

export async function measureRtt(): Promise<number> {
  const t0 = performance.now()
  await health()
  return performance.now() - t0
}

// ─────────────────────────── вход и регистрация ───────────────────────────

export interface AuthResult {
  user: { id: string; email: string }
  token: string
  profile: Profile
}

export async function register(params: {
  email: string
  password: string
  username: string
  display_name: string
  public_key: string
  wrapped_private: string
  kdf_salt: string
  kdf_iterations: number
}): Promise<AuthResult> {
  const result = await post<AuthResult>('/api/auth/register', params)
  saveToken(result.token)
  return result
}

export async function login(email: string, password: string): Promise<AuthResult> {
  const result = await post<AuthResult>('/api/auth/login', { email, password })
  saveToken(result.token)
  return result
}

export async function logout(): Promise<void> {
  try {
    await post('/api/auth/logout')
  } finally {
    // Локальный токен убираем даже если запрос не прошёл: иначе человек
    // останется «внутри» с недействительной сессией.
    saveToken(null)
  }
}

export async function currentSession(): Promise<{ user: { id: string; email: string }; profile: Profile } | null> {
  if (!loadToken()) return null
  try {
    return await get<{ user: { id: string; email: string }; profile: Profile }>('/api/auth/session')
  } catch {
    return null
  }
}

// ─────────────────────────── профили ───────────────────────────

export async function getProfile(userId: string): Promise<Profile | null> {
  try {
    return await get<Profile>(`/api/profiles/${encodeURIComponent(userId)}`)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null
    throw e
  }
}

export async function getProfilesByIds(ids: string[]): Promise<Profile[]> {
  if (!ids.length) return []
  return post<Profile[]>('/api/profiles/by-ids', { ids })
}

export async function searchProfiles(query: string, _excludeId?: string): Promise<Profile[]> {
  const q = query.trim()
  if (q.length < 2) return []
  return get<Profile[]>(`/api/profiles/search/${encodeURIComponent(q)}`)
}

export async function touchLastSeen(_userId: string): Promise<void> {
  // Отметка присутствия ставится сервером при обращении к потоку событий,
  // отдельный запрос для этого не нужен.
}

// ─────────────────────────── устройства ───────────────────────────

/** Человекочитаемое имя устройства: «Chrome на Windows» понятнее, чем UA-строка. */
export function deviceLabel(): string {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /YaBrowser\//.test(ua)
        ? 'Яндекс'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Браузер'
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'система'
  return `${browser} на ${os}`
}

export async function registerDevice(_userId: string, label: string): Promise<Device> {
  return post<Device>('/api/devices', { label })
}

export async function listDevices(_userId: string): Promise<Device[]> {
  return get<Device[]>('/api/devices')
}

export async function removeDevice(id: string): Promise<void> {
  await del(`/api/devices/${encodeURIComponent(id)}`)
}

export async function heartbeat(deviceId: string): Promise<void> {
  try {
    await post(`/api/devices/${encodeURIComponent(deviceId)}/ping`)
  } catch {
    // Отметка присутствия — вспомогательная функция, сбой не должен
    // выбрасывать человека из мессенджера.
  }
}

// ─────────────────────────── чаты ───────────────────────────

export async function createChat(
  kind: 'direct' | 'group',
  title: string | null,
  _createdBy: string,
  members: { user_id: string; wrapped_key: string }[],
): Promise<Chat> {
  return post<Chat>('/api/chats', { kind, title, members })
}

export async function getMyMemberships(_userId: string): Promise<ChatMember[]> {
  return get<ChatMember[]>('/api/memberships')
}

export async function getChatsByIds(ids: string[]): Promise<Chat[]> {
  if (!ids.length) return []
  return post<Chat[]>('/api/chats/by-ids', { ids })
}

export async function getMembers(chatIds: string[]): Promise<ChatMember[]> {
  if (!chatIds.length) return []
  const results = await Promise.all(
    chatIds.map((id) => get<ChatMember[]>(`/api/chats/${encodeURIComponent(id)}/members`)),
  )
  return results.flat()
}

export async function upsertMembers(
  rows: { chat_id: string; user_id: string; wrapped_key: string }[],
): Promise<void> {
  // Группируем по чату: сервер принимает участников одного чата за раз.
  const byChat = new Map<string, { user_id: string; wrapped_key: string }[]>()
  for (const r of rows) {
    const list = byChat.get(r.chat_id) ?? []
    list.push({ user_id: r.user_id, wrapped_key: r.wrapped_key })
    byChat.set(r.chat_id, list)
  }
  for (const [chatId, members] of byChat) {
    await post(`/api/chats/${encodeURIComponent(chatId)}/members`, { members })
  }
}

export async function removeMember(chatId: string, userId: string): Promise<void> {
  await del(`/api/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(userId)}`)
}

export async function updateChatTitle(chatId: string, title: string): Promise<void> {
  await patch(`/api/chats/${encodeURIComponent(chatId)}`, { title })
}

// ─────────────────────────── сообщения ───────────────────────────

export interface NewMessage {
  chat_id: string
  sender_id?: string
  ciphertext: string
  iv: string
  kind?: 'text' | 'file'
  file_path?: string | null
  file_name_sealed?: string | null
  file_name_iv?: string | null
  file_type?: string | null
  file_size?: number | null
  wrapped_file_key?: string | null
}

export async function sendMessage(m: NewMessage): Promise<Message> {
  return post<Message>('/api/messages', m)
}

export async function fetchMessages(chatId: string, limit = 300): Promise<Message[]> {
  return get<Message[]>(`/api/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}`)
}

export async function editMessage(
  id: string,
  ciphertext: string,
  iv: string,
): Promise<Message> {
  return patch<Message>(`/api/messages/${encodeURIComponent(id)}`, { ciphertext, iv })
}

export async function deleteMessage(id: string): Promise<void> {
  await del(`/api/messages/${encodeURIComponent(id)}`)
}

// ─────────────────────────── доставлено / прочитано ───────────────────────────

export async function markDelivered(messageIds: string[], _userId: string): Promise<void> {
  if (!messageIds.length) return
  await post('/api/receipts', { message_ids: messageIds, read: false })
}

export async function markRead(messageIds: string[], _userId: string): Promise<void> {
  if (!messageIds.length) return
  await post('/api/receipts', { message_ids: messageIds, read: true })
}

export async function fetchReceipts(messageIds: string[]): Promise<Receipt[]> {
  if (!messageIds.length) return []
  return post<Receipt[]>('/api/receipts/for', { message_ids: messageIds })
}

// ─────────────────────────── «печатает» ───────────────────────────

export async function setTyping(chatId: string, _userId: string): Promise<void> {
  await post('/api/typing', { chat_id: chatId, active: true })
}

export async function clearTyping(chatId: string, _userId: string): Promise<void> {
  await post('/api/typing', { chat_id: chatId, active: false })
}

// ─────────────────────────── реакции ───────────────────────────

export async function addReaction(messageId: string, _userId: string, emoji: string): Promise<void> {
  await post('/api/reactions', { message_id: messageId, emoji })
}

export async function removeReaction(messageId: string, _userId: string): Promise<void> {
  await del(`/api/reactions/${encodeURIComponent(messageId)}`)
}

export async function fetchReactions(
  messageIds: string[],
): Promise<{ message_id: string; user_id: string; emoji: string }[]> {
  if (!messageIds.length) return []
  return post('/api/reactions/for', { message_ids: messageIds })
}

// ─────────────────────────── файлы ───────────────────────────

/**
 * Загрузка зашифрованного файла.
 *
 * Возвращает путь, назначенный сервером. Раньше путь придумывал клиент —
 * теперь это делает сервер: так два человека не могут занять одно имя,
 * и клиенту не нужно угадывать формат.
 */
export async function uploadEncrypted(
  chatId: string,
  blob: Blob,
  onProgress?: (ratio: number) => void,
): Promise<{ path: string; size: number }> {
  onProgress?.(0.05)
  const result = await request<{ path: string; size: number }>(
    'POST',
    `/api/files/${encodeURIComponent(chatId)}`,
    {
      raw: blob,
      headers: { 'Content-Type': 'application/octet-stream' },
    },
  )
  onProgress?.(1)
  return result
}

export async function downloadEncrypted(path: string): Promise<Blob> {
  const headers: Record<string, string> = {}
  const current = loadToken()
  if (current) headers.Authorization = `Bearer ${current}`

  const res = await fetch(`${API_BASE}/api/files/${path}`, { headers })
  if (!res.ok) {
    throw new ApiError('Не удалось получить файл', res.status)
  }
  return res.blob()
}

export async function removeEncrypted(path: string): Promise<void> {
  await del(`/api/files/${path}`)
}

// ─────────────────────────── realtime ───────────────────────────

/** События, приходящие по потоку от сервера. */
export interface ServerEvents {
  onMessage?: (message: Message) => void
  onMessageUpdated?: (message: Message) => void
  onMessageDeleted?: (messageId: string, chatId: string) => void
  onTyping?: (chatId: string, userId: string | null) => void
  onReceipt?: (receipts: Receipt[]) => void
  onReaction?: (messageId: string, userId: string, emoji: string | null) => void
  onPresence?: (online: string[]) => void
  onChat?: (chat: Chat) => void
  onRemoved?: (chatId: string) => void
  /** Служебные сообщения звонка — разбираются в rtc.ts. */
  onCall?: (payload: unknown) => void
  onStatus?: (connected: boolean) => void
}

let eventSource: EventSource | null = null
let currentHandlers: ServerEvents = {}
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Открывает поток событий.
 *
 * Одно соединение на всё приложение: сообщения, реакции, отметки, typing,
 * присутствие и сигнализация звонков идут по нему. Меньше соединений —
 * меньше нагрузки и на сервер, и на браузер.
 *
 * Переподключение: браузер делает это сам, но если сервер перезапустили,
 * соединение может закрыться окончательно. Поэтому на ошибку ставим свой
 * таймер и открываем поток заново.
 */
export function subscribeEvents(handlers: ServerEvents, callChatId?: string | null): () => void {
  currentHandlers = handlers
  openEvents(callChatId)

  return () => {
    currentHandlers = {}
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
  }
}

/** Переподписка при входе в другой чат: комната звонков меняется. */
export function resubscribeEvents(callChatId: string | null) {
  if (!eventSource) return
  openEvents(callChatId)
}

function openEvents(callChatId?: string | null) {
  const current = loadToken()
  if (!current) return

  if (eventSource) {
    eventSource.close()
    eventSource = null
  }

  const params = new URLSearchParams({ token: current })
  if (callChatId) params.set('callChat', callChatId)

  const source = new EventSource(`${API_BASE}/api/events?${params}`)
  eventSource = source

  source.onopen = () => currentHandlers.onStatus?.(true)

  source.addEventListener('message', (e) => {
    const data = JSON.parse((e as MessageEvent).data)
    currentHandlers.onMessage?.(data.message)
  })

  source.addEventListener('message_updated', (e) => {
    currentHandlers.onMessageUpdated?.(JSON.parse((e as MessageEvent).data).message)
  })

  source.addEventListener('message_deleted', (e) => {
    const data = JSON.parse((e as MessageEvent).data)
    currentHandlers.onMessageDeleted?.(data.messageId, data.chatId)
  })

  source.addEventListener('typing', (e) => {
    const data = JSON.parse((e as MessageEvent).data)
    currentHandlers.onTyping?.(data.chatId, data.userId)
  })

  source.addEventListener('receipt', (e) => {
    currentHandlers.onReceipt?.(JSON.parse((e as MessageEvent).data).receipts)
  })

  source.addEventListener('reaction', (e) => {
    const data = JSON.parse((e as MessageEvent).data)
    currentHandlers.onReaction?.(data.messageId, data.userId, data.emoji)
  })

  source.addEventListener('presence', (e) => {
    currentHandlers.onPresence?.(JSON.parse((e as MessageEvent).data).online)
  })

  source.addEventListener('chat', (e) => {
    currentHandlers.onChat?.(JSON.parse((e as MessageEvent).data).chat)
  })

  source.addEventListener('removed', (e) => {
    currentHandlers.onRemoved?.(JSON.parse((e as MessageEvent).data).chatId)
  })

  source.addEventListener('call', (e) => {
    currentHandlers.onCall?.(JSON.parse((e as MessageEvent).data))
  })

  source.onerror = () => {
    currentHandlers.onStatus?.(false)
    source.close()
    if (eventSource === source) eventSource = null

    // Своя переподписка с нарастающей паузой: при перезапуске сервера
    // браузер сам не поднимет поток, а человек не должен перезагружать страницу.
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (Object.keys(currentHandlers).length) openEvents(callChatId)
    }, 3000)
  }
}

export function closeEvents() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
  currentHandlers = {}
}

export function eventsConnected(): boolean {
  return eventSource?.readyState === EventSource.OPEN
}

// ─────────────────────────── сигнализация звонков ───────────────────────────

/** Отправляет служебное сообщение звонка в комнату чата. */
export async function sendCallSignal(chatId: string, payload: unknown): Promise<number> {
  const result = await post<{ delivered: number }>(
    `/api/call/${encodeURIComponent(chatId)}`,
    payload,
  )
  return result.delivered ?? 0
}

/** Подтверждает, что этот чат слушается на предмет входящих звонков. */
export async function subscribeCallRoom(chatId: string): Promise<string[]> {
  const result = await post<{ online: string[] }>(
    `/api/call/${encodeURIComponent(chatId)}/subscribe`,
  )
  return result.online ?? []
}