/**
 * Звонки: голос, видео, демонстрация экрана.
 *
 * ─── Как это работает без своего сервера ──────────────────────────────
 *
 * Медиа между участниками идёт напрямую (peer-to-peer), а не через наш
 * сервер: браузеры договариваются сами. Шифрование потока — DTLS-SRTP,
 * оно встроено в WebRTC и включается по умолчанию, ключи согласуются
 * напрямую между участниками, сервер их не видит.
 *
 * Чтобы участники нашли друг друга, нужен только обмен служебными
 * сообщениями: описанием сессии (SDP) и сетевыми кандидатами (ICE).
 * Для этого база данных не нужна — используется широковещательный канал
 * Supabase Realtime: сообщения живут, пока идёт звонок, и нигде не
 * сохраняются.
 *
 * ─── Почему нужен TURN ────────────────────────────────────────────────
 *
 * Публичный STUN помогает узнать свой внешний адрес и работает почти всегда.
 * Но если интернет-провайдер использует симметричный NAT (обычное дело в
 * мобильных сетях), прямое соединение не установится — нужен ретранслятор
 * TURN. Он передаёт уже зашифрованный поток, поэтому содержимое разговора
 * ему недоступно. Адрес TURN задаётся в .env.local.
 *
 * ─── Топология ────────────────────────────────────────────────────────
 *
 * Каждый участник соединяется с каждым (mesh). Для 2–4 человек это лучший
 * вариант: минимальная задержка, нет сервера, который может упасть.
 * Для больших групп нужен SFU-сервер — это отдельная история.
 *
 * ─── Кто кому предлагает соединение (защита от «столкновения») ─────────
 *
 * Если обе стороны одновременно отправят предложение, соединение сорвётся.
 * Поэтому правило жёсткое: новый участник НИКОГДА не предлагает первым. Он
 * объявляет о себе, а предложения ему отправляют уже подключённые. Такой
 * порядок исключает столкновение при любом количестве участников.
 */
import { supabase } from './api'
import {
  actionsOf,
  initialState,
  receive,
  type CallKind,
  type CallState,
  type Signal as BaseSignal,
  type SignalState,
} from './rtc-signal'

export type { CallKind, CallState }

/** Служебное сообщение звонка, дополненное полем описания сессии. */
type Signal = BaseSignal

export interface CallParticipant {
  userId: string
  stream: MediaStream | null
  muted: boolean
  videoOff: boolean
  sharing: boolean
  connection: RTCPeerConnectionState
}

export interface CallInfo {
  callId: string
  chatId: string
  kind: CallKind
  initiator: string
  title: string
  startedAt: number
}

export type CallEvent =
  | { type: 'state'; state: CallState }
  | { type: 'incoming'; call: CallInfo }
  | { type: 'participants'; participants: CallParticipant[] }
  | { type: 'local'; stream: MediaStream }
  | { type: 'quality'; rtt: number; bitrate: number }
  | { type: 'ended'; reason: string }
  | { type: 'error'; error: Error }

type Listener = (e: CallEvent) => void

// ─────────────────────────── конфигурация ICE ───────────────────────────

/**
 * Публичные STUN плюс необязательный TURN из настроек.
 * Без TURN звонки работают в большинстве домашних сетей, но могут не
 * установиться между мобильным интернетом и Wi-Fi.
 */
export function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
  const turnUrl = import.meta.env.VITE_TURN_URL
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: import.meta.env.VITE_TURN_USERNAME || undefined,
      credential: import.meta.env.VITE_TURN_CREDENTIAL || undefined,
    })
  }
  return servers
}

export function hasTurn(): boolean {
  return Boolean(import.meta.env.VITE_TURN_URL)
}

/**
 * Проверка, сможет ли этот компьютер вообще звонить.
 * Отсутствие камеры или микрофона — не ошибка программы, и узнать об этом
 * лучше до нажатия кнопки «позвонить».
 */
export async function checkDevices(): Promise<{ audio: boolean; video: boolean }> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return {
      audio: devices.some((d) => d.kind === 'audioinput'),
      video: devices.some((d) => d.kind === 'videoinput'),
    }
  } catch {
    return { audio: false, video: false }
  }
}

/** Публичный RTC доступен только в защищённом контексте (HTTPS или localhost). */
export function rtcSupported(): boolean {
  return (
    typeof RTCPeerConnection !== 'undefined' &&
    Boolean(navigator.mediaDevices) &&
    window.isSecureContext
  )
}

// ─────────────────────────── движок звонка ───────────────────────────

