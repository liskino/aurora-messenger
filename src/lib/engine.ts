/**
 * Движок мессенджера.
 *
 * Связывает криптоядро, хранилище устройства и Supabase. React-слой только
 * подписывается на события и рисует — вся логика здесь.
 *
 * ─── Как раскладываются ключи чата ───────────────────────────────────
 *
 * У каждого пользователя есть пара ECDH P-256. Для чата генерируется
 * случайный AES-256 ключ. Каждому участнику он выдаётся завёрнутым на
 * секрет ECDH между ЭТИМ участником и СОЗДАТЕЛЕМ чата:
 *
 *     создатель: shared(creator.priv, member.pub)
 *     участник:  shared(member.priv,  creator.pub)   ← тот же самый секрет
 *
 * Поэтому участнику достаточно знать created_by, чтобы снять свою обёртку.
 * Создателю для себя обёртка считается на shared(me.priv, me.pub) — формально
 * это тоже корректный ECDH, и он снимается тем же способом, без исключений
 * в коде.
 *
 * Ключ чата в базе лежит зашифрованным на этот секрет и на сервер в открытом
 * виде не попадает. Сняв один раз, мы пересобираем его на ключ устройства
 * и держим в IndexedDB, поэтому дальше расшифровка мгновенная.
 */
import * as api from './api'
import * as crypto from './crypto'
import * as vault from './vault'
import type { Chat, ChatMember, DecryptedMessage, Message, Profile } from './types'

export interface EngineSession {
  userId: string
  email: string
  profile: Profile
  /** Приватный ключ личности: живёт только в памяти вкладки. */
  privateKey: CryptoKey
  /** Развёрнутые ключи чатов. */
  chatKeys: Map<string, CryptoKey>
  /** Обёртка ключа чата, зашифрованная ключом устройства. */
  localWrapped: Map<string, string>
}

export type EngineEvent =
  | { type: 'message'; chatId: string; message: DecryptedMessage }
  | { type: 'typing'; chatId: string; userId: string }
  | { type: 'chat'; chat: Chat }
  | { type: 'error'; error: Error }

type Listener = (e: EngineEvent) => void

/**
 * AAD привязывает шифротекст к чату и отправителю: переставить сообщение
 * в другой чат или подписать чужим именем не получится.
 */
function aadFor(chatId: string, senderId: string) {
  return `aurora:${chatId}:${senderId}`
}

export class Engine {
  session: EngineSession | null = null
  private listeners = new Set<Listener>()
  private channels = new Map<string, ReturnType<typeof api.supabase.channel>>()
  private messageCache = new Map<string, DecryptedMessage[]>()
  private profiles = new Map<string, Profile>()
  private chatCache = new Map<string, Chat>()
  private membership = new Map<string, ChatMember>()
  /** Дедупликация: realtime и оптимистичная вставка легко приносят одно и то же. */
  private seen = new Set<string>()
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private deviceKeyPromise: Promise<CryptoKey> | null = null

  on(fn: Listener) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(e: EngineEvent) {
    for (const fn of this.listeners) fn(e)
  }

  // ═════════════════════════ вход ═════════════════════════

  /**
   * Регистрация: аккаунт → личность → ключ из пароля → профиль.
   * Профиль с открытым ключом появляется только когда ключи согласованы,
   * иначе собеседник увидел бы аккаунт без ключа шифрования.
   */
  async register(email: string, password: string, username: string, displayName: string) {
    const { user } = await api.signUp(email, password)
    if (!user) throw new Error('Не удалось создать аккаунт')

    const identity = await crypto.generateIdentity()
    const salt = crypto.generateSalt()
    const passwordKey = await crypto.derivePasswordKey(password, salt)
    const wrappedPrivate = await crypto.wrapPrivateKey(identity.privateKey, passwordKey)

    await api.createProfile({
      id: user.id,
      username: username.toLowerCase(),
      display_name: displayName || username,
      public_key: identity.publicKeyB64,
      wrapped_private: wrappedPrivate,
      kdf_salt: salt,
      kdf_iterations: crypto.PBKDF2_ITERATIONS,
    })

    await this.rememberDevice(user.id, wrappedPrivate)

    const profile = await api.getProfile(user.id)
    if (!profile) throw new Error('Профиль не создан')
    this.profiles.set(profile.id, profile)
    this.session = {
      userId: user.id,
      email,
      profile,
      privateKey: identity.privateKey,
      chatKeys: new Map(),
      localWrapped: new Map(),
    }
    await api.touchLastSeen(user.id)
    return this.session
  }

