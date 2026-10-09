/**
 * Aurora — криптографическое ядро.
 *
 * Модель шифрования:
 *  • Ключ личности  — пара ECDH P-256 на пользователя. Приватный ключ никогда
 *    не покидает устройство в открытом виде: он шифруется AES-256-GCM.
 *  • Резервная копия — приватный ключ, зашифрованный ключом из пароля
 *    (PBKDF2-SHA256, 600 000 итераций, соль на пользователя). Лежит на сервере
 *    в виде шифротекста, поэтому вход с нового устройства возможен, а сервер
 *    прочитать ключ не может.
 *  • Ключ устройства — неизвлекаемый AES-256-GCM ключ в IndexedDB. Им
 *    оборачивается приватный ключ личности, чтобы «запомнить устройство»
 *    и не спрашивать пароль на каждом запуске.
 *  • Ключ чата       — случайный AES-256-GCM ключ. Для личного чата
 *    оборачивается общим секретом ECDH двух участников, для группы —
 *    отдельной обёрткой под открытый ключ каждого участника.
 *  • Сообщение       — AES-256-GCM, свой случайный IV на каждое сообщение.
 *  • Файл            — AES-256-GCM блоками по 1 МиБ, ключ файла обёрнут
 *    ключом чата.
 *
 * Сервер видит только шифротекст, метаданные маршрутизации и открытые ключи.
 */

const enc = new TextEncoder()
const dec = new TextDecoder()

export const PBKDF2_ITERATIONS = 600_000
const FILE_CHUNK = 1024 * 1024
const FILE_MAGIC = 'AUR1'

// ─────────────────────────── кодировки ───────────────────────────

/**
 * В TypeScript 5.7+ у типизированных массивов появился параметр буфера.
 * WebCrypto принимает только ArrayBuffer (не SharedArrayBuffer), поэтому
 * везде где массив уходит в subtle.encrypt/decrypt, тип указан явно.
 */
export type Bytes = Uint8Array<ArrayBuffer>

export function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode(...bytes.subarray(i, i + CH))
  }
  return btoa(s)
}

export function fromB64(b64: string): Bytes {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function b64ToBuf(b64: string): ArrayBuffer {
  const u = fromB64(b64)
  return u.buffer
}

export function randomBytes(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n))
}

// ─────────────────────────── ключи личности ───────────────────────────

export interface IdentityKeyPair {
  publicKeyB64: string
  privateKey: CryptoKey
}

/**
 * Пара ключей личности.
 *
 * extractable: true — вынужденная и осознанная необходимость. Приватный ключ
 * обязан быть извлекаемым, иначе его нельзя зашифровать паролем и сохранить
 * резервную копию на сервере, а тогда вход с нового устройства был бы
 * невозможен в принципе. Риск ограничен: ключ читается только кодом этой
 * страницы, а на сервер уходит исключительно в зашифрованном виде.
 *
 * Права ключа сужены до deriveKey/deriveBits: этим ключом нельзя подписать
 * или расшифровать что-либо, кроме согласования секрета.
 */
export async function generateIdentity(): Promise<IdentityKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveKey',
    'deriveBits',
  ])
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey)
  return { publicKeyB64: toB64(raw), privateKey: pair.privateKey }
}

/** Общий секрет ECDH → ключ AES-GCM для обёртки ключей чата. */
export async function deriveSharedKey(
  privateKey: CryptoKey,
  peerPublicKeyB64: string,
): Promise<CryptoKey> {
  const peer = await crypto.subtle.importKey(
    'raw',
    b64ToBuf(peerPublicKeyB64),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: peer },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// ─────────────────────────── пароль ───────────────────────────

export async function derivePasswordKey(
  password: string,
  saltB64: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBuf(saltB64), iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export function generateSalt(): string {
  return toB64(randomBytes(32))
}

// ─────────────────────────── обёртка приватного ключа ───────────────────────────

/** Упаковка приватного ключа личности: JWK → AES-GCM. */
export async function wrapPrivateKey(
  privateKey: CryptoKey,
  wrappingKey: CryptoKey,
): Promise<string> {
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  const iv = randomBytes(12)
  const plaintext = enc.encode(JSON.stringify(jwk))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, plaintext)
  return `${toB64(iv)}.${toB64(ct)}`
}

export async function unwrapPrivateKey(
  wrapped: string,
  wrappingKey: CryptoKey,
): Promise<CryptoKey> {
  const [ivB64, ctB64] = wrapped.split('.')
  if (!ivB64 || !ctB64) throw new Error('Повреждённая обёртка ключа')
  const jwkJson = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(ivB64) },
    wrappingKey,
    b64ToBuf(ctB64),
  )
  const jwk = JSON.parse(dec.decode(jwkJson)) as JsonWebKey
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits'],
  )
}

// ─────────────────────────── ключи устройства ───────────────────────────

/**
 * Неизвлекаемый ключ устройства. Живёт в IndexedDB и привязан к профилю
 * браузера: скопировать его нельзя, поэтому «запоминание устройства» не
 * превращается в переносимый мастер-пароль.
 */
export async function createDeviceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

// ─────────────────────────── ключи чата ───────────────────────────

