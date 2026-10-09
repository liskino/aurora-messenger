/**
 * Локальное хранилище устройства (IndexedDB).
 *
 * Здесь живут только секреты устройства: неизвлекаемый ключ устройства,
 * обёрнутый им приватный ключ личности и кэш ключей чата. Ничего из этого
 * не отправляется на сервер.
 */
import { openDB, type IDBPDatabase } from 'idb'

const DB_NAME = 'aurora-vault'
const DB_VERSION = 1

interface VaultSchema {
  device: { key: string; value: unknown }
  chatKeys: { key: string; value: { chatId: string; wrapped: string } }
  prefs: { key: string; value: unknown }
}

let dbPromise: Promise<IDBPDatabase<VaultSchema>> | null = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB<VaultSchema>(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains('device')) d.createObjectStore('device')
        if (!d.objectStoreNames.contains('chatKeys')) d.createObjectStore('chatKeys', { keyPath: 'chatId' })
        if (!d.objectStoreNames.contains('prefs')) d.createObjectStore('prefs')
      },
    })
  }
  return dbPromise
}

// ── устройство ──

export async function putDeviceKey(userId: string, key: CryptoKey, wrappedPrivate: string) {
  const d = await db()
  await d.put('device', { key, wrappedPrivate, savedAt: Date.now() }, `device:${userId}`)
}

export async function getDevice(
  userId: string,
): Promise<{ key: CryptoKey; wrappedPrivate: string; savedAt: number } | undefined> {
  const d = await db()
  return d.get('device', `device:${userId}`) as Promise<
    { key: CryptoKey; wrappedPrivate: string; savedAt: number } | undefined
  >
}

export async function forgetDevice(userId: string) {
  const d = await db()
  await d.delete('device', `device:${userId}`)
  await d.clear('chatKeys')
}

export async function listDevices(): Promise<string[]> {
  const d = await db()
  return (await d.getAllKeys('device')).map(String)
}

// ── ключи чата ──

export async function cacheChatKey(chatId: string, wrapped: string) {
  const d = await db()
  await d.put('chatKeys', { chatId, wrapped })
}

export async function getCachedChatKey(chatId: string): Promise<string | undefined> {
  const d = await db()
  const row = await d.get('chatKeys', chatId)
  return row?.wrapped
}

export async function dropChatKey(chatId: string) {
  const d = await db()
  await d.delete('chatKeys', chatId)
}

export async function clearChatKeys() {
  const d = await db()
  await d.clear('chatKeys')
}

// ── предпочтения ──

export async function setPref<T>(key: string, value: T) {
  const d = await db()
  await d.put('prefs', value, key)
}

export async function getPref<T>(key: string): Promise<T | undefined> {
  const d = await db()
  return (await d.get('prefs', key)) as T | undefined
}