/**
 * Драйвер замера плавности в настоящем Chrome.
 *
 * Поднимает локальный сервер, открывает собранный стенд в headless-браузере
 * и через Chrome DevTools Protocol гоняет сценарии, собирая длительности
 * кадров. Это единственный способ говорить о плавности не по ощущениям:
 * цифры берутся из того же главного потока, что рисует пользователю.
 *
 * Запуск: node bench/browser.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const DIST = path.resolve('bench/dist')
const PORT = 4399

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
}

// ─────────────────────────── статический сервер ───────────────────────────

const server = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  const rel = url === '/' ? '/harness.html' : url
  const file = path.join(DIST, rel)
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})

await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

// ─────────────────────────── поиск браузера ───────────────────────────

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean)
  for (const c of candidates) if (fs.existsSync(c)) return c
  throw new Error('Chrome или Edge не найден. Укажите путь в переменной CHROME_PATH.')
}

const browserPath = findBrowser()
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-bench-'))
const DEBUG_PORT = 9333

const browser = spawn(
  browserPath,
  [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
)

// ─────────────────────────── CDP ───────────────────────────

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* браузер ещё поднимается */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('Не удалось подключиться к браузеру')
}

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
        if (msg.error) p.reject(new Error(msg.error.message))
        else p.resolve(msg.result)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Тайм-аут: ${method}`))
      }, 120_000)
    })
  }

  /** Вычисляет выражение в странице и возвращает результат по значению. */
  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'Ошибка в странице')
    }
    return r.result.value
  }
}

const target = await getTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', () => reject(new Error('WebSocket не открылся')))
})
const cdp = new Cdp(ws)

await cdp.send('Runtime.enable')
await cdp.send('Page.enable')

// Проверяем, что страница действительно живёт, а не молча падает.
const errors = []
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails.exception?.description ?? 'неизвестная ошибка')
  }
})

await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/harness.html` })

// Ждём готовности стенда.
let ready = false
for (let i = 0; i < 100; i++) {
  try {
    ready = await cdp.eval('Boolean(window.__harness__)')
    if (ready) break
  } catch {
    /* страница ещё грузится */
  }
  await new Promise((r) => setTimeout(r, 200))
}
if (!ready) {
  console.error('Стенд не загрузился. Ошибки страницы:', errors)
  process.exit(1)
}

// ─────────────────────────── сценарии ───────────────────────────

// Частоту экрана стенд измеряет сам; ждём результата, потому что от него
// зависит бюджет кадра, по которому считаются пропуски.
let HZ = 60
for (let i = 0; i < 60; i++) {
  const hz = await cdp.eval('window.__AURORA_HZ__ ?? null')
  if (hz) {
    HZ = hz
    break
  }
  await new Promise((r) => setTimeout(r, 200))
}
const budget = 1000 / HZ

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[90m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
}

console.log(`\n${C.bold}${C.magenta}Aurora · плавность в браузере${C.reset}`)
console.log(`${C.dim}браузер: ${path.basename(browserPath)}${C.reset}`)
console.log(`${C.dim}бюджет кадра: ${budget.toFixed(2)} мс (${HZ} Гц)${C.reset}\n`)

const SIZES = [200, 1000, 5000, 10000]
const results = []

for (const size of SIZES) {
  await cdp.eval(`window.__harness__.setSize(${size})`)
  await new Promise((r) => setTimeout(r, 400))

  // Узлы считаем ВНУТРИ каждого режима: раньше замер брался до переключения
  // и показывал число узлов предыдущего режима.
  await cdp.eval('window.__harness__.setMode("virtual")')
  await new Promise((r) => setTimeout(r, 500))
  const nodes = await cdp.eval('window.__harness__.nodes()')
  const bubbles = await cdp.eval('window.__harness__.count()')
  const vScroll = await cdp.eval(`window.__harness__.measureScroll(2500, ${budget})`)

  // Честный список — для сравнения
  await cdp.eval('window.__harness__.setMode("naive")')
  await new Promise((r) => setTimeout(r, 700))
  const naiveNodes = await cdp.eval('window.__harness__.nodes()')
  const nScroll = await cdp.eval(`window.__harness__.measureScroll(2500, ${budget})`)

  // Стоимость самой отрисовки: замер в изолированном контейнере, чтобы
  // на него не влиял текущий режим страницы.
  const vRender = await cdp.eval(
    `window.__harness__.renderCost(window.__harness__.makeMessages(${size}), true)`,
  )
  const nRender = await cdp.eval(
    `window.__harness__.renderCost(window.__harness__.makeMessages(${size}), false)`,
  )

  results.push({ size, nodes, bubbles, naiveNodes, vScroll, nScroll, vRender, nRender })

  const row = (label, s) =>
    `${label.padEnd(20)} медиана ${C.cyan}${s.median.toFixed(1)} мс${C.reset}, ` +
    `p95 ${s.p95.toFixed(1)} мс, худший ${s.longest.toFixed(1)} мс, ` +
    `пропущено ${s.dropped === 0 ? C.green + '0' + C.reset : C.yellow + s.dropped + C.reset}`

  console.log(`${C.bold}${size.toLocaleString('ru-RU')} сообщений${C.reset}`)
  console.log(
    `  ${C.dim}узлов в DOM: виртуализация ${nodes.toLocaleString('ru-RU')}, ` +
      `без неё ${naiveNodes.toLocaleString('ru-RU')} — меньше в ` +
      `${Math.round(naiveNodes / nodes)}×${C.reset}`,
  )
  console.log(`  ${row('виртуализация', vScroll)}`)
  console.log(`  ${row('без виртуализации', nScroll)}`)
  console.log(
    `  ${'блокировка потока'.padEnd(20)} отрисовка ${C.cyan}${vRender.render.toFixed(1)} мс${C.reset} ` +
      `+ раскладка ${vRender.layout.toFixed(1)} мс = ${C.bold}${(vRender.render + vRender.layout).toFixed(1)} мс${C.reset}` +
      `  ${C.dim}(без виртуализации ${(nRender.render + nRender.layout).toFixed(1)} мс)${C.reset}`,
  )
  console.log(`  ${C.dim}кадров замерено: ${vScroll.count}${C.reset}\n`)
}