  /**
   * Вход.
   *   1. есть запомненное устройство → ключ берём из IndexedDB, пароль не нужен;
   *   2. устройства нет → разворачиваем ключ паролем и запоминаем устройство.
   */
  async login(email: string, password: string | null) {
    const supa = await api.currentSession()
    if (!supa) throw new Error('Сессия не найдена — войдите заново')

    const profile = await api.getProfile(supa.user.id)
    if (!profile) throw new Error('Профиль не найден')

    const privateKey = await this.unlockPrivateKey(profile, password)

    this.profiles.set(profile.id, profile)
    this.session = {
      userId: supa.user.id,
      email: supa.user.email ?? email,
      profile,
      privateKey,
      chatKeys: new Map(),
      localWrapped: new Map(),
    }
    await api.touchLastSeen(supa.user.id)
    return this.session
  }

  private async unlockPrivateKey(profile: Profile, password: string | null): Promise<CryptoKey> {
    const device = await vault.getDevice(profile.id)
    if (device) {
      try {
        return await crypto.unwrapPrivateKey(device.wrappedPrivate, device.key)
      } catch {
        // Ключ устройства испорчен или хранилище очищено — просим пароль заново.
        await vault.forgetDevice(profile.id)
      }
    }

    if (!password) throw new Error('Это устройство не запомнено — введите пароль')

    const passwordKey = await crypto.derivePasswordKey(
      password,
      profile.kdf_salt,
      profile.kdf_iterations,
    )
    let privateKey: CryptoKey
    try {
      privateKey = await crypto.unwrapPrivateKey(profile.wrapped_private, passwordKey)
    } catch {
      throw new Error('Неверный пароль')
    }
    await this.rememberDevice(profile.id, profile.wrapped_private)
    return privateKey
  }

  /**
   * Автовход при открытии страницы: сессия Supabase жива и устройство
   * запомнено — пользователь ничего не вводит.
   */
  async resume(): Promise<EngineSession | null> {
    const supa = await api.currentSession()
    if (!supa) return null

    const device = await vault.getDevice(supa.user.id)
    if (!device) return null

    try {
      const privateKey = await crypto.unwrapPrivateKey(device.wrappedPrivate, device.key)
      const profile = await api.getProfile(supa.user.id)
      if (!profile) return null
      this.profiles.set(profile.id, profile)
      this.session = {
        userId: supa.user.id,
        email: supa.user.email ?? '',
        profile,
        privateKey,
        chatKeys: new Map(),
        localWrapped: new Map(),
      }
      await api.touchLastSeen(supa.user.id)
      return this.session
    } catch {
      return null
    }
  }

  /** Создаёт неизвлекаемый ключ устройства и оборачивает им приватный ключ. */
  private async rememberDevice(userId: string, wrappedPrivate: string) {
    const deviceKey = await crypto.createDeviceKey()
    await vault.putDeviceKey(userId, deviceKey, wrappedPrivate)
    this.deviceKeyPromise = Promise.resolve(deviceKey)
  }

  async logout() {
    if (this.session) await vault.forgetDevice(this.session.userId)
    for (const ch of this.channels.values()) api.supabase.removeChannel(ch)
    this.channels.clear()
    this.messageCache.clear()
    this.profiles.clear()
    this.chatCache.clear()
    this.membership.clear()
    this.seen.clear()
    this.deviceKeyPromise = null
    this.session = null
    await api.signOut()
  }

  async devices() {
    if (!this.session) return []
    return api.listDevices(this.session.userId)
  }

  async forgetThisDevice() {
    if (!this.session) return
    this.deviceKeyPromise = null
    await vault.forgetDevice(this.session.userId)
  }

