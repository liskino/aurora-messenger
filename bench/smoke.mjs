/**
 * Проверка запуска собранного приложения.
 *
 * Открывает production-сборку в настоящем браузере и убеждается, что
 * страница поднимается: нет ошибок в консоли, экран входа отрисован,
 * предупреждение о ненастроенном бэкенде показано. Это ловит поломки,
 * которые сборка пропускает молча.
 *
 * Запуск: node bench/smoke.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const DIST = path.resolve('dist')
const PORT = 4400

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const server = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  const file = path.join(DIST, url === '/' ? '/index.html' : url)
  if (!file.startsWith(DIST) || !fs.existsSync(file)) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

function findBrowser() {
  const list = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)
  for (const p of list) if (fs.existsSync(p)) return p
  throw new Error('Браузер не найден')
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-smoke-'))
const DEBUG_PORT = 9334
const browser = spawn(findBrowser(), [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--disable-extensions',
  'about:blank',
], { stdio: 'ignore' })

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* ждём */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('Браузер не ответил')
}

const t = await target()
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r, j) => {
  ws.addEventListener('open', r)
  ws.addEventListener('error', () => j(new Error('ws')))
})

let id = 0
const pending = new Map()
const consoleErrors = []
const pageErrors = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
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
    setTimeout(() => pending.delete(n) && reject(new Error(`тайм-аут ${method}`)), 60_000)
  })

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'ошибка')
  return r.result.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await new Promise((r) => setTimeout(r, 3500))

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[90m', B: '\x1b[1m', m: '\x1b[35m', x: '\x1b[0m' }

console.log(`\n${C.B}${C.m}Aurora · проверка запуска приложения${C.x}\n`)

const checks = []
const bodyText = await evaluate('document.body.innerText')
const hasRoot = await evaluate('Boolean(document.querySelector("#root")?.children.length)')
const hasTitle = await evaluate('document.title')
const hasAuth = await evaluate('document.body.innerText.includes("Aurora")')
const hasWarning = await evaluate(
  'document.body.innerText.includes("Бэкенд не подключён") || document.body.innerText.includes(".env.local")',
)
const modeToggle = await evaluate(
  'document.body.innerText.includes("Вход") && document.body.innerText.includes("Регистрация")',
)
const cssLoaded = await evaluate(
  'getComputedStyle(document.body).backgroundColor',
)
const cryptoApi = await evaluate('Boolean(window.crypto?.subtle)')

checks.push(['страница отрисована', hasRoot, `#root заполнен`])
checks.push(['заголовок документа', hasTitle.includes('Aurora'), hasTitle])
checks.push(['экран входа показан', hasAuth, 'найдено название приложения'])
checks.push(['переключатель вход/регистрация', modeToggle, 'обе вкладки на месте'])
checks.push([
  'предупреждение о бэкенде',
  hasWarning,
  'подсказка про .env.local показана — сборка без ключей ведёт себя корректно',
])
checks.push(['стили применились', cssLoaded !== 'rgba(0, 0, 0, 0)', `фон ${cssLoaded}`])
checks.push(['WebCrypto доступен', cryptoApi, 'шифрование в браузере возможно'])
checks.push(['ошибок в консоли нет', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || 'чисто'])
checks.push(['исключений в странице нет', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'чисто'])

let failed = 0
for (const [name, pass, detail] of checks) {
  if (!pass) failed++
  console.log(`  ${pass ? C.g + '✓' : C.r + '✗'}${C.x} ${name}  ${C.d}${detail}${C.x}`)
}

console.log(
  `\n${C.B}${failed === 0 ? C.g + 'Приложение запускается корректно' : C.r + 'Есть замечания'}${C.x}`,
)
console.log(`${C.d}Фрагмент экрана:${C.x} ${bodyText.replace(/\s+/g, ' ').slice(0, 150)}…\n`)

ws.close()
server.close()
browser.kill()
await new Promise((r) => setTimeout(r, 500))
try {
  fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
} catch {
  /* не критично */
}

process.exit(failed === 0 ? 0 : 1)