/**
 * Aurora — главный процесс программы.
 *
 * Это настоящее приложение Windows: открывается окно, а не вкладка браузера.
 * Внутри окна работает тот же код, что и в веб-версии, но человеку не нужно
 * ничего устанавливать — ни Node.js, ни браузер.
 *
 * Сервер запускается модулем прямо в этом процессе — без дочернего процесса:
 * тогда не нужны файлы-логи для обмена «какой порт достался», а остановка
 * программы гарантированно останавливает и сервер.
 */

import { app, BrowserWindow, shell, dialog } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Порт по умолчанию: обычные 80/443 заняты слишком часто, 3000-е — тоже. */
const DEFAULT_PORT = 4321

// Один экземпляр программы: два окна с одной базой SQLite — это конфликты
// записи и дубликаты уведомлений. Второй запуск поднимает уже открытое.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  console.log('AURORA_ALREADY_RUNNING')
  app.quit()
}

let mainWindow = null

// ─────────────────────────── пути ───────────────────────────

/**
 * Папка с данными: база переписки и файлы.
 *
 * В собранном приложении — в AppData: Program Files защищена от записи.
 * В разработке — рядом с программой, чтобы данные было видно и переносимо.
 */
function dataDir() {
  if (app.isPackaged) {
    const dir = join(app.getPath('userData'), 'data')
    mkdirSync(dir, { recursive: true })
    return dir
  }
  return join(__dirname, 'data')
}

/**
 * Папка собранного интерфейса.
 *
 * В разработке файлы лежат в корне проекта, рядом с папкой electron.
 * Без подъёма на уровень выше получался путь «electron/dist», которого нет,
 * и сервер честно отвечал «Клиент не собран» — окно открывалось пустым.
 */
function clientDir() {
  if (app.isPackaged) {
    // В упакованном приложении файлы распакованы из архива и лежат в ресурсах.
    return join(process.resourcesPath, 'app.asar.unpacked', 'dist')
  }
  return join(__dirname, '..', 'dist')
}

// ─────────────────────────── запуск сервера ───────────────────────────

/**
 * Поднимает сервер прямо в этом процессе.
 *
 * Модули сервера написаны под Node, и в Electron они работают как есть:
 * Electron включает Node. Код сервера один и тот же для веб-версии и для
 * программы — расхождение двух реализаций было бы источником ошибок.
 *
 * Импорт идёт через pathToFileURL: на Windows абсолютный путь вида «C:\…»
 * загрузчик ESM не принимает и падает с «Received protocol 'c:'». Именно
 * на этом программа и не запускалась — окно не появлялось, а процесс
 * молча завершался.
 */
async function startServer() {
  const isDev = !app.isPackaged
  const serverRoot = isDev
    ? join(__dirname, '..', 'server')
    : join(process.resourcesPath, 'app.asar.unpacked', 'server')

  // Переменные окружения вместо правки кода: сервер читает пути из них.
  process.env.AURORA_DATA_DIR = dataDir()
  process.env.AURORA_CLIENT_DIR = clientDir()

  const db = await import(pathToFileURL(join(serverRoot, 'db.mjs')).href)
  const index = await import(pathToFileURL(join(serverRoot, 'index.mjs')).href)

  // start() подбирает свободный порт и возвращает занятый.
  const { port, server } = await index.start(DEFAULT_PORT, '127.0.0.1')
  return { port, server, db }
}

// ─────────────────────────── удалённый сервер ───────────────────────────

/**
 * Публичный сервер: та же Aurora, но общая — как веб-версия.
 *
 * Приложение — теперь «клиент» наравне с браузером: если на GitHub опубликована
 * живая ссылка, окно открывает её, и переписка общая с веб-версией. Ссылку
 * публикует start-public.ps1 на домашнем ПК (меняется при каждом запуске —
 * поэтому читаем её каждый раз при старте, а не храним).
 */
const REMOTE_URL_FILE =
  'https://raw.githubusercontent.com/liskino/aurora-messenger/master/server-url.txt'