  // ═════════════════════════ ключи чатов ═════════════════════════

  private async deviceKey(): Promise<CryptoKey> {
    if (!this.deviceKeyPromise) {
      this.deviceKeyPromise = (async () => {
        const d = await vault.getDevice(this.session!.userId)
        if (!d) throw new Error('Устройство не запомнено — войдите с паролем')
        return d.key
      })()
    }
    return this.deviceKeyPromise
  }

  /** Обёртка ключа чата для участника M: секрет ECDH(M, создатель). */
  private async wrapFor(chatKey: CryptoKey, memberPublicKey: string): Promise<string> {
    const shared = await crypto.deriveSharedKey(this.session!.privateKey, memberPublicKey)
    return crypto.wrapChatKey(chatKey, shared)
  }

  /**
   * Ключ чата для чтения и записи.
   *
   * Порядок: память → IndexedDB (обёртка на ключе устройства) → своя обёртка
   * из базы, снятая через ECDH с создателем чата. Третий шаг выполняется один
   * раз за чат, после чего ключ живёт локально и расшифровка мгновенная.
   */
  async keyForChat(chatId: string): Promise<CryptoKey> {
    const me = this.session
    if (!me) throw new Error('Нет активной сессии')

    const inMemory = me.chatKeys.get(chatId)
    if (inMemory) return inMemory

    const local = me.localWrapped.get(chatId) ?? (await vault.getCachedChatKey(chatId))
    if (local) {
      try {
        const key = await crypto.unwrapChatKey(local, await this.deviceKey())
        me.chatKeys.set(chatId, key)
        me.localWrapped.set(chatId, local)
        return key
      } catch {
        await vault.dropChatKey(chatId)
        me.localWrapped.delete(chatId)
      }
    }

    const row = await this.membershipRow(chatId)
    const chat = await this.chatById(chatId)
    const creator = await this.profileById(chat.created_by)
    if (!creator) throw new Error('Создатель чата не найден')

    const shared = await crypto.deriveSharedKey(me.privateKey, creator.public_key)
    let key: CryptoKey
    try {
      key = await crypto.unwrapChatKey(row.wrapped_key, shared)
    } catch {
      throw new Error('Не удалось развернуть ключ чата: он выдан на другое устройство')
    }

    const localWrap = await crypto.wrapChatKey(key, await this.deviceKey())
    await vault.cacheChatKey(chatId, localWrap)
    me.chatKeys.set(chatId, key)
    me.localWrapped.set(chatId, localWrap)
    return key
  }

  private async membershipRow(chatId: string): Promise<ChatMember> {
    const cached = this.membership.get(chatId)
    if (cached) return cached
    const rows = await api.getMyMemberships(this.session!.userId)
    for (const r of rows) this.membership.set(r.chat_id, r)
    const row = this.membership.get(chatId)
    if (!row) throw new Error('Вы не участник этого чата')
    return row
  }

  private async chatById(chatId: string): Promise<Chat> {
    const cached = this.chatCache.get(chatId)
    if (cached) return cached
    const [chat] = await api.getChatsByIds([chatId])
    if (!chat) throw new Error('Чат не найден')
    this.chatCache.set(chatId, chat)
    return chat
  }

  private async profileById(id: string): Promise<Profile | null> {
    const cached = this.profiles.get(id)
    if (cached) return cached
    const p = await api.getProfile(id)
    if (p) this.profiles.set(id, p)
    return p
  }

  // ═════════════════════════ чаты ═════════════════════════

