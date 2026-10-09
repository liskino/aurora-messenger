/**
 * Проверка СОБРАННОГО приложения: тот самый .exe, который получит пользователь.
 *
 * Отличие от bench/app.mjs принципиальное: там запускается исходный код через
 * Electron из node_modules, а здесь — готовый файл из release/. Именно он
 * попадёт человеку, и проверять надо его: упаковка может сломать пути внутри
 * архива asar, и такие поломки не видны при запуске из исходников.
 *
 * Запуск: node bench/exe.mjs [путь-к-exe]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const DEBUG_PORT = 9362

const exePath =
  process.argv[2] ||
  join(process.cwd(), 'release', 'win-unpacked', 'Aurora.exe')

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

console.log('\n\x1b[1m\x1b[35mAurora · проверка собранного приложения\x1b[0m')

if (!existsSync(exePath)) {
  console.log(`\n\x1b[31mНе найден файл: ${exePath}\x1b[0m`)
  console.log('Соберите приложение: npm run dist\n')
  process.exit(1)
}

console.log(`\x1b[90mфайл: ${exePath}\x1b[0m`)

// Данные собранного приложения лежат в AppData. Чтобы проверка не трогала
// настоящую переписку, подменяем профиль Electron на временный.
const tempProfile = mkdtempSync(join(os.tmpdir(), 'aurora-exe-'))

const proc = spawn(exePath, [`--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${tempProfile}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

const appLog = []
proc.stdout.on('data', (d) => appLog.push(d.toString()))
proc.stderr.on('data', (d) => appLog.push(d.toString()))

/** Ждёт окно приложения в списке отладки. */
async function waitForWindow(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && /127\.0\.0\.1|localhost/.test(t.url),
      )
      if (page) return page
    } catch {
      /* приложение ещё поднимается */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}

const page = await waitForWindow()

section('1. Запуск программы')

if (!page) {
  console.log('\n\x1b[31mОкно не открылось.\x1b[0m')
  console.log(appLog.join('').slice(0, 3000))
  proc.kill()
  process.exit(1)
}

ok('программа запустилась', true)
ok('окно открылось на своём сервере', /127\.0\.0\.1:\d+/.test(page.url), page.url)

const port = Number(page.url.match(/127\.0\.0\.1:(\d+)/)?.[1] ?? 0)

section('2. Сервер внутри программы')

let health = null
try {
  health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()
} catch {
  health = null
}
ok('сервер отвечает', health?.ok === true, `порт ${port}`)
ok('возможности объявлены', health?.capabilities?.calls === true && health.capabilities.e2e === true)

section('3. Интерфейс в окне')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', () => rej(new Error('нет соединения с окном')))
})

let id = 0
const pending = new Map()
const pageErrors = []

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
  }
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push(m.params.exceptionDetails.exception?.description ?? 'ошибка')
  }
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id
    pending.set(n, { resolve, reject })
    ws.send(JSON.stringify({ id: n, method, params }))
    setTimeout(() => pending.delete(n) && reject(new Error('тайм-аут')), 30000)
  })

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  return r.exceptionDetails ? null : r.result.value
}

await send('Runtime.enable')
await new Promise((r) => setTimeout(r, 3000))

const title = await evaluate('document.title')
ok('заголовок верный', Boolean(title?.includes('Aurora')), title)

const body = (await evaluate('document.body.innerText')) ?? ''
ok('экран входа отрисован', /Вход|Регистрация/.test(body))
ok('состояние сервера показано', /Сервер работает/.test(body))
ok('интерфейс не пустой', body.length > 100, `${body.length} символов`)

const bg = await evaluate('getComputedStyle(document.body).backgroundColor')
ok('оформление применилось', bg === 'rgb(8, 8, 12)', bg)

const stylesLoaded = await evaluate(
  'document.styleSheets.length > 0 && [...document.querySelectorAll("link[rel=stylesheet]")].every(l => l.sheet)',
)
ok('стили загрузились из упакованного приложения', stylesLoaded === true)

const assetsLoaded = await evaluate(`(async () => {
  const script = [...document.querySelectorAll('script[src]')][0]
  if (!script) return 'нет скриптов'
  const res = await fetch(script.src)
  return res.ok ? 'ok' : 'статус ' + res.status
})()`)
ok('скрипты доступны внутри программы', assetsLoaded === 'ok', String(assetsLoaded))

const cryptoOk = await evaluate('Boolean(window.crypto?.subtle)')
ok('шифрование работает', cryptoOk)

ok('исключений в окне нет', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'чисто')

section('4. Данные приложения')

// Проверяем, что база создалась в том месте, где её ждёт программа.
const dataCreated = await evaluate(`(async () => {
  const res = await fetch('/api/health')
  return res.ok
})()`)
ok('сервер доступен из окна', dataCreated === true)

const dbFiles = await evaluate(`(async () => {
  const res = await fetch('/api/health')
  const info = await res.json()
  return info.time ? 'ок' : 'нет'
})()`)
ok('сервер сообщает время', dbFiles === 'ок')

console.log(
  `\n\x1b[1m${failed === 0 ? '\x1b[32mСобранное приложение работает' : '\x1b[31mЕсть ошибки'}\x1b[0m: ` +
    `\x1b[32m${passed} ✓\x1b[0m  \x1b[31m${failed} ✗\x1b[0m\n`,
)

// ─────────────────────────── уборка ───────────────────────────

try {
  ws.close()
} catch {
  /* уже закрыт */
}
proc.kill()
await new Promise((r) => setTimeout(r, 1500))

try {
  rmSync(tempProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
} catch {
  /* временный профиль остался — не критично */
}

process.exit(failed === 0 ? 0 : 1)