export class CallEngine {
  private listeners = new Set<Listener>()
  private channel: ReturnType<typeof supabase.channel> | null = null

  private peerConnections = new Map<string, RTCPeerConnection>()
  private participants = new Map<string, CallParticipant>()
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>()
  /** Участники, для которых уже получено описание сессии. */
  private describedPeers = new Set<string>()

  private localStream: MediaStream | null = null
  private cameraTrack: MediaStreamTrack | null = null
  private micTrack: MediaStreamTrack | null = null

  private info: CallInfo | null = null
  private state: CallState = 'idle'
  private selfId = ''
  /** Чат, в котором сейчас идёт или ожидается звонок. */
  private chatId: string | null = null
  private screenTrack: MediaStreamTrack | null = null
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private lastBytes = 0
  private lastStatsAt = 0

  get currentCall(): CallInfo | null {
    return this.info
  }

  get currentState(): CallState {
    return this.state
  }

  /** Чат, в котором идёт или ожидается звонок. */
  get activeChatId(): string | null {
    return this.chatId
  }

  get localMedia(): MediaStream | null {
    return this.localStream
  }

  listParticipants(): CallParticipant[] {
    return [...this.participants.values()]
  }

  on(fn: Listener) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit(e: CallEvent) {
    for (const fn of this.listeners) fn(e)
  }

  private setState(state: CallState) {
    this.state = state
    this.emit({ type: 'state', state })
  }

  private emitParticipants() {
    this.emit({ type: 'participants', participants: this.listParticipants() })
  }

  // ─────────────── канал связи ───────────────

  private openChannel(chatId: string) {
    if (this.channel) return
    const channel = supabase.channel(`call:${chatId}`, {
      // self: false — свои же сообщения не возвращаются, иначе бесконечный цикл.
      config: { broadcast: { self: false } },
    })

    channel.on('broadcast', { event: 'signal' }, ({ payload }) => {
      void this.handleSignal(payload as Signal)
    })

    channel.subscribe()
    this.channel = channel
  }

  private async send(signal: Signal) {
    if (!this.channel) return
    // Служебное сообщение не должно сохраняться ни в базе, ни в истории.
    await this.channel.send({ type: 'broadcast', event: 'signal', payload: signal })
  }

  // ─────────────── медиа ───────────────

