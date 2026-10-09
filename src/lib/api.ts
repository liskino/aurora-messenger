/**
 * Клиент Supabase и весь доступ к данным.
 *
 * Правило слоя: сюда приходит только шифротекст. Ни одна функция этого модуля
 * не знает, что внутри сообщения.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Chat, ChatMember, Device, Message, Profile, Receipt } from './types'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * Есть ли настоящее подключение к бэкенду.
 *
 * Проверяются не только формат, но и заглушки из .env.example: адрес вида
 * «xxxxxxxxxxxx» и ключ не в формате JWT. Без этого приложение считало бы
 * пример настоящими настройками, показывало форму входа — и человек
 * упирался бы в непонятную ошибку входа вместо внятной подсказки.
 */
export const isConfigured = (() => {
  if (!url || !anonKey) return false
  if (!url.startsWith('https://')) return false

  const host = url.replace(/^https:\/\//, '').replace(/\.supabase\.co.*$/, '')
  if (/^x+$/i.test(host)) return false
  if (/^(ваш|your|example|test|demo|placeholder)$/i.test(host)) return false

  // Ключ Supabase — это JWT: всегда начинается с eyJ.
  if (!anonKey.startsWith('eyJ')) return false

  return true
})()

export let supabase: SupabaseClient = createClient(
  url || 'https://placeholder.supabase.co',
  anonKey || 'placeholder',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Ключевое для «запоминания устройства»: сессия переживает закрытие браузера.
      storage: typeof window !== 'undefined' ? window.localStorage : undefined,
      storageKey: 'aurora.auth',
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
    realtime: {
      params: { eventsPerSecond: 40 },
    },
    global: {
      headers: { 'x-application-name': 'aurora-messenger' },
    },
  },
)

export function reinitClient() {
  supabase = createClient(url || 'https://placeholder.supabase.co', anonKey || 'placeholder')
}

// ─────────────────────────── авторизация ───────────────────────────