export async function generateChatKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])
}

export async function wrapChatKey(chatKey: CryptoKey, wrappingKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', chatKey)
  const iv = randomBytes(12)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, raw)
  return `${toB64(iv)}.${toB64(ct)}`
}

export async function unwrapChatKey(wrapped: string, wrappingKey: CryptoKey): Promise<CryptoKey> {
  const [ivB64, ctB64] = wrapped.split('.')
  if (!ivB64 || !ctB64) throw new Error('Повреждённый ключ чата')
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(ivB64) },
    wrappingKey,
    b64ToBuf(ctB64),
  )
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])
}

// ─────────────────────────── сообщения ───────────────────────────

export interface SealedPayload {
  ciphertext: string
  iv: string
}

export async function sealText(text: string, key: CryptoKey): Promise<SealedPayload> {
  const iv = randomBytes(12)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text))
  return { ciphertext: toB64(ct), iv: toB64(iv) }
}

export async function openText(payload: SealedPayload, key: CryptoKey): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(payload.iv) },
    key,
    b64ToBuf(payload.ciphertext),
  )
  return dec.decode(pt)
}

/** Заголовок AAD связывает шифротекст с чатом и отправителем. */
export async function sealTextAAD(
  text: string,
  key: CryptoKey,
  aad: string,
): Promise<SealedPayload> {
  const iv = randomBytes(12)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(text),
  )
  return { ciphertext: toB64(ct), iv: toB64(iv) }
}

export async function openTextAAD(
  payload: SealedPayload,
  key: CryptoKey,
  aad: string,
): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(payload.iv), additionalData: enc.encode(aad) },
    key,
    b64ToBuf(payload.ciphertext),
  )
  return dec.decode(pt)
}

// ─────────────────────────── файлы ───────────────────────────

export interface SealedFile {
  blob: Blob
  key: CryptoKey
  /** Имя файла шифруется отдельно — сервер его не видит. */
  nameSealed: SealedPayload
  size: number
  type: string
}

/**
 * Заголовок контейнера: 4 байта магии + 4 байта числа блоков + 8 байт префикса IV.
 * Дальше идут блоки шифротекста по (1 МиБ + 16 байт тега GCM).
 */
const HEADER_SIZE = 16

/**
 * Потоковое шифрование файла блоками по 1 МиБ.
 *
 * IV блока = общий случайный префикс (8 байт) + номер блока (4 байта).
 * Номер блока гарантирует уникальность IV внутри файла, а случайный префикс —
 * между разными загрузками. Это то, что требует AES-GCM.
 */
export async function sealFile(file: File, chatKey: CryptoKey): Promise<SealedFile> {
  const fileKey = await generateChatKey()
  const prefix = randomBytes(8)
  const total = Math.max(1, Math.ceil(file.size / FILE_CHUNK))

  const header = new Uint8Array(HEADER_SIZE)
  header.set(enc.encode(FILE_MAGIC), 0)
  const dv = new DataView(header.buffer)
  dv.setUint32(4, total, false)
  header.set(prefix, 8)

  const parts: BlobPart[] = [header]
  for (let i = 0; i < total; i++) {
    const start = i * FILE_CHUNK
    const slice = file.slice(start, Math.min(start + FILE_CHUNK, file.size))
    const buf = await slice.arrayBuffer()
    const iv = chunkIv(prefix, i)
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, fileKey, buf)
    parts.push(new Uint8Array(ct))
  }

  const nameSealed = await sealTextAAD(file.name, chatKey, 'filename')

  return {
    blob: new Blob(parts, { type: 'application/octet-stream' }),
    key: fileKey,
    nameSealed,
    size: file.size,
    type: file.type || 'application/octet-stream',
  }
}

function chunkIv(prefix: Uint8Array, index: number): Bytes {
  const iv = new Uint8Array(12)
  iv.set(prefix, 0)
  new DataView(iv.buffer).setUint32(8, index, false)
  return iv
}

export async function openFile(
  blob: Blob,
  fileKey: CryptoKey,
  originalType: string,
): Promise<Blob> {
  const header = new Uint8Array(await blob.slice(0, HEADER_SIZE).arrayBuffer())
  if (dec.decode(header.subarray(0, 4)) !== FILE_MAGIC) {
    throw new Error('Неизвестный формат файла')
  }
  const total = new DataView(header.buffer, header.byteOffset).getUint32(4, false)
  const prefix = header.slice(8, 16)

  const out: BlobPart[] = []
  for (let i = 0; i < total; i++) {
    const start = HEADER_SIZE + i * (FILE_CHUNK + 16)
    const slice = blob.slice(start, Math.min(start + FILE_CHUNK + 16, blob.size))
    const ct = await slice.arrayBuffer()
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: chunkIv(prefix, i) }, fileKey, ct)
    out.push(pt)
  }
  return new Blob(out, { type: originalType })
}

// ─────────────────────────── отпечаток ключа ───────────────────────────

/** Короткий отпечаток открытого ключа — для сверки вслух. */
export async function fingerprint(publicKeyB64: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', b64ToBuf(publicKeyB64))
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .match(/.{4}/g)!
    .join(' ')
}