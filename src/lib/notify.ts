/**
 * Уведомления: звук, заголовок окна, системные всплывающие окна.
 *
 * Отдельный модуль, потому что уведомления легко начинают раздражать:
 * важны не только сами сигналы, но и когда их НЕ показывать. Здесь это
 * собрано в одном месте и работает по понятным правилам.
 */

let audioContext: AudioContext | null = null

/**
 * Короткий сигнал средствами Web Audio.
 *
 * Не используем mp3-файл: лишний запрос к сети, лишний вес сборки, и звук
 * всё равно не успеет загрузиться к первому сообщению. Синтезированный тон
 * играет мгновенно и не требует ни одного байта загрузки.
 */
export function playTone(kind: 'message' | 'call' | 'end' = 'message') {
  try {
    audioContext ??= new AudioContext()
    const ctx = audioContext
    if (ctx.state === 'suspended') void ctx.resume()

    const now = ctx.currentTime
    const notes =
      kind === 'message' ? [880, 1320] : kind === 'call' ? [660, 990, 1320] : [660, 440]

    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq

      // Плавное затухание: резкий обрыв звучит как щелчок и раздражает.
      const start = now + i * 0.11
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.075, start + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.19)

      osc.connect(gain).connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.2)
    })
  } catch {
    // Звук может быть запрещён политикой браузера до первого клика —
    // это не повод ломать отправку сообщения.
  }
}

/** Разбудить звук после первого действия пользователя. */
export function unlockAudio() {
  try {
    audioContext ??= new AudioContext()
    if (audioContext.state === 'suspended') void audioContext.resume()
  } catch {
    /* не критично */
  }
}

// ─────────────────────────── системные уведомления ───────────────────────────

export function notificationsAllowed(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted'
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  try {
    const result = await Notification.requestPermission()
    return result === 'granted'
  } catch {
    return false
  }
}

/**
 * Показывает системное уведомление о сообщении.
 *
 * Если окно активно и чат открыт — уведомление не показывается: человек
 * и так видит сообщение, а лишнее всплывающее окно только мешает.
 */
export function notifyMessage(params: {
  title: string
  body: string
  active: boolean
  tag: string
  onClick?: () => void
}) {
  if (!notificationsAllowed()) return
  if (params.active) return

  try {
    const n = new Notification(params.title, {
      body: params.body,
      tag: params.tag, // новое сообщение из того же чата заменяет старое
      silent: true, // свой звук уже проигран, дублировать не нужно
      icon: '/favicon.ico',
    })
    n.onclick = () => {
      window.focus()
      params.onClick?.()
      n.close()
    }
  } catch {
    /* уведомления могут быть запрещены системой */
  }
}

// ─────────────────────────── заголовок окна ───────────────────────────

const BASE_TITLE = 'Aurora — защищённый мессенджер'

/** Непрочитанные сообщения показываем в заголовке вкладки. */
export function setUnreadTitle(count: number) {
  document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE
}

export function resetTitle() {
  document.title = BASE_TITLE
}

/** Виден ли интерфейс прямо сейчас: на это опираются все решения о показе. */
export function isWindowActive(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}