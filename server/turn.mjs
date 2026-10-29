/**
 * Встроенный STUN/TURN — решает проблему звонков между разными сетями.
 *
 * ─── Зачем это нужно ──────────────────────────────────────────────────
 *
 * Когда два устройства в одной сети, звонок идёт напрямую. Но если один
 * в мобильном интернете, а другой в домашнем Wi-Fi, провайдер применяет
 * симметричный NAT: прямое соединение установить невозможно. Нужен
 * ретранслятор — TURN, который пересылает трафик через себя.
 *
 * Обычно TURN — это отдельный сервер, за который платят. Здесь он встроен
 * в приложение: поднимается вместе с мессенджером и настраивается сам.
 *
 * ─── Что важно понимать ──────────────────────────────────────────────
 *
 * TURN-сервер передаёт уже зашифрованный поток (DTLS-SRTP), ключи
 * согласованы между собеседниками напрямую. Ретранслятор не может
 * расшифровать разговор — он видит только поток байт.
 *
 * Для звонков между РАЗНЫМИ сетями этого компьютера должен быть виден
 * извне — нужен публичный адрес (или VPN вроде Tailscale). Внутри одной
 * сети встроенного TURN достаточно сразу.
 */
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

/** Порт TURN. 3478 — стандартный, но может быть занят, поэтому подбираем. */
const DEFAULT_PORT = 3478

let turnServer = null
let credentials = null
let activePort = 0

/**
 * Учётные данные TURN.
 *
 * Генерируются один раз при первом запуске и лежат в папке данных.
 * Смысл не в защите от подбора — поток всё равно зашифрован, — а в том,
 * чтобы сервер не превратился в открытый ретранслятор для посторонних.
 */
function loadCredentials(dataDir) {
  const file = join(dataDir, 'turn.json')
  if (existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      if (saved.username && saved.password) return saved
    } catch {
      /* файл повреждён — создадим заново */
    }
  }

  const fresh = {
    username: 'aurora',
    password: randomBytes(24).toString('base64url'),
  }
  try {
    writeFileSync(file, JSON.stringify(fresh, null, 2), 'utf8')
  } catch {
    /* папка недоступна для записи — работаем со случайным паролем */
  }
  return fresh
}

/**
 * Запускает STUN/TURN.
 *
 * Ошибка запуска не должна мешать мессенджеру: он работает и без TURN,
 * просто звонки между разными сетями могут не соединиться. Поэтому
 * функция возвращает null при неудаче, а не выбрасывает исключение.
 */
export function startTurn(dataDir, preferredPort = DEFAULT_PORT) {
  if (turnServer) return { port: activePort, credentials }

  credentials = loadCredentials(dataDir)

  let Turn
  try {
    Turn = require('node-turn')
  } catch {
    // Модуль не попал в сборку — не критично, работаем без TURN.
    return null
  }

  // Пробуем порты по очереди: 3478 часто занимают другие программы.
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = preferredPort + attempt
    try {
      const server = new Turn({
        authMech: 'long-term',
        credentials: { [credentials.username]: credentials.password },
        listeningPort: port,
        // 'OFF' вместо отладки: иначе консоль заливается строками на каждый пакет.
        debugLevel: 'OFF',
      })

      server.start()
      turnServer = server
      activePort = port
      return { port, credentials }
    } catch {
      // Порт занят — пробуем следующий.
    }
  }

  return null
}

export function stopTurn() {
  if (!turnServer) return
  try {
    turnServer.stop()
  } catch {
    /* уже остановлен */
  }
  turnServer = null
  activePort = 0
}

/**
 * Список ICE-серверов для клиента.
 *
 * Клиент получает это от сервера и сразу использует в звонке — человеку
 * не нужно ничего вводить и настраивать.
 *
 * STUN указан всегда: даже без TURN он помогает узнать внешний адрес и
 * покрывает большинство домашних сетей.
 */
export function iceServersFor(host) {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]

  if (turnServer && activePort && credentials && host) {
    // Адрес тот, по которому клиент обращался к серверу. Локально это
    // 127.0.0.1, и для звонков внутри одного компьютера этого достаточно.
    servers.push({
      urls: `turn:${host}:${activePort}?transport=udp`,
      username: credentials.username,
      credential: credentials.password,
    })
  }

  return servers
}

export function turnStatus() {
  return {
    running: Boolean(turnServer),
    port: activePort,
    // Публичный адрес настраивается снаружи: без него TURN поможет только
    // в пределах одной сети.
    publicHost: process.env.AURORA_PUBLIC_HOST || null,
  }
}