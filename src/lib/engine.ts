/**
 * Движок мессенджера.
 *
 * Связывает криптоядро, хранилище устройства и сервер. React-слой только
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
import { loadIceServers } from './rtc'
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
  | { type: 'deleted'; chatId: string; messageId: string }
  | { type: 'edited'; chatId: string; message: DecryptedMessage }
  | { type: 'reactions'; chatId: string; messageId: string }
  | { type: 'receipts'; chatId: string }
  | { type: 'presence' }
  | { type: 'removed'; chatId: string }
  | { type: 'call'; payload: unknown }
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
  /** Отписка от потока событий сервера — одно соединение на приложение. */
  private eventsOff: (() => void) | null = null
  /** Чат, открытый сейчас: нужен для адресации точечных обновлений. */
  private lastChatId: string | null = null
  /** Чат, в котором слушаются входящие звонки. */
  private callChatId: string | null = null
  private messageCache = new Map<string, DecryptedMessage[]>()
  private profiles = new Map<string, Profile>()
  private chatCache = new Map<string, Chat>()
  private membership = new Map<string, ChatMember>()
  /** Дедупликация: realtime и оптимистичная вставка легко приносят одно и то же. */
  private seen = new Set<string>()
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private deviceKeyPromise: Promise<CryptoKey> | null = null
  /** Реакции: messageId → (userId → эмодзи). */
  private reactions = new Map<string, Map<string, string>>()
  /** Кто сейчас в сети. */
  private online = new Set<string>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  /** Отметки доставки и прочтения: messageId → состояние. */
  private receipts = new Map<string, { delivered: boolean; read: boolean }>()
  /** Идентификатор записи этого устройства — для отметки присутствия. */
  deviceId: string | null = null

  on(fn: Listener) {
    this.listeners.add(fn)
    // Возвращаем именно void-функцию: React-эффект не примет функцию,
    // возвращающую значение, — иначе он станет функцией очистки странного вида.
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit(e: EngineEvent) {
    for (const fn of this.listeners) fn(e)
  }

  // ═════════════════════════ вход ═════════════════════════

  /**
   * Регистрация: сначала ключи, потом аккаунт.
   *
   * Порядок именно такой: сервер принимает ключи вместе с регистрацией,
   * поэтому профиль не может появиться без открытого ключа. Иначе собеседник
   * увидел бы аккаунт, которому нельзя отправить зашифрованное сообщение.
   */
  async register(email: string, password: string, username: string, displayName: string) {
    const identity = await crypto.generateIdentity()
    const salt = crypto.generateSalt()
    const passwordKey = await crypto.derivePasswordKey(password, salt)
    const wrappedPrivate = await crypto.wrapPrivateKey(identity.privateKey, passwordKey)

    const result = await api.register({
      email,
      password,
      username: username.toLowerCase(),
      display_name: displayName || username,
      public_key: identity.publicKeyB64,
      wrapped_private: wrappedPrivate,
      kdf_salt: salt,
      kdf_iterations: crypto.PBKDF2_ITERATIONS,
    })

    await this.rememberDevice(result.user.id, identity.privateKey)

    this.profiles.set(result.profile.id, result.profile)
    this.session = {
      userId: result.user.id,
      email: result.user.email,
      profile: result.profile,
      privateKey: identity.privateKey,
      chatKeys: new Map(),
      localWrapped: new Map(),
    }
    await this.beginSession()
    return this.session
  }

  /**
   * Вход.
   *   1. есть запомненное устройство → ключ берём из IndexedDB, пароль не нужен;
   *   2. устройства нет → разворачиваем ключ паролем и запоминаем устройство.
   */
  async login(email: string, password: string | null) {
    // Пароль нужен серверу только для входа в аккаунт. Ключ шифрования
    // выводится из него отдельно, в браузере, и на сервер не уходит.
    if (!password) {
      const existing = await api.currentSession()
      if (!existing) throw new Error('Сессия истекла — введите пароль')
      const privateKey = await this.unlockPrivateKey(existing.profile, null)
      this.profiles.set(existing.profile.id, existing.profile)
      this.session = {
        userId: existing.user.id,
        email: existing.user.email,
        profile: existing.profile,
        privateKey,
        chatKeys: new Map(),
        localWrapped: new Map(),
      }
      await this.beginSession()
      return this.session
    }

    const result = await api.login(email, password)
    const privateKey = await this.unlockPrivateKey(result.profile, password)

    this.profiles.set(result.profile.id, result.profile)
    this.session = {
      userId: result.user.id,
      email: result.user.email,
      profile: result.profile,
      privateKey,
      chatKeys: new Map(),
      localWrapped: new Map(),
    }
    await this.beginSession()
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
    await this.rememberDevice(profile.id, privateKey)
    return privateKey
  }

  /**
   * Автовход при открытии страницы: сессия сервера жива и устройство
   * запомнено — пользователь ничего не вводит.
   */
  async resume(): Promise<EngineSession | null> {
    const existing = await api.currentSession()
    if (!existing) return null

    const device = await vault.getDevice(existing.user.id)
    if (!device) return null

    try {
      const privateKey = await crypto.unwrapPrivateKey(device.wrappedPrivate, device.key)
      this.profiles.set(existing.profile.id, existing.profile)
      this.session = {
        userId: existing.user.id,
        email: existing.user.email,
        profile: existing.profile,
        privateKey,
        chatKeys: new Map(),
        localWrapped: new Map(),
      }
      await this.beginSession()
      return this.session
    } catch {
      // Автовход не удался — человек увидит обычный экран входа
      // и сможет ввести пароль. Ломать из-за этого приложение нельзя.
      return null
    }
  }

  /**
   * Запоминает устройство: пересобирает обёртку приватного ключа на ключ
   * устройства и кладёт её в IndexedDB.
   *
   * Здесь была ошибка, из-за которой вход без пароля не работал вообще.
   * Раньше сюда передавалась обёртка, сделанная на ключ ИЗ ПАРОЛЯ, а рядом
   * сохранялся ключ устройства — и при следующем запуске ключ пытались снять
   * ключом устройства. Эти два ключа друг о друге ничего не знают, поэтому
   * расшифровка всегда срывалась, и человек каждый раз вводил пароль заново.
   *
   * Правильно: взять сам приватный ключ и заново зашифровать его ключом
   * устройства. Ключ из пароля остаётся только на сервере — как резервная
   * копия для входа с нового устройства.
   */
  private async rememberDevice(userId: string, privateKey: CryptoKey) {
    const deviceKey = await crypto.createDeviceKey()
    const wrappedForDevice = await crypto.wrapPrivateKey(privateKey, deviceKey)
    await vault.putDeviceKey(userId, deviceKey, wrappedForDevice)
    this.deviceKeyPromise = Promise.resolve(deviceKey)
  }

  /**
   * Регистрирует это устройство в аккаунте и оживляет присутствие.
   *
   * Вызывается после успешного входа: список устройств нужен человеку,
   * чтобы видеть, где ещё открыт мессенджер, а присутствие — чтобы
   * собеседник знал, что он не пишет в пустоту.
   */
  private async beginSession() {
    const me = this.session
    if (!me) return

    try {
      const device = await api.registerDevice(me.userId, api.deviceLabel())
      this.deviceId = device.id
    } catch {
      // Список устройств — вспомогательная функция, вход из-за неё не срываем.
    }

    // Настройки ICE загружаем при входе: сервер отдаёт встроенный TURN
    // с готовыми учётными данными, чтобы звонки работали из любой сети
    // без ручной настройки.
    void loadIceServers()

    this.startPresence()

    // Отметку присутствия обновляем редко: чаще нет смысла, а нагрузка растёт.
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        if (this.deviceId) void api.heartbeat(this.deviceId)
      }, 60_000)
    }
    void api.touchLastSeen(me.userId)
  }

  async logout() {
    if (this.session) await vault.forgetDevice(this.session.userId)

    // Закрываем поток событий до выхода: иначе сервер продолжит слать
    // события уже вышедшему клиенту.
    if (this.eventsOff) {
      this.eventsOff()
      this.eventsOff = null
    }
    api.closeEvents()

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.messageCache.clear()
    this.profiles.clear()
    this.chatCache.clear()
    this.membership.clear()
    this.reactions.clear()
    this.online.clear()
    this.seen.clear()
    this.deviceKeyPromise = null
    this.deviceId = null
    this.lastChatId = null
    this.callChatId = null
    this.session = null
    await api.logout()
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
   *
   * Ключи считаются ДО обращения к серверу и передаются вместе с созданием:
   * чат не может существовать без выданных ключей, иначе собеседник увидел бы
   * переписку, которую невозможно прочитать.
   */
  async createChat(members: Profile[], title: string | null = null): Promise<Chat> {
    const me = this.session!
    const others = members.filter((m) => m.id !== me.userId)
    const all = [me.profile, ...others]
    const kind = all.length > 2 ? 'group' : 'direct'

    const chatKey = await crypto.generateChatKey()
    const memberRows = await Promise.all(
      all.map(async (member) => ({
        user_id: member.id,
        // Для себя считаем секрет ECDH со своим же открытым ключом —
        // он снимается тем же кодом, что и у остальных участников.
        wrapped_key: await this.wrapFor(chatKey, member.public_key),
      })),
    )

    const chat = await api.createChat(kind, title, me.userId, memberRows)
    this.chatCache.set(chat.id, chat)

    for (const r of memberRows) {
      if (r.user_id === me.userId) {
        this.membership.set(chat.id, { ...r, chat_id: chat.id, joined_at: new Date().toISOString() })
      }
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
      // У файловых сообщений текстового шифротекста нет: содержимое шифруется
      // отдельно блоками, а ciphertext пуст. Пытаться «расшифровать пустоту»
      // нельзя — GCM упадёт на проверке тега, и файл пометится нерасшифрованным.
      let text = ''
      if (m.kind !== 'file' && m.ciphertext) {
        text = await crypto.openTextAAD(
          { ciphertext: m.ciphertext, iv: m.iv },
          key,
          aadFor(m.chat_id, m.sender_id),
        )
      }
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
   * Отправка файла: шифруем блоками по 1 МиБ, на сервере лежит только
   * шифротекст. Имя файла шифруется отдельно и серверу не видно.
   *
   * Путь назначает сервер: раньше его придумывал клиент, и два человека
   * теоретически могли занять одно имя.
   */
  async sendFile(
    chatId: string,
    file: File,
    onProgress?: (r: number) => void,
  ): Promise<DecryptedMessage> {
    const me = this.session!
    const key = await this.keyForChat(chatId)
    const sealed = await crypto.sealFile(file, key)

    const uploaded = await api.uploadEncrypted(chatId, sealed.blob, onProgress)

    const wrappedFileKey = await crypto.wrapChatKey(sealed.key, key)
    const row = await api.sendMessage({
      chat_id: chatId,
      sender_id: me.userId,
      ciphertext: '',
      iv: '',
      kind: 'file',
      file_path: uploaded.path,
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

  /**
   * Единая подписка на события сервера.
   *
   * Вместо канала на каждый чат — одно соединение на приложение: сообщения,
   * реакции, отметки, «печатает», присутствие и служебные сообщения звонков
   * приходят по нему. Меньше соединений — меньше нагрузки и на сервер, и на
   * браузер, а переподключение после перезапуска сервера берёт на себя
   * клиентский слой API.
   *
   * Обработчики намеренно не зависят от открытого чата: сообщение для любого
   * чата из списка должно попасть в кэш и увеличить счётчик непрочитанных.
   */
  subscribeChat(chatId: string) {
    this.lastChatId = chatId
    this.ensureEvents()
  }

  private ensureEvents() {
    if (!this.session || this.eventsOff) return

    this.eventsOff = api.subscribeEvents(
      {
        onMessage: (row) => void this.handleIncoming(row),
        onMessageUpdated: (row) => void this.handleUpdated(row),
        onMessageDeleted: (id, chatId) => {
          const list = (this.messageCache.get(chatId) ?? []).filter((m) => m.id !== id)
          this.messageCache.set(chatId, list)
          this.seen.delete(id)
          this.emit({ type: 'deleted', chatId, messageId: id })
        },
        onTyping: (chatId, userId) => {
          if (!userId || userId === this.session?.userId) return
          this.emit({ type: 'typing', chatId, userId })
        },
        onReceipt: (receipts) => {
          let touchedChat = ''
          for (const r of receipts) {
            // Свои отметки пропускаем: они говорят о том, что читаем мы.
            if (r.user_id === this.session?.userId) continue
            const prev = this.receipts.get(r.message_id) ?? { delivered: false, read: false }
            this.receipts.set(r.message_id, {
              delivered: prev.delivered || Boolean(r.delivered_at),
              read: prev.read || Boolean(r.read_at),
            })
            touchedChat ||= this.chatIdOfMessage(r.message_id)
          }
          this.emit({ type: 'receipts', chatId: touchedChat })
        },
        onReaction: (messageId, userId, emoji) => {
          const set = this.reactions.get(messageId) ?? new Map<string, string>()
          if (emoji) set.set(userId, emoji)
          else set.delete(userId)
          if (set.size) this.reactions.set(messageId, set)
          else this.reactions.delete(messageId)
          this.emit({ type: 'reactions', chatId: this.chatIdOfMessage(messageId), messageId })
        },
        onPresence: (online) => {
          this.online = new Set(online)
          this.emit({ type: 'presence' })
        },
        onChat: (chat) => {
          this.chatCache.set(chat.id, chat)
          this.emit({ type: 'chat', chat })
        },
        onRemoved: (chatId) => {
          // Нас исключили из чата: убираем его и забываем ключ.
          this.chatCache.delete(chatId)
          this.messageCache.delete(chatId)
          this.session?.chatKeys.delete(chatId)
          this.session?.localWrapped.delete(chatId)
          void vault.dropChatKey(chatId)
          this.emit({ type: 'removed', chatId })
        },
        onCall: (payload) => {
          this.emit({ type: 'call', payload })
        },
      },
      this.callChatId,
    )
  }

  /** В каком чате находится сообщение — нужно для точечных обновлений. */
  private chatIdOfMessage(messageId: string): string {
    for (const [chatId, list] of this.messageCache) {
      if (list.some((m) => m.id === messageId)) return chatId
    }
    return this.lastChatId ?? ''
  }

  /** Расшифровывает пришедшее сообщение и раскладывает его по кэшам. */
  private async handleIncoming(row: Message) {
    const me = this.session
    if (!me || this.seen.has(row.id)) return

    const chatId = row.chat_id
    let msg: DecryptedMessage
    try {
      const key = await this.keyForChat(chatId)
      msg = await this.decryptOne(row, key)
    } catch {
      // Ключа чата ещё нет — обычная ситуация, когда чат только что создали.
      // Показываем сообщение как нерасшифрованное, но не теряем его.
      msg = { ...row, text: '', failed: true }
    }

    this.seen.add(row.id)
    this.pushToCache(chatId, msg)
    this.emit({ type: 'message', chatId, message: msg })

    if (row.sender_id !== me.userId) {
      void api.markDelivered([row.id], me.userId).then(() => {
        this.receipts.set(row.id, { delivered: true, read: false })
      })
    }
  }

  private async handleUpdated(row: Message) {
    if (!this.seen.has(row.id)) return
    const chatId = row.chat_id
    try {
      const key = await this.keyForChat(chatId)
      const msg = await this.decryptOne(row, key)
      const list = (this.messageCache.get(chatId) ?? []).map((x) => (x.id === row.id ? msg : x))
      this.messageCache.set(chatId, list)
      this.emit({ type: 'edited', chatId, message: msg })
    } catch {
      /* правка не расшифровалась — оставляем прежний текст */
    }
  }

  /**
   * Сообщает серверу, в каком чате слушать входящие звонки.
   * Переподключение потока делается только при реальной смене чата:
   * сообщения и так приходят для всех чатов сразу.
   */
  setCallChat(chatId: string | null) {
    if (this.callChatId === chatId) return
    this.callChatId = chatId
    if (this.session && this.eventsOff) {
      this.eventsOff()
      this.eventsOff = null
      this.ensureEvents()
    }
  }

  /** Отдельных подписок на чат больше нет: поток один на всё приложение. */
  unsubscribeChat(_chatId: string) {
    /* метод оставлен, чтобы вызывающий код не пришлось переписывать */
  }

  /** Шлёт служебное сообщение звонка другим участникам чата. */
  async sendCallSignal(chatId: string, payload: unknown): Promise<number> {
    return api.sendCallSignal(chatId, payload)
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
    if (!incoming.length) return
    await api.markRead(incoming, me.userId)
    // Локально помечаем прочитанными сразу: ждать ответа сервера для галочки
    // в интерфейсе незачем.
    for (const id of incoming) this.receipts.set(id, { delivered: true, read: true })
    this.emit({ type: 'receipts', chatId })
  }

  /** Загружает отметки доставки и прочтения для истории чата. */
  async loadReceipts(chatId: string): Promise<void> {
    const me = this.session
    if (!me) return
    const ids = (this.messageCache.get(chatId) ?? []).map((m) => m.id)
    if (!ids.length) return
    const rows = await api.fetchReceipts(ids)
    for (const r of rows) {
      if (r.user_id === me.userId) continue // свои отметки не считаются
      const prev = this.receipts.get(r.message_id) ?? { delivered: false, read: false }
      this.receipts.set(r.message_id, {
        delivered: prev.delivered || Boolean(r.delivered_at),
        read: prev.read || Boolean(r.read_at),
      })
    }
    this.emit({ type: 'receipts', chatId })
  }

  /** Доставлено ли моё сообщение собеседнику. */
  isDelivered(messageId: string): boolean {
    return this.receipts.get(messageId)?.delivered ?? false
  }

  /** Прочитано ли моё сообщение. */
  isRead(messageId: string): boolean {
    return this.receipts.get(messageId)?.read ?? false
  }

  /** Сколько непрочитанных в чате — для счётчика в списке. */
  unreadCount(chatId: string): number {
    const me = this.session
    if (!me) return 0
    return (this.messageCache.get(chatId) ?? []).filter(
      (m) => m.sender_id !== me.userId && !this.receipts.get(m.id)?.read,
    ).length
  }

  cachedMessages(chatId: string): DecryptedMessage[] {
    return this.messageCache.get(chatId) ?? []
  }

  // ═════════════════════════ редактирование и удаление ═════════════════════════

  /** Удалить своё сообщение. */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    const me = this.session
    if (!me) throw new Error('Нет активной сессии')

    const cached = this.messageCache.get(chatId)?.find((m) => m.id === messageId)
    if (cached && cached.sender_id !== me.userId) {
      throw new Error('Можно удалять только свои сообщения')
    }

    await api.deleteMessage(messageId)
    this.seen.delete(messageId)
    const list = (this.messageCache.get(chatId) ?? []).filter((m) => m.id !== messageId)
    this.messageCache.set(chatId, list)
    this.emit({ type: 'deleted', chatId, messageId })
  }

  /** Изменить текст своего сообщения: шифруем заново, старый шифротекст стираем. */
  async editMessage(chatId: string, messageId: string, newText: string): Promise<void> {
    const me = this.session
    if (!me) throw new Error('Нет активной сессии')

    const cached = this.messageCache.get(chatId)?.find((m) => m.id === messageId)
    if (!cached) throw new Error('Сообщение не найдено')
    if (cached.sender_id !== me.userId) throw new Error('Можно изменять только свои сообщения')

    const key = await this.keyForChat(chatId)
    const sealed = await crypto.sealTextAAD(newText, key, aadFor(chatId, me.userId))

    // Старый шифротекст стирается на сервере: иначе изменённый текст
    // остался бы в базе в прежнем виде.
    await api.editMessage(messageId, sealed.ciphertext, sealed.iv)

    const updated: DecryptedMessage = {
      ...cached,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      text: newText,
      edited_at: new Date().toISOString(),
    }
    const list = (this.messageCache.get(chatId) ?? []).map((m) => (m.id === messageId ? updated : m))
    this.messageCache.set(chatId, list)
    this.emit({ type: 'edited', chatId, message: updated })
  }

  // ═════════════════════════ реакции ═════════════════════════

  /** Поставить или снять реакцию. */
  async toggleReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    const me = this.session
    if (!me) throw new Error('Нет активной сессии')

    const current = this.reactions.get(messageId)
    if (current?.has(me.userId)) {
      await api.removeReaction(messageId, me.userId)
      current.delete(me.userId)
      if (!current.size) this.reactions.delete(messageId)
    } else {
      await api.addReaction(messageId, me.userId, emoji)
      const set = current ?? new Map<string, string>()
      set.set(me.userId, emoji)
      this.reactions.set(messageId, set)
    }
    this.emit({ type: 'reactions', chatId, messageId })
  }

  reactionFor(messageId: string, userId: string): string | undefined {
    return this.reactions.get(messageId)?.get(userId)
  }

  reactionsOf(messageId: string): { emoji: string; count: number }[] {
    const map = this.reactions.get(messageId)
    if (!map) return []
    const counts = new Map<string, number>()
    for (const emoji of map.values()) counts.set(emoji, (counts.get(emoji) ?? 0) + 1)
    return [...counts.entries()].map(([emoji, count]) => ({ emoji, count }))
  }

  async loadReactions(chatId: string): Promise<void> {
    const ids = (this.messageCache.get(chatId) ?? []).map((m) => m.id)
    if (!ids.length) return
    const rows = await api.fetchReactions(ids)
    for (const r of rows) {
      const set = this.reactions.get(r.message_id) ?? new Map<string, string>()
      set.set(r.user_id, r.emoji)
      this.reactions.set(r.message_id, set)
    }
    this.emit({ type: 'reactions', chatId, messageId: '*' })
  }

  // ═════════════════════════ присутствие ═════════════════════════

  /**
   * Кто сейчас в сети.
   *
   * Отдельной подписки нет: сервер сам присылает список присутствующих по
   * тому же потоку событий, что и сообщения. Наличие потока и означает, что
   * человек в сети — поэтому ничего дополнительно отслеживать не нужно.
   */
  startPresence() {
    this.ensureEvents()
  }

  isOnline(userId: string): boolean {
    return this.online.has(userId)
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