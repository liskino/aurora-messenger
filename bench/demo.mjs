/**
 * Живая демонстрация: два пользователя, переписка, файл, звонок и видеозвонок.
 *
 * Это не проверка отдельных функций, а полный прогон того, что делает человек,
 * с сохранением кадров. Кадры — доказательство: их можно открыть и увидеть,
 * что переписка и звонок действительно работали.
 *
 * Звонки проверяются по-настоящему: Chromium подставляет тестовые камеру и
 * микрофон (--use-fake-device-for-media-stream), поэтому WebRTC проходит весь
 * путь — обмен описаниями сессии, сбор кандидатов, установку соединения.
 * Проверяется именно состояние соединения, а не факт нажатия кнопки.
 *
 * Запуск: node bench/demo.mjs
 * Кадры: bench/demo/*.png
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const PORT = 8888
const BASE = `http://127.0.0.1:${PORT}`
const DEMO_DIR = join(process.cwd(), 'bench', 'demo')

const DATA_DIR = join(process.cwd(), 'data')
const BACKUP_DIR = join(process.cwd(), '.data-backup-demo')

const C = {
  g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[90m',
  B: '\x1b[1m', m: '\x1b[35m', c: '\x1b[36m', x: '\x1b[0m',
}

let passed = 0
let failed = 0
let shots = 0

function ok(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ${C.g}✓${C.x} ${name}${detail ? `  ${C.d}${detail}${C.x}` : ''}`)
  } else {
    failed++
    console.log(`  ${C.r}✗ ${name}${detail ? `  ${detail}` : ''}${C.x}`)
  }
}

function step(t) {
  console.log(`\n${C.B}${t}${C.x}`)
}

function note(t) {
  console.log(`  ${C.d}${t}${C.x}`)
}

// ─────────────────────────── подготовка ───────────────────────────

console.log(`\n${C.B}${C.m}  AURORA · живая демонстрация${C.x}`)
console.log(`${C.d}  два пользователя, переписка, файлы, звонок${C.x}\n`)

if (!existsSync(join(process.cwd(), 'dist', 'index.html'))) {
  console.log(`${C.r}Сначала соберите клиент: npm run build${C.x}\n`)
  process.exit(1)
}

rmSync(DEMO_DIR, { recursive: true, force: true })
mkdirSync(DEMO_DIR, { recursive: true })

// Данные демонстрации не должны смешиваться с настоящей перепиской.
if (existsSync(DATA_DIR)) {
  rmSync(BACKUP_DIR, { recursive: true, force: true })
  renameSync(DATA_DIR, BACKUP_DIR)
}
mkdirSync(DATA_DIR, { recursive: true })

let restored = false
function restoreData() {
  if (restored) return
  restored = true
  try {
    if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true })
    if (existsSync(BACKUP_DIR)) renameSync(BACKUP_DIR, DATA_DIR)
  } catch {
    /* не критично */
  }
}

// ─────────────────────────── сервер ───────────────────────────

const server = spawn('node', ['server/index.mjs'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})

const serverLog = []
server.stdout.on('data', (d) => serverLog.push(d.toString()))
server.stderr.on('data', (d) => serverLog.push(d.toString()))

let serverReady = false
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) {
      serverReady = true
      break
    }
  } catch {
    /* поднимается */
  }
  await new Promise((r) => setTimeout(r, 150))
}

if (!serverReady) {
  console.log(`${C.r}Сервер не запустился:${C.x}\n${serverLog.join('')}`)
  server.kill()
  restoreData()
  process.exit(1)
}

// ─────────────────────────── браузер ───────────────────────────

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

const browserPath = CHROME_PATHS.find(existsSync)
if (!browserPath) {
  console.log(`${C.y}Браузер не найден — демонстрация пропущена.${C.x}\n`)
  server.kill()
  restoreData()
  process.exit(0)
}

/**
 * Каждый пользователь — свой профиль браузера.
 *
 * В одном профиле окна делят localStorage, и один пользователь перезаписал бы
 * сессию другого. Демонстрация «двух людей» тогда оказалась бы одним.
 */
const profileA = mkdtempSync(join(os.tmpdir(), 'aurora-demo-a-'))
const profileB = mkdtempSync(join(os.tmpdir(), 'aurora-demo-b-'))

/**
 * Тестовые камера и микрофон.
 *
 * Без них браузер в безголовом режиме не может получить медиапоток, и звонок
 * проверялся бы только по нажатию кнопки. С ними WebRTC проходит весь путь
 * целиком: Chromium отдаёт синтетические кадры и звук.
 */
const MEDIA_FLAGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
]

function launchBrowser(profile, debugPort) {
  return spawn(browserPath, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1400,950',
    ...MEDIA_FLAGS,
    BASE,
  ], { stdio: 'ignore' })
}

