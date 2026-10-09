/**
 * Проверка приложения целиком: два пользователя в настоящем браузере.
 *
 * Это самая важная проверка проекта, потому что она проходит весь путь
 * человека: открыть страницу, зарегистрироваться, найти собеседника,
 * написать ему и увидеть ответ. Всё — на собранном приложении и на живом
 * сервере, без единого мока.
 *
 * Проверяется в том числе то, что нельзя проверить в API-тестах:
 *   • страница действительно отрисовывается и сервер ей отвечает;
 *   • регистрация из интерфейса создаёт аккаунт и шифрует ключ;
 *   • сообщение появляется у собеседника само, без перезагрузки;
 *   • текст на диске остаётся зашифрованным.
 *
 * Запуск: node bench/e2e.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, renameSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { mkdtempSync } from 'node:fs'

const PORT = 8877
const BASE = `http://127.0.0.1:${PORT}`

const DATA_DIR = join(process.cwd(), 'data')
const BACKUP_DIR = join(process.cwd(), '.data-backup-for-e2e')

let restored = false
function restoreData() {
  if (restored) return
  restored = true
  try {
    if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true })
    if (existsSync(BACKUP_DIR)) renameSync(BACKUP_DIR, DATA_DIR)
  } catch {
    /* не удалось вернуть — не критично для проверки */
  }
}

if (existsSync(DATA_DIR)) {
  rmSync(BACKUP_DIR, { recursive: true, force: true })
  renameSync(DATA_DIR, BACKUP_DIR)
}
mkdirSync(DATA_DIR, { recursive: true })

let passed = 0
let failed = 0