  /**
   * Создаёт чат и раскладывает ключ чата каждому участнику.
   * Личный чат — двое участников, группа — трое и больше.
   */
  async createChat(members: Profile[], title: string | null = null): Promise<Chat> {
    const me = this.session!
    const others = members.filter((m) => m.id !== me.userId)
    const all = [me.profile, ...others]
    const kind = all.length > 2 ? 'group' : 'direct'

    const chat = await api.createChat(kind, title, me.userId)
    this.chatCache.set(chat.id, chat)

    const chatKey = await crypto.generateChatKey()
    const rows = await Promise.all(
      all.map(async (member) => ({
        chat_id: chat.id,
        user_id: member.id,
        // Для себя считаем секрет ECDH со своим же открытым ключом —
        // он снимается тем же кодом, что и у остальных участников.
        wrapped_key: await this.wrapFor(chatKey, member.public_key),
      })),
    )
    await api.upsertMembers(rows)

    for (const r of rows) {
      if (r.user_id === me.userId) this.membership.set(chat.id, r as ChatMember)
    }
    me.chatKeys.set(chat.id, chatKey)
    const localWrap = await crypto.wrapChatKey(chatKey, await this.deviceKey())
    me.localWrapped.set(chat.id, localWrap)
    await vault.cacheChatKey(chat.id, localWrap)

    this.emit({ type: 'chat', chat })
    return chat
  }

  /** Открывает личный чат, переиспользуя существующий, если он уже есть. */
  async startDirectChat(peer: Profile): Promise<Chat> {
    const existing = await this.findDirectChat(peer.id)
    if (existing) return existing
    return this.createChat([peer])
  }

  /**
   * Поиск уже существующего личного чата: сервер не сравнивает составы
   * приватных чатов за нас, поэтому сверяем локально.
   */
  private async findDirectChat(peerId: string): Promise<Chat | null> {
    const me = this.session!
    const mine = await api.getMyMemberships(me.userId)
    for (const r of mine) this.membership.set(r.chat_id, r)

    const chats = await api.getChatsByIds(mine.map((m) => m.chat_id))
    for (const c of chats) this.chatCache.set(c.id, c)

    const direct = chats.filter((c) => c.kind === 'direct')
    if (!direct.length) return null

    const members = await api.getMembers(direct.map((c) => c.id))
    for (const c of direct) {
      const ids = members.filter((m) => m.chat_id === c.id).map((m) => m.user_id)
      if (ids.length === 2 && ids.includes(peerId)) return c
    }
    return null
  }

  /** Список чатов с собеседниками и последним сообщением. */
  async listChats(): Promise<Chat[]> {
    const me = this.session!
    const mine = await api.getMyMemberships(me.userId)
    for (const r of mine) this.membership.set(r.chat_id, r)

    const chats = await api.getChatsByIds(mine.map((m) => m.chat_id))
    for (const c of chats) this.chatCache.set(c.id, c)

    const members = await api.getMembers(chats.map((c) => c.id))
    const profileIds = [...new Set(members.map((m) => m.user_id))]
    const profiles = await api.getProfilesByIds(profileIds)
    for (const p of profiles) this.profiles.set(p.id, p)

    return chats.sort((a, b) => b.created_at.localeCompare(a.created_at))
  }

  /** Профили участников чата — нужны для шапки и аватаров. */
  async chatMembers(chatId: string): Promise<Profile[]> {
    const members = await api.getMembers([chatId])
    const missing = members.map((m) => m.user_id).filter((id) => !this.profiles.has(id))
    if (missing.length) {
      for (const p of await api.getProfilesByIds(missing)) this.profiles.set(p.id, p)
    }
    return members
      .map((m) => this.profiles.get(m.user_id))
      .filter((p): p is Profile => Boolean(p))
  }

  /** Собеседник личного чата. */
  async peerOf(chatId: string): Promise<Profile | undefined> {
    const chat = await this.chatById(chatId)
    if (chat.kind !== 'direct') return undefined
    const members = await this.chatMembers(chatId)
    return members.find((m) => m.id !== this.session!.userId)
  }

  // ═════════════════════════ сообщения ═════════════════════════

  private pushToCache(chatId: string, msg: DecryptedMessage) {
    const cache = this.messageCache.get(chatId) ?? []
    cache.push(msg)
    cache.sort((a, b) => a.created_at.localeCompare(b.created_at))
    this.messageCache.set(chatId, cache)
  }