/** Ручной адрес: файл server.txt рядом с данными (userData). */
function manualServerUrl() {
  try {
    const manual = readFileSync(join(app.getPath('userData'), 'server.txt'), 'utf8').trim()
    if (/^https?:\/\//.test(manual)) return manual
  } catch {
    /* файла нет — обычный случай */
  }
  return null
}

/** Живая ли ссылка: сервер должен ответить на /api/health. */
async function alive(url) {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/health`, {
      signal: AbortSignal.timeout(8000),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Решает, к какому серверу подключаться.
 *
 * Порядок: файл server.txt (ручной адрес) → GitHub server-url.txt → null.
 * Ссылка с GitHub проверяется на живость: «OFFLINE» или мёртвый адрес
 * означают «сервер не включён», и программа честно поднимает свой
 * локальный сервер, как раньше.
 */
async function resolveRemoteServer() {
  const manual = manualServerUrl()
  if (manual) {
    if (await alive(manual)) return manual
    console.log('AURORA_REMOTE_MANUAL_DEAD')
    return null
  }

  try {
    const res = await fetch(REMOTE_URL_FILE, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const first = (await res.text()).split('\n')[0].trim()
    if (!/^https?:\/\//.test(first)) return null // OFFLINE или мусор
    if (await alive(first)) return first
    console.log('AURORA_REMOTE_STALE')
  } catch {
    /* нет интернета — тихо падаем на локальный сервер */
  }
  return null
}

// ─────────────────────────── окно ───────────────────────────

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 680,
    minHeight: 520,
    backgroundColor: '#08080c',
    show: false,
    autoHideMenuBar: true,
    title: 'Aurora',
    webPreferences: {
      // Никакого Node в окне: интерфейс — обычная страница. Весь Node —
      // в этом процессе, и доступ из страницы к файлам был бы дырой.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win.show())

  // Публичная ссылка меняется при перезапуске сервера: если страница не
  // загрузилась, перечитываем адрес и перезагружаем окно один раз.
  if (url.startsWith('https://')) {
    win.webContents.on('did-fail-load', async (_e, code) => {
      if (code === -3 /* ERR_ABORTED */) return
      const fresh = manualServerUrl() ?? (await resolveRemoteServer())
      if (fresh && fresh !== url) void win.loadURL(fresh)
    })
  }

  // Ссылки из переписки открываются в браузере, а не внутри мессенджера:
  // чужой сайт внутри окна программы выглядел бы как её часть.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (
      target.startsWith('http://localhost') ||
      target.startsWith('http://127.0.0.1') ||
      target.startsWith('https://') && target.endsWith('.trycloudflare.com')
    ) {
      return { action: 'allow' }
    }
    void shell.openExternal(target)
    return { action: 'deny' }
  })

  void win.loadURL(url)
  return win
}

// ─────────────────────────── жизненный цикл ───────────────────────────

app.whenReady().then(async () => {
  try {
    // Сначала — публичный сервер с GitHub (общая база с веб-версией).
    const remote = await resolveRemoteServer()

    if (remote) {
      console.log('AURORA_REMOTE=' + remote)
      mainWindow = createWindow(remote)
    } else {
      // Публичного нет — поднимаем свой, как раньше.
      const { port } = await startServer()
      console.log('AURORA_SERVER_PORT=' + port)
      mainWindow = createWindow(`http://127.0.0.1:${port}`)
    }

    mainWindow.on('closed', () => {
      mainWindow = null
    })

    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
      }
    })
  } catch (e) {
    console.error('START FAIL:', e.message)
    // Причина ошибки — на экран, а не в консоль, которой у человека нет.
    void dialog.showErrorBox(
      'Aurora не запустился',
      `${e.message}\n\nПроверьте, что программа установлена полностью ` +
        `и на диске есть свободное место.`,
    )
    app.quit()
  }
}).catch((e) => {
  console.error('WHENREADY FAIL:', e.message)
  process.exit(1)
})

app.on('window-all-closed', () => {
  // Единственное окно закрыто — программа завершается целиком.
  app.quit()
})