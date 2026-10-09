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

export const isConfigured = Boolean(url && anonKey && url.startsWith('http'))

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
  const { data, error } = await supabase
    .from('devices')
    .upsert(
      { user_id: userId, label, user_agent: navigator.userAgent.slice(0, 250), last_active: new Date().toISOString() },
      { onConflict: 'id' },
    )
    .select()
    .single()
  if (error) throw error
  return data as Device
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