  async decryptOne(m: Message, key: CryptoKey): Promise<DecryptedMessage> {
    try {
      const text = await crypto.openTextAAD(
        { ciphertext: m.ciphertext, iv: m.iv },
        key,
        aadFor(m.chat_id, m.sender_id),
      )
      let fileName: string | undefined
      if (m.file_name_sealed && m.file_name_iv) {
        try {
          fileName = await crypto.openTextAAD(
            { ciphertext: m.file_name_sealed, iv: m.file_name_iv },
            key,
            'filename',
          )
        } catch {
          fileName = 'зашифрованный файл'
        }
      }
      return { ...m, text, fileName }
    } catch {
      return { ...m, text: '', failed: true }
    }
  }

  /** Параллельная расшифровка пачки — важна для скорости открытия чата. */
  async decryptMany(messages: Message[], chatId: string): Promise<DecryptedMessage[]> {
    if (!messages.length) return []
    const key = await this.keyForChat(chatId)
    const fresh = messages.filter((m) => !this.seen.has(m.id))
    const decrypted = await Promise.all(fresh.map((m) => this.decryptOne(m, key)))
    for (const m of decrypted) this.seen.add(m.id)
    return decrypted
  }

  /** Отправка текста: шифруем локально, на сервер уходит только шифротекст. */
  async sendText(chatId: string, text: string): Promise<DecryptedMessage> {
    const me = this.session!
    const key = await this.keyForChat(chatId)
    const sealed = await crypto.sealTextAAD(text, key, aadFor(chatId, me.userId))

    const row = await api.sendMessage({
      chat_id: chatId,
      sender_id: me.userId,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      kind: 'text',
    })

    const msg: DecryptedMessage = { ...row, text }
    this.seen.add(row.id)
    this.pushToCache(chatId, msg)
    this.emit({ type: 'message', chatId, message: msg })
    return msg
  }

  /**
   * Отправка файла: шифруем потоком блоками по 1 МиБ, в Storage лежит
   * только шифротекст. Имя файла тоже зашифровано.
   */
  async sendFile(
    chatId: string,
    file: File,
    onProgress?: (r: number) => void,
  ): Promise<DecryptedMessage> {
    const me = this.session!
    const key = await this.keyForChat(chatId)
    const sealed = await crypto.sealFile(file, key)

    const path = `${chatId}/${crypto.toB64(crypto.randomBytes(16)).replace(/[+/=]/g, '')}.bin`
    await api.uploadEncrypted(path, sealed.blob, onProgress)

    const wrappedFileKey = await crypto.wrapChatKey(sealed.key, key)
    const row = await api.sendMessage({
      chat_id: chatId,
      sender_id: me.userId,
      ciphertext: '',
      iv: '',
      kind: 'file',
      file_path: path,
      file_name_sealed: sealed.nameSealed.ciphertext,
      file_name_iv: sealed.nameSealed.iv,
      file_type: sealed.type,
      file_size: file.size,
      wrapped_file_key: wrappedFileKey,
    })

    const msg: DecryptedMessage = { ...row, text: '', fileName: file.name }
    this.seen.add(row.id)
    this.pushToCache(chatId, msg)
    this.emit({ type: 'message', chatId, message: msg })
    return msg
  }

  /** Скачивание и расшифровка файла на устройстве. */
  async downloadFile(m: DecryptedMessage): Promise<Blob> {
    if (!m.file_path || !m.wrapped_file_key) throw new Error('Сообщение без файла')
    const chatKey = await this.keyForChat(m.chat_id)
    const fileKey = await crypto.unwrapChatKey(m.wrapped_file_key, chatKey)
    const blob = await api.downloadEncrypted(m.file_path)
    return crypto.openFile(blob, fileKey, m.file_type ?? 'application/octet-stream')
  }

  async loadHistory(chatId: string): Promise<DecryptedMessage[]> {
    const rows = await api.fetchMessages(chatId)
    const decrypted = await this.decryptMany(rows, chatId)

    const merged = [...(this.messageCache.get(chatId) ?? [])]
    const known = new Set(merged.map((m) => m.id))
    for (const m of decrypted) if (!known.has(m.id)) merged.push(m)
    merged.sort((a, b) => a.created_at.localeCompare(b.created_at))
    this.messageCache.set(chatId, merged)

    const incoming = rows.filter((r) => r.sender_id !== this.session!.userId).map((r) => r.id)
    if (incoming.length) void api.markDelivered(incoming, this.session!.userId)
    return merged
  }