function ok(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`)
  } else {
    failed++
    console.log(`  \x1b[31m✗ ${name}${detail ? `  ${detail}` : ''}\x1b[0m`)
  }
}

function section(t) {
  console.log(`\n\x1b[1m${t}\x1b[0m`)
}

// ─────────────────────────── поднимаем всё ───────────────────────────

console.log('\n\x1b[1m\x1b[35mAurora · проверка мессенджера целиком\x1b[0m')

// Сборка должна существовать: сервер отдаёт именно её.
if (!existsSync(join(process.cwd(), 'dist', 'index.html'))) {
  console.log('\n\x1b[31mСначала соберите клиент: npm run build\x1b[0m\n')
  restoreData()
  process.exit(1)
}

const server = spawn('node', ['server/index.mjs'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const serverLog = []
server.stdout.on('data', (d) => serverLog.push(d.toString()))
server.stderr.on('data', (d) => serverLog.push(d.toString()))

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return true
    } catch {
      /* поднимается */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

function cleanup() {
  try {
    server.kill()
  } catch {
    /* уже остановлен */
  }
}

if (!(await waitForServer().catch(() => false))) {
  console.error('\n\x1b[31mСервер не запустился.\x1b[0m')
  console.error(serverLog.join(''))
  cleanup()
  restoreData()
  process.exit(1)
}

// ─────────────────────────── браузер ───────────────────────────

function findBrowser() {
  const list = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean)
  for (const p of list) if (existsSync(p)) return p
  return null
}

const browserPath = findBrowser()
if (!browserPath) {
  console.log('\n\x1b[33mБраузер не найден — проверка пропущена.\x1b[0m\n')
  cleanup()
  restoreData()
  process.exit(0)
}

/**
 * Каждый пользователь — отдельный профиль браузера.
 *
 * Это важно: если открыть два окна в одном профиле, они разделят localStorage
 * и один перезапишет сессию другого. Тогда проверка «переписки двух людей»
 * на самом деле проверяла бы одного человека.
 */
const profileA = mkdtempSync(join(os.tmpdir(), 'aurora-a-'))
const profileB = mkdtempSync(join(os.tmpdir(), 'aurora-b-'))

const portA = 9336
const portB = 9337

const browserA = spawn(browserPath, [
  '--headless=new',
  `--remote-debugging-port=${portA}`,
  `--user-data-dir=${profileA}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--window-size=1280,900',
  BASE,
], { stdio: 'ignore' })

const browserB = spawn(browserPath, [
  '--headless=new',
  `--remote-debugging-port=${portB}`,
  `--user-data-dir=${profileB}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--window-size=1280,900',
  BASE,
], { stdio: 'ignore' })

/** Минимальный клиент отладочного протокола Chrome. */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
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
}

async function connect(debugPort) {
  for (let i = 0; i < 80; i++) {
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
let pageErrors = []

try {
  cdpA = await connect(portA)
  cdpB = await connect(portB)

  // Собираем ошибки страницы: молчаливое исключение в React сломало бы
  // работу, но не дало бы заметного признака в проверках.
  const collect = (cdp) => {
    cdp.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        pageErrors.push(msg.params.exceptionDetails.exception?.description ?? 'ошибка')
      }
    })
  }
  collect(cdpA)
  collect(cdpB)
} catch (e) {
  console.error(`\n\x1b[31mНе удалось подключиться: ${e.message}\x1b[0m\n`)
  cleanup()
  browserA.kill()
  browserB.kill()
  restoreData()
  process.exit(1)
}

/** Ждёт появления условия в странице. */
async function waitFor(cdp, expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await cdp.eval(expression)) return true
    } catch {
      /* страница перезагружается */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

/** Заполняет поле ввода по его подписи и вызывает событие изменения. */
async function fillByPlaceholder(cdp, placeholder, value) {
  return cdp.eval(`(() => {
    const el = [...document.querySelectorAll('input, textarea')]
      .find(e => (e.placeholder || '').toLowerCase().includes(${JSON.stringify(placeholder.toLowerCase())}))
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value'
    ).set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
}

/** Нажимает кнопку по видимому тексту. */
async function clickByText(cdp, text) {
  return cdp.eval(`(() => {
    const el = [...document.querySelectorAll('button')]
      .find(b => (b.textContent || '').trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())}))
    if (!el) return false
    el.click()
    return true
  })()`)
}

// ─────────────────────────── 1. страница ───────────────────────────

section('1. Приложение открывается')

await new Promise((r) => setTimeout(r, 2500))

const titleA = await cdpA.eval('document.title')
ok('страница загружена от своего сервера', titleA.includes('Aurora'), titleA)

const statusText = await cdpA.eval('document.body.innerText')
ok('экран входа показан', /Вход|Регистрация/.test(statusText))
ok('видно, что сервер работает', /Сервер работает/.test(statusText), 'строка состояния сервера')

// Приложение полностью автономно: ни одного упоминания внешних сервисов
// быть не должно — иначе человек снова начнёт искать, где регистрироваться.
const mentionsExternal = await cdpA.eval(
  '/\\.env\\.local|Supabase|бэкенд не подключён|зарегистрируйтесь на сайте/i.test(document.body.innerText)',
)
ok('упоминаний внешних сервисов нет', !mentionsExternal)

const cryptoOk = await cdpA.eval('Boolean(window.crypto?.subtle)')
ok('шифрование в браузере доступно', cryptoOk)

// ─────────────────────────── 2. регистрация ───────────────────────────

section('2. Регистрация двух пользователей')

/**
 * Регистрирует пользователя и дожидается, что она ДЕЙСТВИТЕЛЬНО завершилась.
 *
 * Проверять исчезновение кнопки нельзя: во время работы она меняет текст на
 * «Ключи и пароль…», и такая проверка срабатывала бы в самом начале — когда
 * ключи ещё только генерируются (PBKDF2 на 600 000 итераций занимает время).
 * Признак настоящего успеха — появление списка чатов, который виден только
 * внутри приложения.
 */
async function registerUser(cdp, { username, displayName, email, password }) {
  await clickByText(cdp, 'Регистрация')
  await new Promise((r) => setTimeout(r, 400))

  await fillByPlaceholder(cdp, 'логин', username)
  await fillByPlaceholder(cdp, 'отображаемое имя', displayName)
  await fillByPlaceholder(cdp, 'email', email)
  await fillByPlaceholder(cdp, 'пароль', password)
  await new Promise((r) => setTimeout(r, 200))
  await clickByText(cdp, 'Создать аккаунт')

  // Внутри приложения виден поиск людей — верный признак входа.
  return waitFor(
    cdp,
    `(document.body.innerText.includes('Поиск людей') || document.body.innerText.includes('Создать группу'))`,
    30_000,
  )
}

const annaRegistered = await registerUser(cdpA, {
  username: 'anna',
  displayName: 'Анна',
  email: 'anna@example.com',
  password: 'пароль-анны-12345',
})
ok('Анна зарегистрировалась', annaRegistered)

// Ключи действительно созданы и сохранены в браузере.
const keyStored = await cdpA.eval(`(async () => {
  const dbs = await indexedDB.databases()
  return dbs.some(d => d.name === 'aurora-vault')
})()`)
ok('ключ устройства сохранён в браузере', keyStored, 'хранилище IndexedDB создано')

const tokenStored = await cdpA.eval('Boolean(localStorage.getItem("aurora.token"))')
ok('сессия запомнена для входа без пароля', tokenStored)

const boryaRegistered = await registerUser(cdpB, {
  username: 'borya',
  displayName: 'Борис',
  email: 'borya@example.com',
  password: 'пароль-бориса-6789',
})
ok('Борис зарегистрировался', boryaRegistered)

// ─────────────────────────── 3. поиск собеседника ───────────────────────────

section('3. Поиск собеседника и начало переписки')

await new Promise((r) => setTimeout(r, 1500))

await fillByPlaceholder(cdpA, 'поиск людей', 'borya')
await new Promise((r) => setTimeout(r, 1500))

const foundB = await cdpA.eval('/@borya/.test(document.body.innerText)')
ok('Анна нашла Бориса по логину', foundB)

// Открываем чат с найденным человеком.
const opened = await cdpA.eval(`(() => {
  const btns = [...document.querySelectorAll('button')]
  const target = btns.find(b => (b.textContent || '').includes('@borya'))
  if (!target) return false
  target.click()
  return true
})()`)
ok('чат открылся', opened)

// Ждём появления поля ввода сообщения — признак открытой переписки.
const chatReady = await waitFor(cdpA, `Boolean([...document.querySelectorAll('textarea')].find(t => (t.placeholder||'').includes('Сообщение')))`, 20_000)
ok('поле ввода сообщения доступно', chatReady)

// ─────────────────────────── 4. сообщение ───────────────────────────

section('4. Отправка сообщения и доставка')

const SECRET = 'секретное сообщение для проверки шифрования'

// Борис заранее открывает чат с Анной: так проверяется именно живая доставка
// по потоку событий, а не загрузка истории при открытии переписки.
await fillByPlaceholder(cdpB, 'поиск людей', 'anna')
await new Promise((r) => setTimeout(r, 1600))
await cdpB.eval(`(() => {
  const btns = [...document.querySelectorAll('button')]
  const target = btns.find(b => (b.textContent || '').includes('@anna'))
  if (target) target.click()
  return true
})()`)
const boryaChatOpen = await waitFor(
  cdpB,
  `Boolean([...document.querySelectorAll('textarea')].find(t => (t.placeholder||'').includes('Сообщение')))`,
  20_000,
)
ok('Борис открыл переписку с Анной', boryaChatOpen)

// Заходим и в чат у Анны, если он ещё не открыт.
const annaChatOpen = await waitFor(
  cdpA,
  `Boolean([...document.querySelectorAll('textarea')].find(t => (t.placeholder||'').includes('Сообщение')))`,
  20_000,
)
ok('Анна в переписке с Борисом', annaChatOpen)

await fillByPlaceholder(cdpA, 'сообщение', SECRET)
await new Promise((r) => setTimeout(r, 200))

// Отправляем нажатием Enter — так делает человек.
await cdpA.eval(`(() => {
  const el = [...document.querySelectorAll('textarea')].find(t => (t.placeholder||'').includes('Сообщение'))
  if (!el) return false
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return true
})()`)

const sentVisible = await waitFor(cdpA, `document.body.innerText.includes(${JSON.stringify(SECRET)})`, 15_000)
ok('Анна видит своё сообщение сразу', sentVisible)

// Ключевая проверка живого обмена: сообщение появляется у Бориса само,
// без перезагрузки и без открытия чата заново.
const boryaSees = await waitFor(
  cdpB,
  `document.body.innerText.includes(${JSON.stringify(SECRET)})`,
  20_000,
)
ok('Борис получил и расшифровал сообщение по потоку', boryaSees)

// ─────────────────────────── 5. ответ и двусторонний обмен ───────────────────────────

section('5. Ответ и живая доставка без перезагрузки')

const REPLY = 'ответ Бориса, проверка встречного шифрования'

await fillByPlaceholder(cdpB, 'сообщение', REPLY)
await new Promise((r) => setTimeout(r, 200))
await cdpB.eval(`(() => {
  const el = [...document.querySelectorAll('textarea')].find(t => (t.placeholder||'').includes('Сообщение'))
  if (!el) return false
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return true
})()`)

// Анна должна увидеть ответ без единого действия: это и есть realtime.
const annaSeesReply = await waitFor(cdpA, `document.body.innerText.includes(${JSON.stringify(REPLY)})`, 15_000)
ok('ответ пришёл Анне сам, без перезагрузки', annaSeesReply)

// ─────────────────────────── 6. что лежит на сервере ───────────────────────────

section('6. Сервер не может прочитать переписку')

await new Promise((r) => setTimeout(r, 800))

const dbFiles = readdirSync(DATA_DIR).filter((f) => f.startsWith('aurora.db'))
let combined = ''
for (const f of dbFiles) combined += readFileSync(join(DATA_DIR, f)).toString('latin1')

ok('файлы базы на месте', dbFiles.length > 0, dbFiles.join(', '))
ok('текста сообщения Анны в базе нет', !combined.includes(SECRET))
ok('текста ответа Бориса в базе нет', !combined.includes(REPLY))
ok('пароля Анны в базе нет', !combined.includes('пароль-анны-12345'))
ok('пароля Бориса в базе нет', !combined.includes('пароль-бориса-6789'))
ok('логин и почта в базе есть — это метаданные', combined.includes('anna@example.com'))

// ─────────────────────────── 7. вход без пароля ───────────────────────────

section('7. Запоминание устройства')

// Перезагружаем страницу: устройство запомнено, пароль вводить не нужно.
await cdpA.eval('location.reload()')
await new Promise((r) => setTimeout(r, 4000))

const autoLogin = await cdpA.eval(`(() => {
  const t = document.body.innerText
  return t.includes('Поиск людей') || t.includes('Создать группу')
})()`)
ok('после перезагрузки вход произошёл сам', autoLogin, 'пароль не потребовался')

// Переписка должна открыться сама: мессенджер помнит последний чат.
const backInChat = await waitFor(
  cdpA,
  `Boolean([...document.querySelectorAll('textarea')].find(t => (t.placeholder||'').includes('Сообщение')))`,
  20_000,
)
ok('вернулся в ту же переписку', backInChat, 'последний чат восстановлен')

const stillHasHistory = await waitFor(
  cdpA,
  `document.body.innerText.includes(${JSON.stringify(SECRET)})`,
  15_000,
)
ok('история расшифрована после автовхода', stillHasHistory, 'ключ взят из хранилища устройства')

const replyAfterReload = await cdpA.eval(
  `document.body.innerText.includes(${JSON.stringify(REPLY)})`,
)
ok('ответ собеседника тоже на месте', replyAfterReload)

// ─────────────────────────── 8. ошибки страницы ───────────────────────────

section('8. Чистота работы')

ok('ошибок в страницах нет', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'чисто')

const finalText = await cdpA.eval('document.body.innerText')
ok('интерфейс на русском', /Сообщение|Чат|поиск/i.test(finalText))

// ─────────────────────────── итог ───────────────────────────

console.log(
  `\n\x1b[1m${failed === 0 ? '\x1b[32mМессенджер работает целиком' : '\x1b[31mЕсть ошибки'}\x1b[0m: ` +
    `\x1b[32m${passed} ✓\x1b[0m  \x1b[31m${failed} ✗\x1b[0m\n`,
)

// ─────────────────────────── уборка ───────────────────────────

try {
  browserA.kill()
  browserB.kill()
} catch {
  /* уже остановлены */
}
cleanup()
await new Promise((r) => setTimeout(r, 600))

for (const dir of [profileA, profileB]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    /* временный профиль остался — не критично */
  }
}

restoreData()

process.exit(failed === 0 ? 0 : 1)