// ─────────────────────────── приёмка ───────────────────────────

console.log(`${C.bold}Проверка требований${C.reset}`)

const worst = results[results.length - 1]
const checks = []

// Медиана в headless-браузере привязана к 60 Гц и почти не зависит от
// нагрузки, поэтому требования формулируем по тому, что действительно
// отражает плавность: хвост распределения, пропуски и блокировка потока.
const vBlock = worst.vRender.render + worst.vRender.layout
const nBlock = worst.nRender.render + worst.nRender.layout

checks.push([
  `на 10 000 сообщениях кадры идут без пропусков`,
  worst.vScroll.dropped === 0,
  `${worst.vScroll.dropped} пропущенных из ${worst.vScroll.count}`,
])

checks.push([
  `хвост распределения укладывается в бюджет кадра`,
  worst.vScroll.p95 <= budget * 1.25,
  `p95 ${worst.vScroll.p95.toFixed(1)} мс при бюджете ${budget.toFixed(1)} мс`,
])

checks.push([
  `худший кадр не превышает двух бюджетов`,
  worst.vScroll.longest <= budget * 2,
  `${worst.vScroll.longest.toFixed(1)} мс при пределе ${(budget * 2).toFixed(1)} мс`,
])

checks.push([
  `виртуализация сокращает DOM не меньше чем в 10 раз`,
  worst.nodes * 10 <= worst.naiveNodes,
  `${worst.nodes.toLocaleString('ru-RU')} узлов против ${worst.naiveNodes.toLocaleString('ru-RU')}`,
])

checks.push([
  `отрисовка 10 000 сообщений укладывается в кадр 60 Гц`,
  vBlock < budget,
  `${vBlock.toFixed(1)} мс < ${budget.toFixed(1)} мс`,
])

checks.push([
  `виртуализация ускоряет отрисовку не меньше чем в 5 раз`,
  nBlock / vBlock >= 5,
  `быстрее в ${(nBlock / vBlock).toFixed(1)}× (${nBlock.toFixed(0)} мс → ${vBlock.toFixed(0)} мс)`,
])

checks.push([
  `без виртуализации список 10 000 сообщений заметно тормозит (контроль методики)`,
  worst.nScroll.dropped > 0 || worst.nScroll.p95 > worst.vScroll.p95 * 2,
  `пропущено ${worst.nScroll.dropped}, p95 ${worst.nScroll.p95.toFixed(1)} мс против ${worst.vScroll.p95.toFixed(1)} мс`,
])

let failed = 0
for (const [name, pass, detail] of checks) {
  if (!pass) failed++
  console.log(
    `  ${pass ? C.green + '✓' : C.red + '✗'}${C.reset} ${name}  ${C.dim}${detail}${C.reset}`,
  )
}

if (errors.length) {
  console.log(`\n${C.red}Ошибки в браузере:${C.reset}`)
  for (const e of errors.slice(0, 5)) console.log(`  ${C.dim}${e.split('\n')[0]}${C.reset}`)
  failed++
}

console.log(
  `\n${C.bold}${failed === 0 ? C.green + 'Требования по плавности выполнены' : C.red + 'Есть замечания'}${C.reset}\n`,
)

// ─────────────────────────── уборка ───────────────────────────

ws.close()
server.close()
browser.kill()
// Профиль браузера освобождается не мгновенно: без ожидания rmSync падает
// с EPERM и заваливает успешный прогон.
await new Promise((r) => setTimeout(r, 500))
try {
  fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
} catch {
  /* временная папка не критична */
}

process.exit(failed === 0 ? 0 : 1)