  // ═════════════════════════ realtime ═════════════════════════

  /** Подписка на чат: новые сообщения и «печатает». */
  subscribeChat(chatId: string) {
    if (this.channels.has(chatId)) return
    const me = this.session
    if (!me) return

    const channel = api.supabase
      .channel(`chat:${chatId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${chatId}` },
        async ({ new: row }) => {
          const m = row as Message
          if (this.seen.has(m.id)) return
          const key = await this.keyForChat(chatId)
          const msg = await this.decryptOne(m, key)
          this.seen.add(m.id)
          this.pushToCache(chatId, msg)
          this.emit({ type: 'message', chatId, message: msg })
          if (m.sender_id !== this.session!.userId) {
            void api.markDelivered([m.id], this.session!.userId)
          }
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'typing', filter: `chat_id=eq.${chatId}` },
        ({ new: row }) => {
          const r = row as { user_id?: string } | null
          if (!r?.user_id || r.user_id === this.session?.userId) return
          this.emit({ type: 'typing', chatId, userId: r.user_id })
        },
      )
      .subscribe()

    this.channels.set(chatId, channel)
  }

  unsubscribeChat(chatId: string) {
    const ch = this.channels.get(chatId)
    if (ch) {
      api.supabase.removeChannel(ch)
      this.channels.delete(chatId)
    }
  }

  /** «Печатает» с троттлингом: не чаще одной записи в 3 секунды на чат. */
  noteTyping(chatId: string) {
    if (!this.session) return
    const key = `${chatId}:${this.session.userId}`
    if (this.typingTimers.has(key)) return

    void api.setTyping(chatId, this.session.userId)
    const timer = setTimeout(() => {
      this.typingTimers.delete(key)
      if (this.session) void api.clearTyping(chatId, this.session.userId)
    }, 3000)
    this.typingTimers.set(key, timer)
  }

  async markChatRead(chatId: string) {
    const me = this.session
    if (!me) return
    const incoming = (this.messageCache.get(chatId) ?? [])
      .filter((m) => m.sender_id !== me.userId)
      .map((m) => m.id)
    if (incoming.length) await api.markRead(incoming, me.userId)
  }

  cachedMessages(chatId: string): DecryptedMessage[] {
    return this.messageCache.get(chatId) ?? []
  }

  // ═════════════════════════ производительность ═════════════════════════

  /** Замер реальных скоростей: шифрование, KDF, ключи, RTT до сервера. */
  async benchmark() {
    const results: Record<string, number> = {}
    const key = await crypto.generateChatKey()

    const run = async (n: number, fn: () => Promise<unknown>) => {
      const t0 = performance.now()
      for (let i = 0; i < n; i++) await fn()
      return (performance.now() - t0) / n
    }

    const small = 'x'.repeat(256)
    const large = 'y'.repeat(8192)

    results.seal_256B = await run(50, () => crypto.sealText(small, key))
    results.seal_8KB = await run(20, () => crypto.sealText(large, key))

    const sealed = await crypto.sealText(small, key)
    results.open_256B = await run(50, () => crypto.openText(sealed, key))

    results.keygen_ecdh = await run(5, () => crypto.generateIdentity())
    results.pbkdf2_600k = await run(1, () =>
      crypto.derivePasswordKey('benchmark', crypto.generateSalt(), crypto.PBKDF2_ITERATIONS),
    )

    const peer = await crypto.generateIdentity()
    const shared = await crypto.deriveSharedKey(
      (await crypto.generateIdentity()).privateKey,
      peer.publicKeyB64,
    )
    results.wrap_chatkey = await run(20, () => crypto.wrapChatKey(key, shared))

    try {
      results.server_rtt = await api.measureRtt()
    } catch {
      results.server_rtt = -1
    }

    return results
  }
}

export const engine = new Engine()