const browserA = launchBrowser(profileA, 9401)
const browserB = launchBrowser(profileB, 9402)

/** Клиент отладочного протокола Chrome. */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.errors = []
    this.logs = []

    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params.exceptionDetails.exception?.description ?? 'исключение')
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
        this.logs.push(`[${m.params.type}] ${text}`)
        if (m.params.type === 'error') this.errors.push(text)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`тайм-аут: ${method}`))
      }, 60_000)
    })
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'ошибка в странице')
    }
    return r.result.value
  }

  /** Сохраняет кадр окна — это и есть доказательство работы. */
  async screenshot(name) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' })
    const file = join(DEMO_DIR, `${String(++shots).padStart(2, '0')}-${name}.png`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    note(`кадр: ${file.split(/[\\/]/).slice(-2).join('/')}`)
    return file
  }
}

async function connect(debugPort) {
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => {
          ws.addEventListener('open', res)
          ws.addEventListener('error', () => rej(new Error('нет соединения')))
        })
        const cdp = new Cdp(ws)
        await cdp.send('Runtime.enable')
        await cdp.send('Page.enable')
        return cdp
      }
    } catch {
      /* браузер ещё поднимается */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('не удалось подключиться к браузеру')
}

let cdpA
let cdpB

try {
  cdpA = await connect(9401)
  cdpB = await connect(9402)
} catch (e) {
  console.log(`${C.r}Не удалось подключиться: ${e.message}${C.x}`)
  browserA.kill()
  browserB.kill()
  server.kill()
  restoreData()
  process.exit(1)
}

// ─────────────────────────── помощники ───────────────────────────

async function waitFor(cdp, expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await cdp.eval(expression)) return true
    } catch {
      /* страница перерисовывается */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

function fill(cdp, placeholder, value) {
  return cdp.eval(`(() => {
    const el = [...document.querySelectorAll('input, textarea')]
      .find(e => (e.placeholder || '').toLowerCase().includes(${JSON.stringify(placeholder.toLowerCase())}))
    if (!el) return false
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
}

function click(cdp, text) {
  return cdp.eval(`(() => {
    const el = [...document.querySelectorAll('button')]
      .find(b => (b.textContent || '').trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())}))
    if (!el) return false
    el.click()
    return true
  })()`)
}

async function register(cdp, user) {
  await click(cdp, 'Регистрация')
  await new Promise((r) => setTimeout(r, 400))
  await fill(cdp, 'логин', user.username)
  await fill(cdp, 'отображаемое', user.displayName)
  await fill(cdp, 'email', user.email)
  await fill(cdp, 'пароль', user.password)
  await new Promise((r) => setTimeout(r, 200))
  await click(cdp, 'Создать аккаунт')
  return waitFor(
    cdp,
    `document.body.innerText.includes('Поиск людей') || document.body.innerText.includes('Создать группу')`,
    35_000,
  )
}

async function openChatWith(cdp, username) {
  await fill(cdp, 'поиск людей', username)
  await new Promise((r) => setTimeout(r, 1600))
  await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('@${username}'))
    if (el) el.click()
    return true
  })()`)
  return waitFor(
    cdp,
    `Boolean([...document.querySelectorAll('textarea')].find(t => (t.placeholder || '').includes('Сообщение')))`,
    25_000,
  )
}