  private async acquireMedia(kind: CallKind): Promise<MediaStream> {
    if (this.localStream) return this.localStream

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video:
        kind === 'video'
          ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
          : false,
    })

    this.localStream = stream
    this.micTrack = stream.getAudioTracks()[0] ?? null
    this.cameraTrack = stream.getVideoTracks()[0] ?? null
    this.emit({ type: 'local', stream })
    return stream
  }

  // ─────────────── начало звонка ───────────────

  /** Инициировать звонок в чате. */
  async startCall(chatId: string, selfId: string, kind: CallKind, title: string) {
    if (!rtcSupported()) {
      throw new Error('Звонки требуют HTTPS. Откройте страницу по защищённому адресу.')
    }
    if (this.state !== 'idle') throw new Error('Звонок уже идёт')

    this.selfId = selfId
    this.info = {
      callId: crypto.randomUUID(),
      chatId,
      kind,
      initiator: selfId,
      title,
      startedAt: Date.now(),
    }
    this.setState('inviting')
    this.openChannel(chatId)

    // Микрофон включаем сразу: иначе человек не поймёт, слышат ли его.
    await this.acquireMedia(kind)

    await this.send({
      kind: 'invite',
      callId: this.info.callId,
      chatId,
      from: selfId,
      callType: kind,
      title,
      ts: Date.now(),
    })
  }

  /** Принять входящий звонок. */
  async accept() {
    if (!this.info) return
    this.setState('connecting')

    // Микрофон и камеру включаем только сейчас: до согласия человека
    // устройство не должно работать.
    await this.acquireMedia(this.info.kind)

    // Объявляем о себе — предложения соединения придут от уже подключённых.
    await this.send({ kind: 'join', callId: this.info.callId, from: this.selfId })
    this.startStats()
  }

  /** Отклонить входящий звонок. */
  async reject() {
    if (!this.info) return
    await this.send({ kind: 'reject', callId: this.info.callId, from: this.selfId })
    this.cleanup('Звонок отклонён')
  }

  /** Положить трубку. */
  async hangup() {
    if (!this.info) {
      this.cleanup('Звонок завершён')
      return
    }
    await this.send({ kind: 'leave', callId: this.info.callId, from: this.selfId })
    this.cleanup('Вы завершили звонок')
  }

  // ─────────────── обработка служебных сообщений ───────────────

  /**
   * Применяет служебное сообщение.
   *
   * Решение «что делать» принимает чистый модуль rtc-signal: он же покрыт
   * тестами в bench/rtc.mjs. Здесь только исполнение — создать соединение,
   * отправить описание, обновить интерфейс. Такое разделение не украшение:
   * порядок обмена сообщениями ломается незаметно, и его нужно проверять
   * тестами напрямую, без камеры и второй машины.
   */
  private async handleSignal(signal: Signal) {
    // Приводим состояние движка к виду, понятному модулю сигнализации.
    const before: SignalState = {
      ...initialState(this.selfId),
      state: this.state,
      callId: this.info?.callId ?? null,
      chatId: this.info?.chatId ?? this.chatId,
      initiator: this.info?.initiator ?? null,
      peers: new Set(this.peerConnections.keys()),
      described: new Set(this.describedPeers),
      pendingCandidates: new Map(this.pendingCandidates),
    }

    const after = receive(before, signal)
    const actions = actionsOf(after)

    // Синхронизируем то, что могло измениться до исполнения действий.
    this.describedPeers = after.described
    this.pendingCandidates = after.pendingCandidates

    // Входящий звонок: поднимаем состояние до того, как что-то отправлять.
    if (after.state === 'incoming' && this.state === 'idle') {
      this.chatId = after.chatId
      if (after.chatId) this.openChannel(after.chatId)
      this.info = {
        callId: after.callId!,
        chatId: after.chatId!,
        kind: signal.kind === 'invite' ? signal.callType : 'audio',
        initiator: after.initiator!,
        title: signal.kind === 'invite' ? signal.title : '',
        startedAt: Date.now(),
      }
      this.setState('incoming')
      this.emit({ type: 'incoming', call: this.info })
    }

    for (const update of actions.media) {
      const p = this.participants.get(update.userId)
      if (!p) continue
      this.participants.set(update.userId, {
        ...p,
        muted: update.muted,
        videoOff: update.videoOff,
        sharing: update.sharing,
      })
      this.emitParticipants()
    }

    for (const out of actions.send) {
      switch (out.kind) {
        case 'reject':
          await this.send(out)
          break

        case 'offer':
          // Описание создаёт WebRTC — модуль сигнализации решает только,
          // что предложение вообще нужно отправлять, и кому именно.
          await this.createOfferTo(out.to)
          break

        case 'answer': {
          const pc = this.peerConnections.get(out.to)
          if (!pc || pc.signalingState !== 'have-local-offer') break
          // Настоящее описание пришло в предложении; дискриминант union
          // проверяем явно, потому что TypeScript не сужает его в цикле.
          if (signal.kind !== 'offer') break
          await pc.setRemoteDescription(signal.sdp)
          await this.flushCandidates(out.to)
          this.setState('active')
          this.startStats()
          break
        }
      }
    }

    // Прямые действия, которые не выражаются состоянием.
    switch (signal.kind) {
      case 'offer':
        if (signal.to === this.selfId) await this.handleOffer(signal)
        break

      case 'ice':
        if (signal.to === this.selfId) {
          await this.handleRemoteCandidate(signal.from, signal.candidate)
        }
        break

      case 'leave':
      case 'reject':
        if (signal.from !== this.selfId) {
          this.dropPeer(signal.from)
          if (actions.finished) this.cleanup(actions.endedReason ?? 'Звонок завершён')
        }
        break
    }
  }

  /**
   * Пассивное прослушивание звонков в чате, пока звонок не начат.
   * Вызывается при открытии переписки, чтобы входящий звонок был слышен.
   */
  listenForCalls(chatId: string, selfId: string) {
    if (this.state !== 'idle') return
    this.selfId = selfId
    this.chatId = chatId
    this.openChannel(chatId)
  }

  /** Уходим из чата — перестаём слушать звонки, если разговора нет. */
  stopListening() {
    if (this.state === 'idle') {
      this.closeChannel()
      this.chatId = null
    }
  }

  // ─────────────── соединения с участниками ───────────────

  private createPeer(userId: string): RTCPeerConnection {
    const existing = this.peerConnections.get(userId)
    if (existing) return existing

    const pc = new RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: 'max-bundle' })

    // Свои дорожки отправляем сразу — иначе собеседник не увидит и не услышит.
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        pc.addTrack(track, this.localStream)
      }
    }

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !this.info) return
      void this.send({
        kind: 'ice',
        callId: this.info.callId,
        from: this.selfId,
        to: userId,
        candidate: ev.candidate.toJSON(),
      })
    }

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track])
      const prev = this.participants.get(userId)
      this.participants.set(userId, {
        userId,
        stream,
        muted: prev?.muted ?? false,
        videoOff: prev?.videoOff ?? false,
        sharing: prev?.sharing ?? false,
        connection: pc.connectionState,
      })
      this.emitParticipants()
    }

    pc.onconnectionstatechange = () => {
      const p = this.participants.get(userId)
      if (p) {
        this.participants.set(userId, { ...p, connection: pc.connectionState })
        this.emitParticipants()
      }
      if (pc.connectionState === 'failed') {
        // Соединение не поднялось — обычно это симметричный NAT без TURN.
        this.emit({
          type: 'error',
          error: new Error(
            hasTurn()
              ? 'Связь с участником прервалась'
              : 'Не удалось соединиться напрямую. Нужен TURN-сервер — см. README',
          ),
        })
      }
      if (pc.connectionState === 'connected') this.setState('active')
    }

    this.peerConnections.set(userId, pc)
    this.participants.set(userId, {
      userId,
      stream: null,
      muted: false,
      videoOff: false,
      sharing: false,
      connection: pc.connectionState,
    })
    this.emitParticipants()
    return pc
  }

  private async createOfferTo(userId: string) {
    const pc = this.createPeer(userId)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    if (!this.info) return
    await this.send({
      kind: 'offer',
      callId: this.info.callId,
      from: this.selfId,
      to: userId,
      sdp: { type: offer.type, sdp: offer.sdp },
    })
  }

  private async handleOffer(signal: Extract<Signal, { kind: 'offer' }>) {
    const pc = this.createPeer(signal.from)
    await pc.setRemoteDescription(signal.sdp)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await this.send({
      kind: 'answer',
      callId: signal.callId,
      from: this.selfId,
      to: signal.from,
      sdp: { type: answer.type, sdp: answer.sdp },
    })
    await this.flushCandidates(signal.from)
    this.setState('active')
    this.startStats()
  }

  /**
   * Кандидаты, пришедшие до описания сессии, применять нельзя — браузер
   * их отвергнет. Складываем их в очередь и применяем после.
   */
  private async handleRemoteCandidate(userId: string, candidate: RTCIceCandidateInit) {
    const pc = this.peerConnections.get(userId)
    if (!pc) {
      const queue = this.pendingCandidates.get(userId) ?? []
      queue.push(candidate)
      this.pendingCandidates.set(userId, queue)
      return
    }
    if (!pc.remoteDescription) {
      const queue = this.pendingCandidates.get(userId) ?? []
      queue.push(candidate)
      this.pendingCandidates.set(userId, queue)
      return
    }
    try {
      await pc.addIceCandidate(candidate)
    } catch {
      // Отдельный неудачный кандидат не должен ронять весь звонок.
    }
  }

  private async flushCandidates(userId: string) {
    const pc = this.peerConnections.get(userId)
    const queue = this.pendingCandidates.get(userId)
    if (!pc || !queue?.length) return
    this.pendingCandidates.delete(userId)
    for (const c of queue) {
      try {
        await pc.addIceCandidate(c)
      } catch {
        /* пропускаем негодный кандидат */
      }
    }
  }

  private dropPeer(userId: string) {
    const pc = this.peerConnections.get(userId)
    if (pc) {
      pc.onicecandidate = null
      pc.ontrack = null
      pc.onconnectionstatechange = null
      pc.close()
      this.peerConnections.delete(userId)
    }
    this.pendingCandidates.delete(userId)
    this.participants.delete(userId)
    this.emitParticipants()
  }

  // ─────────────── управление своим потоком ───────────────

  /** Микрофон: дорожка не удаляется, а глушится — так не нужна переговоры заново. */
  toggleMic(): boolean {
    const track = this.micTrack ?? this.localStream?.getAudioTracks()[0] ?? null
    if (!track) return true
    track.enabled = !track.enabled
    void this.broadcastMedia()
    return !track.enabled
  }

  toggleCamera(): boolean {
    const track = this.cameraTrack ?? this.localStream?.getVideoTracks()[0] ?? null
    if (!track) return true
    track.enabled = !track.enabled
    void this.broadcastMedia()
    return !track.enabled
  }

  /**
   * Демонстрация экрана.
   *
   * Ключевой момент: дорожка не добавляется заново, а подменяется в уже
   * существующих отправителях (replaceTrack). Из-за этого не нужно заново
   * согласовывать соединение — картинка меняется мгновенно и без рывка.
   */
  async startScreenShare(): Promise<void> {
    if (!rtcSupported()) throw new Error('Демонстрация экрана недоступна')

    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: false,
    })
    const screenTrack = display.getVideoTracks()[0]
    if (!screenTrack) throw new Error('Экран не выбран')

    for (const pc of this.peerConnections.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
      if (sender) await sender.replaceTrack(screenTrack)
    }

    // В своём окне тоже показываем то, что транслируем.
    if (this.localStream) {
      for (const t of this.localStream.getVideoTracks()) this.localStream.removeTrack(t)
      this.localStream.addTrack(screenTrack)
      this.emit({ type: 'local', stream: this.localStream })
    }

    // Пользователь может остановить показ кнопкой браузера, а не нашей.
    screenTrack.onended = () => {
      void this.stopScreenShare()
    }

    this.screenTrack = screenTrack
    void this.broadcastMedia()
  }

  async stopScreenShare(): Promise<void> {
    const screen = this.screenTrack
    if (!screen) return
    this.screenTrack = null
    screen.onended = null
    screen.stop()

    for (const pc of this.peerConnections.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
      if (sender) await sender.replaceTrack(this.cameraTrack)
    }

    if (this.localStream && this.cameraTrack) {
      for (const t of this.localStream.getVideoTracks()) this.localStream.removeTrack(t)
      this.localStream.addTrack(this.cameraTrack)
      this.emit({ type: 'local', stream: this.localStream })
    }
    void this.broadcastMedia()
  }

  get isSharing(): boolean {
    return this.screenTrack !== null
  }

  private async broadcastMedia() {
    if (!this.info) return
    await this.send({
      kind: 'media',
      callId: this.info.callId,
      from: this.selfId,
      muted: !(this.micTrack?.enabled ?? true),
      videoOff: !(this.cameraTrack?.enabled ?? true),
      sharing: this.screenTrack !== null,
    })
  }

  // ─────────────── качество связи ───────────────

  /**
   * Периодически читаем статистику соединения: задержку и скорость.
   * Это честный способ показать «как слышно», вместо угадывания.
   */
  private startStats() {
    if (this.statsTimer) return
    this.lastStatsAt = performance.now()
    this.lastBytes = 0

    this.statsTimer = setInterval(async () => {
      const pc = [...this.peerConnections.values()][0]
      if (!pc) return
      try {
        const stats = await pc.getStats()
        let rtt = 0
        let bytes = 0
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime) {
            rtt = r.currentRoundTripTime * 1000
          }
          if (r.type === 'inbound-rtp' && typeof r.bytesReceived === 'number') {
            bytes += r.bytesReceived
          }
        })
        const now = performance.now()
        const seconds = (now - this.lastStatsAt) / 1000
        const bitrate = seconds > 0 ? ((bytes - this.lastBytes) * 8) / seconds / 1000 : 0
        this.lastBytes = bytes
        this.lastStatsAt = now
        this.emit({ type: 'quality', rtt, bitrate: Math.max(0, bitrate) })
      } catch {
        /* статистика недоступна — не повод прерывать звонок */
      }
    }, 1500)
  }

  // ─────────────── завершение ───────────────

  private closeChannel() {
    if (this.channel) {
      supabase.removeChannel(this.channel)
      this.channel = null
    }
  }

  private cleanup(reason: string) {
    for (const userId of [...this.peerConnections.keys()]) this.dropPeer(userId)

    if (this.statsTimer) {
      clearInterval(this.statsTimer)
      this.statsTimer = null
    }
    if (this.screenTrack) {
      this.screenTrack.onended = null
      this.screenTrack.stop()
      this.screenTrack = null
    }
    // Выключаем камеру и микрофон: индикатор записи не должен гореть после звонка.
    for (const track of this.localStream?.getTracks() ?? []) track.stop()
    this.localStream = null
    this.cameraTrack = null
    this.micTrack = null

    this.closeChannel()
    this.pendingCandidates.clear()
    this.participants.clear()

    const wasActive = this.state !== 'idle'
    this.info = null
    this.chatId = null
    this.setState('ended')
    this.emitParticipants()
    if (wasActive) this.emit({ type: 'ended', reason })

    // Возвращаемся в покой, чтобы можно было позвонить снова.
    setTimeout(() => this.setState('idle'), 0)
  }
}

export const calls = new CallEngine()