export async function signUp(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${location.origin}${import.meta.env.BASE_URL}` },
  })
  if (error) throw error
  return data
}

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  return data
}

export async function signOut() {
  await supabase.auth.signOut()
}

export async function currentSession() {
  const { data } = await supabase.auth.getSession()
  return data.session
}

// ─────────────────────────── профили ───────────────────────────

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
  if (error) throw error
  return data as Profile | null
}

export async function getProfilesByIds(ids: string[]): Promise<Profile[]> {
  if (!ids.length) return []
  const { data, error } = await supabase.from('profiles').select('*').in('id', ids)
  if (error) throw error
  return (data ?? []) as Profile[]
}

export async function createProfile(p: {
  id: string
  username: string
  display_name: string
  public_key: string
  wrapped_private: string
  kdf_salt: string
  kdf_iterations: number
}) {
  const { error } = await supabase.from('profiles').upsert(p)
  if (error) throw error
}

export async function findProfileByUsername(username: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .ilike('username', username)
    .maybeSingle()
  if (error) throw error
  return data as Profile | null
}

export async function searchProfiles(query: string, excludeId: string): Promise<Profile[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .ilike('username', `%${q}%`)
    .neq('id', excludeId)
    .limit(20)
  if (error) throw error
  return (data ?? []) as Profile[]
}

export async function touchLastSeen(userId: string) {
  await supabase.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', userId)
}

// ─────────────────────────── устройства ───────────────────────────

export async function registerDevice(userId: string, label: string): Promise<Device> {
  // Устройство опознаём по отпечатку браузера, а не создаём новую запись
  // при каждом входе: иначе список устройств превращается в мусор.
  const fingerprint = deviceFingerprint()
  const existing = await supabase
    .from('devices')
    .select('*')
    .eq('user_id', userId)
    .eq('label', label)
    .maybeSingle()

  if (existing.data) {
    const { data, error } = await supabase
      .from('devices')
      .update({ last_active: new Date().toISOString(), user_agent: fingerprint })
      .eq('id', existing.data.id)
      .select()
      .single()
    if (error) throw error
    return data as Device
  }

  const { data, error } = await supabase
    .from('devices')
    .insert({ user_id: userId, label, user_agent: fingerprint, last_active: new Date().toISOString() })
    .select()
    .single()
  if (error) throw error
  return data as Device
}

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

function deviceFingerprint(): string {
  return [
    navigator.userAgent,
    navigator.language,
    screen.width,
    screen.height,
    new Date().getTimezoneOffset(),
  ]
    .join('|')
    .slice(0, 250)
}

export async function listDevices(userId: string): Promise<Device[]> {
  const { data, error } = await supabase
    .from('devices')
    .select('*')
    .eq('user_id', userId)
    .order('last_active', { ascending: false })
  if (error) throw error
  return (data ?? []) as Device[]
}

export async function removeDevice(id: string) {
  const { error } = await supabase.from('devices').delete().eq('id', id)
  if (error) throw error
}

// ─────────────────────────── чаты ───────────────────────────

export async function createChat(kind: 'direct' | 'group', title: string | null, createdBy: string): Promise<Chat> {
  const { data, error } = await supabase
    .from('chats')
    .insert({ kind, title, created_by: createdBy })
    .select()
    .single()
  if (error) throw error
  return data as Chat
}

export async function addMembers(rows: { chat_id: string; user_id: string; wrapped_key: string }[]) {
  const { error } = await supabase.from('chat_members').insert(rows)
  if (error) throw error
}

/** Идемпотентно: RLS не даёт читать членов чужих чатов, поэтому делаем сразу с ключами. */
export async function upsertMembers(rows: { chat_id: string; user_id: string; wrapped_key: string }[]) {
  const { error } = await supabase.from('chat_members').upsert(rows, { onConflict: 'chat_id,user_id' })
  if (error) throw error
}

export async function getMyMemberships(userId: string): Promise<ChatMember[]> {
  const { data, error } = await supabase.from('chat_members').select('*').eq('user_id', userId)
  if (error) throw error
  return (data ?? []) as ChatMember[]
}

export async function getChatsByIds(ids: string[]): Promise<Chat[]> {
  if (!ids.length) return []
  const { data, error } = await supabase.from('chats').select('*').in('id', ids)
  if (error) throw error
  return (data ?? []) as Chat[]
}

export async function getMembers(chatIds: string[]): Promise<ChatMember[]> {
  if (!chatIds.length) return []
  const { data, error } = await supabase.from('chat_members').select('*').in('chat_id', chatIds)
  if (error) throw error
  return (data ?? []) as ChatMember[]
}

export async function removeMember(chatId: string, userId: string) {
  const { error } = await supabase
    .from('chat_members')
    .delete()
    .eq('chat_id', chatId)
    .eq('user_id', userId)
  if (error) throw error
}

/**
 * Отметка присутствия.
 * Живёт в таблице devices: отдельная таблица ради одной отметки времени
 * была бы лишней сущностью.
 */
export async function heartbeat(deviceId: string) {
  await supabase.from('devices').update({ last_active: new Date().toISOString() }).eq('id', deviceId)
}

/** Подписка на присутствие участников: кто сейчас в сети. */
export function presenceChannel(userId: string, onSync: (online: string[]) => void) {
  const channel = supabase.channel('presence:global', {
    config: { presence: { key: userId } },
  })

  channel
    .on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState()
      onSync(Object.keys(state))
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ online_at: new Date().toISOString() })
      }
    })

  return channel
}

export async function updateChatTitle(chatId: string, title: string) {
  const { error } = await supabase.from('chats').update({ title }).eq('id', chatId)
  if (error) throw error
}

// ─────────────────────────── сообщения ───────────────────────────

export interface NewMessage {
  chat_id: string
  sender_id: string
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
  const { data, error } = await supabase.from('messages').insert(m).select().single()
  if (error) throw error
  return data as Message
}

export async function fetchMessages(chatId: string, limit = 200): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as Message[]
}

export async function deleteMessage(id: string) {
  const { error } = await supabase.from('messages').delete().eq('id', id)
  if (error) throw error
}

/** Реакции: одна реакция на пользователя на сообщение. */
export async function addReaction(messageId: string, userId: string, emoji: string) {
  const { error } = await supabase
    .from('reactions')
    .upsert({ message_id: messageId, user_id: userId, emoji }, { onConflict: 'message_id,user_id' })
  if (error) throw error
}

export async function removeReaction(messageId: string, userId: string) {
  const { error } = await supabase
    .from('reactions')
    .delete()
    .eq('message_id', messageId)
    .eq('user_id', userId)
  if (error) throw error
}

export async function fetchReactions(messageIds: string[]) {
  if (!messageIds.length) return []
  const { data, error } = await supabase
    .from('reactions')
    .select('message_id,user_id,emoji')
    .in('message_id', messageIds)
  if (error) throw error
  return (data ?? []) as { message_id: string; user_id: string; emoji: string }[]
}

// ─────────────────────────── доставлено / прочитано ───────────────────────────

export async function markDelivered(messageIds: string[], userId: string) {
  if (!messageIds.length) return
  const now = new Date().toISOString()
  const rows = messageIds.map((id) => ({ message_id: id, user_id: userId, delivered_at: now }))
  await supabase.from('receipts').upsert(rows, { onConflict: 'message_id,user_id' })
}

export async function markRead(messageIds: string[], userId: string) {
  if (!messageIds.length) return
  const now = new Date().toISOString()
  const rows = messageIds.map((id) => ({
    message_id: id,
    user_id: userId,
    delivered_at: now,
    read_at: now,
  }))
  await supabase.from('receipts').upsert(rows, { onConflict: 'message_id,user_id' })
}

export async function fetchReceipts(messageIds: string[]): Promise<Receipt[]> {
  if (!messageIds.length) return []
  const { data, error } = await supabase.from('receipts').select('*').in('message_id', messageIds)
  if (error) throw error
  return (data ?? []) as Receipt[]
}

// ─────────────────────────── печатает ───────────────────────────

export async function setTyping(chatId: string, userId: string) {
  await supabase.from('typing').upsert(
    { chat_id: chatId, user_id: userId, updated_at: new Date().toISOString() },
    { onConflict: 'chat_id,user_id' },
  )
}

export async function clearTyping(chatId: string, userId: string) {
  await supabase.from('typing').delete().eq('chat_id', chatId).eq('user_id', userId)
}

export async function fetchTyping(chatId: string): Promise<{ user_id: string; updated_at: string }[]> {
  const { data } = await supabase.from('typing').select('user_id, updated_at').eq('chat_id', chatId)
  return data ?? []
}

// ─────────────────────────── файлы ───────────────────────────

export async function uploadEncrypted(
  path: string,
  blob: Blob,
  onProgress?: (ratio: number) => void,
) {
  // Прогресс через XHR недоступен в supabase-js, поэтому сообщаем о старте/финише
  onProgress?.(0.05)
  const { error } = await supabase.storage.from('encrypted').upload(path, blob, {
    contentType: 'application/octet-stream',
    cacheControl: '3600',
    upsert: false,
  })
  if (error) throw error
  onProgress?.(1)
}

export async function downloadEncrypted(path: string): Promise<Blob> {
  const { data, error } = await supabase.storage.from('encrypted').download(path)
  if (error) throw error
  return data
}

export async function removeEncrypted(path: string) {
  await supabase.storage.from('encrypted').remove([path])
}

// ─────────────────────────── счётчики производительности ───────────────────────────

/** Замер реального RTT до бэкенда — попадает в отчёт о скорости. */
export async function measureRtt(): Promise<number> {
  const t0 = performance.now()
  await supabase.from('profiles').select('id', { count: 'exact', head: true }).limit(1)
  return performance.now() - t0
}