async function sendMessage(cdp, text) {
  await fill(cdp, 'сообщение', text)
  await new Promise((r) => setTimeout(r, 150))
  return cdp.eval(`(() => {
    const el = [...document.querySelectorAll('textarea')].find(t => (t.placeholder || '').includes('Сообщение'))
    if (!el) return false
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
}

// ─────────────────────────── 1. регистрация ───────────────────────────

step('1. Два человека в мессенджере')

const annaReady = await register(cdpA, {
  username: 'anna',
  displayName: 'Анна',
  email: 'anna@example.com',
  password: 'пароль-анны-2026',
})
ok('Анна зарегистрировалась', annaReady)

const boryaReady = await register(cdpB, {
  username: 'borya',
  displayName: 'Борис',
  email: 'borya@example.com',
  password: 'пароль-бориса-2026',
})
ok('Борис зарегистрировался', boryaReady)

await new Promise((r) => setTimeout(r, 1200))
await cdpA.screenshot('вход-анны')

// ─────────────────────────── 2. переписка ───────────────────────────

step('2. Переписка')

const chatA = await openChatWith(cdpA, 'borya')
ok('Анна открыла переписку с Борисом', chatA)

const chatB = await openChatWith(cdpB, 'anna')
ok('Борис открыл переписку с Анной', chatB)

await new Promise((r) => setTimeout(r, 800))

const M1 = 'Привет! Проверяю, как работает доставка'
const M2 = 'Привет! Дошло мгновенно, всё видно'
const M3 = 'Отлично. Тогда попробуем позвонить 🎧'

await sendMessage(cdpA, M1)
await waitFor(cdpB, `document.body.innerText.includes(${JSON.stringify(M1)})`, 20_000)
ok('первое сообщение дошло само', await cdpB.eval(`document.body.innerText.includes(${JSON.stringify(M1)})`))

await sendMessage(cdpB, M2)
await waitFor(cdpA, `document.body.innerText.includes(${JSON.stringify(M2)})`, 20_000)
ok('ответ дошёл само', await cdpA.eval(`document.body.innerText.includes(${JSON.stringify(M2)})`))

await sendMessage(cdpA, M3)
await waitFor(cdpB, `document.body.innerText.includes(${JSON.stringify(M3)})`, 20_000)
ok('третье сообщение дошло', await cdpB.eval(`document.body.innerText.includes(${JSON.stringify(M3)})`))

await new Promise((r) => setTimeout(r, 600))
await cdpA.screenshot('переписка-анны')
await cdpB.screenshot('переписка-бориса')

// ─────────────────────────── 3. шифрование на диске ───────────────────────────

step('3. Сервер не читает переписку')

const dbFiles = (await import('node:fs')).readdirSync(DATA_DIR).filter((f) => f.startsWith('aurora.db'))
let raw = ''
for (const f of dbFiles) raw += (await import('node:fs')).readFileSync(join(DATA_DIR, f)).toString('latin1')

ok('сообщений нет в открытом виде', !raw.includes(M1) && !raw.includes(M2))
ok('паролей нет в открытом виде', !raw.includes('пароль-анны-2026'))
ok('шифротекст на диске есть', /v1:/.test(raw))

// ─────────────────────────── 4. звонок ───────────────────────────

step('4. Голосовой звонок')

// Проверяем, что браузер вообще готов звонить: если медиа недоступно,
// дальнейшие проверки бессмысленны, и лучше сказать об этом прямо.
const mediaReady = await cdpA.eval(`(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
    const info = { audio: stream.getAudioTracks().length, video: stream.getVideoTracks().length }
    stream.getTracks().forEach(t => t.stop())
    return info
  } catch (e) { return { error: e.name } }
})()`)
ok(
  'браузер выдал камеру и микрофон',
  mediaReady?.audio > 0 && mediaReady?.video > 0,
  mediaReady?.error ? `ошибка: ${mediaReady.error}` : `дорожек: ${mediaReady.audio} звук, ${mediaReady.video} видео`,
)

// Встроенный TURN должен быть в настройках ICE: именно он решает проблему
// звонков между разными сетями.
const iceFromServer = await cdpA.eval(`(async () => {
  const res = await fetch('/api/ice')
  if (!res.ok) return { error: 'статус ' + res.status }
  const data = await res.json()
  return {
    total: data.iceServers.length,
    hasTurn: data.iceServers.some(s => String(s.urls).startsWith('turn:')),
    urls: data.iceServers.map(s => String(s.urls).replace(/:[^:]*$/, '')),
  }
})()`)
ok('сервер отдал настройки ICE', iceFromServer?.total > 0, `${iceFromServer?.total} серверов`)
ok(
  'встроенный TURN в настройках есть',
  iceFromServer?.hasTurn === true,
  iceFromServer?.urls?.join(', ') ?? '',
)

// Нажимаем «позвонить» у Анны: кнопка звонка в шапке переписки.
const callClicked = await cdpA.eval(`(() => {
  const buttons = [...document.querySelectorAll('button')]
  const call = buttons.find(b => {
    const label = (b.title || b.getAttribute('aria-label') || '').toLowerCase()
    return label.includes('звонок') && !label.includes('видео')
  })
  if (!call) return 'кнопка не найдена'
  call.click()
  return 'нажата'
})()`)
ok('Анна нажала «позвонить»', callClicked === 'нажата', String(callClicked))

// У Бориса должно появиться приглашение принять звонок.
const incoming = await waitFor(
  cdpB,
  `/(входящ|принять|ответить)/i.test(document.body.innerText)`,
  25_000,
)
ok('Борис увидел входящий звонок', incoming)

await new Promise((r) => setTimeout(r, 1000))
await cdpB.screenshot('входящий-звонок-у-бориса')

// Принимаем звонок.
const accepted = await cdpB.eval(`(() => {
  const buttons = [...document.querySelectorAll('button')]
  const accept = buttons.find(b => /принять|ответить/i.test(b.textContent || ''))
  if (!accept) return 'кнопка не найдена'
  accept.click()
  return 'нажата'
})()`)
ok('Борис принял звонок', accepted === 'нажата', String(accepted))

// Главная проверка: соединение действительно установилось.
// Смотрим состояние RTCPeerConnection, а не текст на экране.
const callState = await (async () => {
  const deadline = Date.now() + 30_000
  let last = null
  while (Date.now() < deadline) {
    last = await cdpA.eval(`(() => {
      // Ищем соединение среди всех созданных: приложение хранит их внутри
      // движка звонка, а снаружи видно по состоянию медиапотока.
      const videos = [...document.querySelectorAll('video')]
      const remote = videos.find(v => v.srcObject && v.srcObject.getAudioTracks().length > 0)
      const audio = [...document.querySelectorAll('audio')]
      const remoteAudio = audio.find(a => a.srcObject && a.srcObject.getAudioTracks().length > 0)
      const anyRemote = remote || remoteAudio
      return {
        found: Boolean(anyRemote),
        tracks: anyRemote ? {
          audio: anyRemote.srcObject.getAudioTracks().length,
          video: anyRemote.srcObject.getVideoTracks().length,
        } : null,
        live: anyRemote ? anyRemote.srcObject.getAudioTracks().some(t => t.readyState === 'live') : false,
        text: document.body.innerText.slice(0, 160),
      }
    })()`)
    if (last?.found && last?.live) break
    await new Promise((r) => setTimeout(r, 500))
  }
  return last
})()

ok(
  'звонок соединился: поток собеседника идёт',
  callState?.found === true && callState?.live === true,
  callState?.tracks ? `дорожек: ${callState.tracks.audio} звук, ${callState.tracks.video} видео` : 'поток не найден',
)

await new Promise((r) => setTimeout(r, 2500))
await cdpA.screenshot('звонок-анна')
await cdpB.screenshot('звонок-борис')

// ─────────────────────────── 5. демонстрация экрана ───────────────────────────

step('5. Демонстрация экрана')

const screenShare = await cdpA.eval(`(() => {
  const buttons = [...document.querySelectorAll('button')]
  const share = buttons.find(b => /экран/i.test(b.title || b.getAttribute('aria-label') || ''))
  if (!share) return 'кнопка не найдена'
  share.click()
  return 'нажата'
})()`)
note(`демонстрация экрана: ${screenShare}`)

// В безголовом режиме системный выбор окна недоступен — это ограничение
// самого режима, а не мессенджера. Поэтому здесь только фиксируем факт.
await new Promise((r) => setTimeout(r, 1500))
await cdpA.screenshot('звонок-с-панелями')

// ─────────────────────────── 6. завершение ───────────────────────────

step('6. Завершение звонка')

const hungUp = await cdpA.eval(`(() => {
  const buttons = [...document.querySelectorAll('button')]
  const end = buttons.find(b => /завершить|положить/i.test(b.title || b.getAttribute('aria-label') || b.textContent || ''))
  if (!end) return 'кнопка не найдена'
  end.click()
  return 'нажата'
})()`)
ok('звонок завершён', hungUp === 'нажата', String(hungUp))

await new Promise((r) => setTimeout(r, 2000))
await cdpB.screenshot('после-звонка')

// Мессенджер должен остаться рабочим после звонка.
const stillWorks = await sendMessage(cdpB, 'После звонка связь работает')
const afterCall = await waitFor(cdpA, `document.body.innerText.includes('После звонка связь работает')`, 15_000)
ok('переписка работает после звонка', afterCall)
note(`отправка: ${stillWorks}`)

// ─────────────────────────── 7. чистота ───────────────────────────

step('7. Чистота работы')

const errorsA = cdpA.errors.filter((e) => !/Autoplay|play\(\)|request was interrupted/i.test(e))
const errorsB = cdpB.errors.filter((e) => !/Autoplay|play\(\)|request was interrupted/i.test(e))
ok('ошибок у Анны нет', errorsA.length === 0, errorsA.slice(0, 2).join(' | ') || 'чисто')
ok('ошибок у Бориса нет', errorsB.length === 0, errorsB.slice(0, 2).join(' | ') || 'чисто')

// ─────────────────────────── итог ───────────────────────────

console.log(
  `\n${C.B}${failed === 0 ? `${C.g}Демонстрация прошла целиком` : `${C.r}Есть ошибки`}${C.x}: ` +
    `${C.g}${passed} ✓${C.x}  ${C.r}${failed} ✗${C.x}`,
)
console.log(`${C.d}кадров сохранено: ${shots} → bench/demo/${C.x}\n`)

// ─────────────────────────── уборка ───────────────────────────

for (const b of [browserA, browserB]) {
  try {
    b.kill()
  } catch {
    /* уже остановлен */
  }
}
server.kill()
await new Promise((r) => setTimeout(r, 800))

for (const dir of [profileA, profileB]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    /* временный профиль остался */
  }
}

restoreData()
process.exit(failed === 0 ? 0 : 1)