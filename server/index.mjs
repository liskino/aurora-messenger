/**
 * Aurora — автономный сервер мессенджера.
 *
 * Ничего внешнего не требует: база — SQLite из состава Node.js, файлы —
 * папка на диске, realtime — SSE. Запускается одной командой и работает.
 *
 * ─── Границы доверия ──────────────────────────────────────────────────
 *
 * Сервер видит:
 *   • кто с кем переписывается и когда;
 *   • размеры сообщений и файлов;
 *   • открытые ключи участников.
 *
 * Сервер НЕ видит:
 *   • текст сообщений (шифруется в браузере ключом чата);
 *   • имена файлов (шифруются отдельно);
 *   • содержимое файлов (шифруется блоками);
 *   • приватные ключи в открытом виде (только зашифрованными паролем).
 *
 * Проверить это можно не на слово: в базе нет ни одного поля с открытым
 * текстом, а тесты отдельно удостоверяются, что исходные байты файла в
 * хранилище не встречаются.
 */
import { createServer } from 'node:http'
import { stat, mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { join, extname, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

import * as db from './db.mjs'
import * as auth from './auth.mjs'
import * as rt from './realtime.mjs'
import * as turn from './turn.mjs'

const PORT = Number(process.env.PORT || 4321)
const HOST = process.env.HOST || '0.0.0.0'

/** Предел размера одного файла: 200 МБ. Больше — это уже не мессенджер. */
const MAX_UPLOAD = 200 * 1024 * 1024
const MAX_JSON = 4 * 1024 * 1024

// ─────────────────────────── утилиты ответа ───────────────────────────

function json(res, status, body) {
  const data = JSON.stringify(body)
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    // Ответы API не должны кешироваться: это переписка, а не картинки.
    'Cache-Control': 'no-store',
  }
  // Время работы сервера — для замеров скорости, отличимых от сети.
  if (res.startedAt) {
    headers['X-Response-Time'] = (
      Number(process.hrtime.bigint() - res.startedAt) / 1e6
    ).toFixed(2)
  }
  res.writeHead(status, headers)
  res.end(data)
}

function fail(res, status, message, code) {
  json(res, status, { error: message, code })
}

async function readJson(req, limit = MAX_JSON) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('Слишком большой запрос')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('Некорректный JSON')
  }
}

async function readBody(req, limit = MAX_UPLOAD) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const err = new Error('Файл слишком большой (предел 200 МБ)')
      err.status = 413
      throw err
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Достаёт токен сессии из заголовка или из query (для SSE). */
function tokenOf(req, url) {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7)
  return url.searchParams.get('token')
}

/** Требует авторизации: возвращает пользователя или сам пишет ошибку. */
function requireUser(req, res, url) {
  const user = auth.sessionUser(tokenOf(req, url))
  if (!user) {
    fail(res, 401, 'Требуется вход', 'UNAUTHORIZED')
    return null
  }
  return user
}

/** Есть ли пользователь в чате: граница доступа к переписке. */
function isMember(chatId, userId) {
  return Boolean(
    db.get('select 1 as ok from chat_members where chat_id = ? and user_id = ?', chatId, userId),
  )
}

function memberIds(chatId) {
  return db
    .all('select user_id from chat_members where chat_id = ?', chatId)
    .map((r) => r.user_id)
}

function requireMembership(chatId, userId) {
  if (!isMember(chatId, userId)) {
    const err = new Error('Нет доступа к этому чату')
    err.status = 403
    throw err
  }
}

// ─────────────────────────── профили ───────────────────────────

function profileRow(userId) {
  return db.get('select * from profiles where user_id = ?', userId)
}

function publicProfile(row) {
  return {
    id: row.user_id,
    username: row.username,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    public_key: row.public_key,
    wrapped_private: row.wrapped_private,
    kdf_salt: row.kdf_salt,
    kdf_iterations: row.kdf_iterations,
    last_seen: row.last_seen,
    created_at: row.created_at,
  }
}

// ─────────────────────────── маршруты ───────────────────────────

const routes = []
function route(method, pattern, handler) {
  // Простой разбор пути с параметрами вида /api/chats/:id
  const parts = pattern.split('/').filter(Boolean)
  routes.push({ method, parts, handler })
}

async function dispatch(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean)

  for (const r of routes) {
    if (r.method !== req.method) continue
    if (r.parts.length !== parts.length) continue

    const params = {}
    let matched = true
    for (let i = 0; i < r.parts.length; i++) {
      const p = r.parts[i]
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(parts[i])
      else if (p !== parts[i]) {
        matched = false
        break
      }
    }
    if (matched) return r.handler(req, res, url, params)
  }

  return fail(res, 404, 'Не найдено', 'NOT_FOUND')
}

// ── служебное ──

route('GET', '/api/health', async (_req, res) => {
  json(res, 200, {
    ok: true,
    name: 'Aurora',
    version: '1.0.0',
    time: db.now(),
    realtime: rt.stats(),
    // Клиент показывает это на экране входа, чтобы было видно: сервер свой.
    capabilities: { calls: true, files: true, groups: true, e2e: true },
    turn: turn.turnStatus(),
  })
})

/**
 * Настройки ICE для звонков.
 *
 * Клиент получает готовый список серверов — включая встроенный TURN —
 * и сразу использует его в звонке. Человеку не нужно ничего вводить.
 */
route('GET', '/api/ice', async (req, res, url) => {
  const user = requireUser(req, res, url)
  if (!user) return

  // Адрес берём из запроса: клиент обращается к серверу по конкретному
  // хосту, и TURN должен быть доступен по тому же адресу.
  const host = (req.headers.host || '127.0.0.1').split(':')[0]
  json(res, 200, { iceServers: turn.iceServersFor(host) })
})

// ── регистрация и вход ──

route('POST', '/api/auth/register', async (req, res) => {
  const body = await readJson(req)

  const email = String(body.email ?? '').trim()
  const password = String(body.password ?? '')
  const username = String(body.username ?? '').trim().toLowerCase()
  const displayName = String(body.display_name ?? '').trim() || username

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return fail(res, 400, 'Проверьте адрес почты', 'BAD_EMAIL')
  }
  if (password.length < 8) {
    return fail(res, 400, 'Пароль не короче 8 символов', 'WEAK_PASSWORD')
  }
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    return fail(res, 400, 'Логин: 3–24 символа, латиница, цифры, подчёркивание', 'BAD_USERNAME')
  }
  if (!body.public_key || !body.wrapped_private || !body.kdf_salt) {
    return fail(res, 400, 'Не переданы ключи шифрования', 'NO_KEYS')
  }
  if (db.get('select 1 as x from profiles where username = ?', username)) {
    return fail(res, 409, 'Этот логин уже занят', 'USERNAME_TAKEN')
  }

  try {
    const user = auth.registerUser(email, password)

    db.run(
      `insert into profiles
         (user_id, username, display_name, public_key, wrapped_private, kdf_salt, kdf_iterations, last_seen, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      user.id,
      username,
      displayName,
      body.public_key,
      body.wrapped_private,
      body.kdf_salt,
      Number(body.kdf_iterations) || 600000,
      db.now(),
      db.now(),
    )

    const session = auth.createSession(user.id, req.headers['user-agent'])
    json(res, 201, {
      user: { id: user.id, email: user.email },
      token: session.token,
      profile: publicProfile(profileRow(user.id)),
    })
  } catch (e) {
    if (e.code === 'EMAIL_TAKEN') return fail(res, 409, e.message, e.code)
    throw e
  }
})

route('POST', '/api/auth/login', async (req, res) => {
  const body = await readJson(req)
  try {
    const user = auth.loginUser(String(body.email ?? ''), String(body.password ?? ''))
    const profile = profileRow(user.id)
    if (!profile) return fail(res, 404, 'Профиль не найден', 'NO_PROFILE')

    const session = auth.createSession(user.id, req.headers['user-agent'])
    db.run('update profiles set last_seen = ? where user_id = ?', db.now(), user.id)

    json(res, 200, {
      user: { id: user.id, email: user.email },
      token: session.token,
      profile: publicProfile(profile),
    })
  } catch (e) {
    if (e.code === 'BAD_CREDENTIALS') return fail(res, 401, e.message, e.code)
    throw e
  }
})

route('POST', '/api/auth/logout', async (req, res, url) => {
  auth.destroySession(tokenOf(req, url))
  json(res, 200, { ok: true })
})

/** Проверка живой сессии при открытии страницы — вход без пароля. */
route('GET', '/api/auth/session', async (req, res, url) => {
  const user = auth.sessionUser(tokenOf(req, url))
  if (!user) return fail(res, 401, 'Сессии нет', 'NO_SESSION')
  const profile = profileRow(user.id)
  if (!profile) return fail(res, 404, 'Профиль не найден', 'NO_PROFILE')
  json(res, 200, { user, profile: publicProfile(profile) })
})

// ── профили ──

route('GET', '/api/profiles/:id', async (req, res, url, { id }) => {
  const user = requireUser(req, res, url)
  if (!user) return
  const row = profileRow(id)
  if (!row) return fail(res, 404, 'Пользователь не найден', 'NOT_FOUND')
  json(res, 200, publicProfile(row))
})

route('POST', '/api/profiles/by-ids', async (req, res, url) => {
  const user = requireUser(req, res, url)
  if (!user) return
  const ids = (await readJson(req)).ids ?? []
  if (!Array.isArray(ids) || !ids.length) return json(res, 200, [])

  const placeholders = ids.map(() => '?').join(',')
  const rows = db.all(`select * from profiles where user_id in (${placeholders})`, ...ids)
  json(res, 200, rows.map(publicProfile))
})

route('GET', '/api/profiles/search/:query', async (req, res, url, { query }) => {
  const user = requireUser(req, res, url)
  if (!user) return
  const q = query.trim()
  if (q.length < 2) return json(res, 200, [])

  // ESCAPE нужен, чтобы символы % и _ в запросе не превращались в шаблоны.
  const safe = q.replace(/[%_\\]/g, '\\$&')
  const rows = db.all(
    `select * from profiles
      where username like ? escape '\\' and user_id != ?
      order by username limit 20`,
    `%${safe}%`,
    user.id,
  )
  json(res, 200, rows.map(publicProfile))
})

// ── устройства ──

/**
 * Регистрирует устройство.
 * Опознаём по отпечатку браузера: иначе список устройств превращается
 * в мусор из десятков записей после нескольких входов.
 */
route('POST', '/api/devices', async (req, res, url) => {
  const user = requireUser(req, res, url)
  if (!user) return
  const body = await readJson(req)
  const label = String(body.label ?? 'Устройство').slice(0, 80)
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 250)

  const existing = db.get('select * from devices where user_id = ? and label = ?', user.id, label)
  if (existing) {
    db.run('update devices set last_active = ?, user_agent = ? where id = ?', db.now(), ua, existing.id)
    return json(res, 200, { id: existing.id, label, last_active: db.now() })
  }

  const id = randomUUID()
  db.run(
    'insert into devices (id, user_id, label, user_agent, last_active, created_at) values (?, ?, ?, ?, ?, ?)',
    id,
    user.id,
    label,
    ua,
    db.now(),
    db.now(),
  )
  json(res, 201, { id, label, last_active: db.now() })
})

route('GET', '/api/devices', async (req, res, url) => {
  const user = requireUser(req, res, url)
  if (!user) return
  json(res, 200, db.all('select * from devices where user_id = ? order by last_active desc', user.id))
})

route('DELETE', '/api/devices/:id', async (req, res, url, { id }) => {
  const user = requireUser(req, res, url)
  if (!user) return
  db.run('delete from devices where id = ? and user_id = ?', id, user.id)
  json(res, 200, { ok: true })
})

route('POST', '/api/devices/:id/ping', async (req, res, url, { id }) => {
  const user = requireUser(req, res, url)
  if (!user) return
  db.run('update devices set last_active = ? where id = ? and user_id = ?', db.now(), id, user.id)
  db.run('update profiles set last_seen = ? where user_id = ?', db.now(), user.id)
  json(res, 200, { ok: true })
})

// ── чаты ──

route('POST', '/api/chats', async (req, res, url) => {
  const user = requireUser(req, res, url)
  if (!user) return
  const body = await readJson(req)

  const kind = body.kind === 'group' ? 'group' : 'direct'
  const title = body.title ? String(body.title).slice(0, 80) : null
  const members = Array.isArray(body.members) ? body.members : []

  if (!members.length) return fail(res, 400, 'Не переданы участники', 'NO_MEMBERS')

  const chat = db.transaction(() => {
    const id = randomUUID()
    db.run(
      'insert into chats (id, kind, title, created_by, created_at) values (?, ?, ?, ?, ?)',
      id,
      kind,
      title,
      user.id,
      db.now(),
    )

    // Ключ чата для каждого участника уже зашифрован на клиенте —
    // сервер только раскладывает готовые обёртки по местам.
    for (const m of members) {
      db.run(
        'insert into chat_members (chat_id, user_id, wrapped_key, joined_at) values (?, ?, ?, ?)',
        id,
        m.user_id,
        m.wrapped_key,
        db.now(),
      )
    }
    return db.get('select * from chats where id = ?', id)
  })

  // Участникам сообщаем сразу: у них должен появиться чат в списке.
  rt.emitToMany(
    members.map((m) => m.user_id).filter((id) => id !== user.id),
    'chat',
    { chat },
  )

  json(res, 201, chat)
})

route('GET', '/api/chats/mine', async (req, res, url) => {
  const user = requireUser(req, res, url)
  if (!user) return
  const rows = db.all(
    `select c.* from chats c
       join chat_members m on m.chat_id = c.id
      where m.user_id = ?
      order by c.created_at desc`,
    user.id,
  )
  json(res, 200, rows)
})

route('POST', '/api/chats/by-ids', async (req, res, url) => {
  const user = requireUser(req, res, url)
  if (!user) return
  const ids = (await readJson(req)).ids ?? []
  if (!ids.length) return json(res, 200, [])
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.all(`select * from chats where id in (${placeholders})`, ...ids)
  // Отдаём только те чаты, где пользователь состоит: иначе по угаданному
  // идентификатору можно было бы увидеть чужую переписку.
  json(res, 200, rows.filter((c) => isMember(c.id, user.id)))
})

route('GET', '/api/chats/:id/members', async (req, res, url, { id }) => {
  const user = requireUser(req, res, url)
  if (!user) return
  try {
    requireMembership(id, user.id)
  } catch (e) {
    return fail(res, e.status ?? 403, e.message)
  }
  json(res, 200, db.all('select * from chat_members where chat_id = ?', id))
})

route('GET', '/api/memberships', async (req, res, url) => {
  const user = requireUser(req, res, url)
  if (!user) return
  json(res, 200, db.all('select * from chat_members where user_id = ?', user.id))
})

route('POST', '/api/chats/:id/members', async (req, res, url, { id }) => {
  const user = requireUser(req, res, url)
  if (!user) return
  try {
    requireMembership(id, user.id)
  } catch (e) {
    return fail(res, e.status ?? 403, e.message)
  }

  const rows = (await readJson(req)).members ?? []
  if (!rows.length) return fail(res, 400, 'Не переданы участники')

  db.transaction(() => {
    for (const m of rows) {
      db.run(
        `insert into chat_members (chat_id, user_id, wrapped_key, joined_at)
         values (?, ?, ?, ?)
         on conflict(chat_id, user_id) do update set wrapped_key = excluded.wrapped_key`,
        id,
        m.user_id,
        m.wrapped_key,
        db.now(),
      )
    }
  })

  rt.emitToMany(
    rows.map((m) => m.user_id),
    'chat',
    { chat: db.get('select * from chats where id = ?', id) },
  )
  json(res, 200, { ok: true })
})

route('DELETE', '/api/chats/:id/members/:userId', async (req, res, url, { id, userId }) => {
  const user = requireUser(req, res, url)
  if (!user) return
  try {
    requireMembership(id, user.id)
  } catch (e) {
    return fail(res, e.status ?? 403, e.message)
  }

  const chat = db.get('select * from chats where id = ?', id)
  // Создателя не удаляем: без него у группы не остаётся владельца ключа,
  // и приглашать новых участников станет некому.
  if (chat?.created_by === userId && user.id !== userId) {
    return fail(res, 403, 'Создателя группы нельзя исключить')
  }

  db.run('delete from chat_members where chat_id = ? and user_id = ?', id, userId)
  rt.emitTo(userId, 'removed', { chatId: id })
  json(res, 200, { ok: true })
})

route('PATCH', '/api/chats/:id', async (req, res, url, { id }) => {
  const user = requireUser(req, res, url)
  if (!user) return
  try {
    requireMembership(id, user.id)
  } catch (e) {
    return fail(res, e.status ?? 403, e.message)
  }

  const title = String((await readJson(req)).title ?? '').trim().slice(0, 80)
  if (!title) return fail(res, 400, 'Название не может быть пустым')

  db.run('update chats set title = ? where id = ?', title, id)
  rt.emitToMany(memberIds(id), 'chat', { chat: db.get('select * from chats where id = ?', id) })
  json(res, 200, { ok: true, title })
})

// ── сообщения ──

route('POST', '/api/messages', async (req, res, url) => {
  const user = requireUser(req, res, url)
  if (!user) return
  const body = await readJson(req)
  const chatId = String(body.chat_id ?? '')

  try {
    requireMembership(chatId, user.id)
  } catch (e) {
    return fail(res, e.status ?? 403, e.message)
  }

  const id = randomUUID()
  db.run(
    `insert into messages
       (id, chat_id, sender_id, ciphertext, iv, kind, file_path,
        file_name_sealed, file_name_iv, file_type, file_size, wrapped_file_key, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    chatId,
    user.id,
    String(body.ciphertext ?? ''),
    String(body.iv ?? ''),
    body.kind === 'file' ? 'file' : 'text',
    body.file_path ?? null,
    body.file_name_sealed ?? null,
    body.file_name_iv ?? null,
    body.file_type ?? null,
    body.file_size ?? null,
    body.wrapped_file_key ?? null,
    db.now(),
  )

  const message = db.get('select * from messages where id = ?', id)
  // Рассылаем всем, кроме отправителя: у него сообщение уже показано
  // сразу, оптимистично, и повторная доставка вызвала бы дубликат.
  rt.emitToMany(
    memberIds(chatId).filter((uid) => uid !== user.id),
    'message',
    { message },
  )

  json(res, 201, message)
})

route('GET', '/api/chats/:id/messages', async (req, res, url, { id }) => {
  const user = requireUser(req, res, url)
  if (!user) return
  try {
    requireMembership(id, user.id)
  } catch (e) {
    return fail(res, e.status ?? 403, e.message)
  }

  const limit = Math.min(Number(url.searchParams.get('limit')) || 300, 1000)
  // Берём последние сообщения, но отдаём в хронологическом порядке:
  // иначе список переворачивается и прокрутка прыгает.
  const rows = db.all(
    `select * from (
       select * from messages where chat_id = ? order by created_at desc limit ?
     ) order by created_at asc`,
    id,
    limit,
  )
  json(res, 200, rows)
})

route('PATCH', '/api/messages/:id', async (req, res, url, { id }) => {
  const user = requireUser(req, res, url)
  if (!user) return
  const msg = db.get('select * from messages where id = ?', id)
  if (!msg) return fail(res, 404, 'Сообщение не найдено')
  if (msg.sender_id !== user.id) return fail(res, 403, 'Можно изменять только свои сообщения')

  const body = await readJson(req)
  db.run(
    'update messages set ciphertext = ?, iv = ?, edited_at = ? where id = ?',
    String(body.ciphertext ?? ''),
    String(body.iv ?? ''),
    db.now(),
    id,
  )

  const updated = db.get('select * from messages where id = ?', id)
  rt.emitToMany(memberIds(msg.chat_id), 'message_updated', { message: updated })
  json(res, 200, updated)
})

route('DELETE', '/api/messages/:id', async (req, res, url, { id }) => {
  const user = requireUser(req, res, url)
  if (!user) return
  const msg = db.get('select * from messages where id = ?', id)
  if (!msg) return fail(res, 404, 'Сообщение не найдено')
  if (msg.sender_id !== user.id) return fail(res, 403, 'Можно удалять только свои сообщения')

  db.run('delete from messages where id = ?', id)
  rt.emitToMany(memberIds(msg.chat_id), 'message_deleted', { messageId: id, chatId: msg.chat_id })
  json(res, 200, { ok: true })
})

// ── доставлено и прочитано ──

route('POST', '/api/receipts', async (req, res, url) => {
  const user = requireUser(req, res, url)
  const body = await readJson(req)
  const ids = Array.isArray(body.message_ids) ? body.message_ids : []
  const read = Boolean(body.read)
  if (!ids.length) return json(res, 200, { ok: true })

  const placeholders = ids.map(() => '?').join(',')
  const messages = db.all(`select id, chat_id, sender_id from messages where id in (${placeholders})`, ...ids)

  // Отметки ставим только для сообщений из чатов, где пользователь состоит.
  const valid = messages.filter((m) => isMember(m.chat_id, user.id))
  if (!valid.length) return json(res, 200, { ok: true })

  db.transaction(() => {
    for (const m of valid) {
      db.run(
        `insert into receipts (message_id, user_id, delivered_at, read_at)
         values (?, ?, ?, ?)
         on conflict(message_id, user_id) do update set
           delivered_at = coalesce(receipts.delivered_at, excluded.delivered_at),
           read_at = coalesce(receipts.read_at, excluded.read_at)`,
        m.id,
        user.id,
        db.now(),
        read ? db.now() : null,
      )
    }
  })

  // Отправителям сообщаем: у них появятся галочки доставки и прочтения.
  const senders = [...new Set(valid.map((m) => m.sender_id))].filter((sid) => sid !== user.id)
  for (const sid of senders) {
    const mine = valid.filter((m) => m.sender_id === sid)
    rt.emitTo(sid, 'receipt', {
      receipts: db.all(
        `select * from receipts where user_id = ? and message_id in (${mine.map(() => '?').join(',')})`,
        user.id,
        ...mine.map((m) => m.id),
      ),
    })
  }

  json(res, 200, { ok: true })
})

route('POST', '/api/receipts/for', async (req, res, url) => {
  const user = requireUser(req, res, url)
  const ids = (await readJson(req)).message_ids ?? []
  if (!ids.length) return json(res, 200, [])
  const placeholders = ids.map(() => '?').join(',')
  // Свои отметки не возвращаем: они говорят о том, что читаем мы, а не нам.
  json(
    res,
    200,
    db.all(
      `select * from receipts where message_id in (${placeholders}) and user_id != ?`,
      ...ids,
      user.id,
    ),
  )
})

// ── «печатает» ──

route('POST', '/api/typing', async (req, res, url) => {
  const user = requireUser(req, res, url)
  const body = await readJson(req)
  const chatId = String(body.chat_id ?? '')
  if (!isMember(chatId, user.id)) return json(res, 200, { ok: true })

  if (body.active) {
    db.run(
      `insert into typing (chat_id, user_id, updated_at) values (?, ?, ?)
       on conflict(chat_id, user_id) do update set updated_at = excluded.updated_at`,
      chatId,
      user.id,
      db.now(),
    )
  } else {
    db.run('delete from typing where chat_id = ? and user_id = ?', chatId, user.id)
  }

  rt.emitToMany(
    memberIds(chatId).filter((uid) => uid !== user.id),
    'typing',
    { chatId, userId: body.active ? user.id : null },
  )
  json(res, 200, { ok: true })
})

// ── реакции ──

route('POST', '/api/reactions', async (req, res, url) => {
  const user = requireUser(req, res, url)
  const body = await readJson(req)
  const messageId = String(body.message_id ?? '')
  const emoji = String(body.emoji ?? '').slice(0, 8)

  const msg = db.get('select * from messages where id = ?', messageId)
  if (!msg) return fail(res, 404, 'Сообщение не найдено')
  if (!isMember(msg.chat_id, user.id)) return fail(res, 403, 'Нет доступа к этому чату')
  if (!emoji) return fail(res, 400, 'Не передана реакция')

  db.run(
    `insert into reactions (message_id, user_id, emoji, created_at) values (?, ?, ?, ?)
     on conflict(message_id, user_id) do update set emoji = excluded.emoji`,
    messageId,
    user.id,
    emoji,
    db.now(),
  )

  rt.emitToMany(memberIds(msg.chat_id), 'reaction', {
    messageId,
    userId: user.id,
    emoji,
  })
  json(res, 200, { ok: true })
})

route('DELETE', '/api/reactions/:messageId', async (req, res, url, { messageId }) => {
  const user = requireUser(req, res, url)
  const msg = db.get('select * from messages where id = ?', messageId)
  if (!msg) return fail(res, 404, 'Сообщение не найдено')

  db.run('delete from reactions where message_id = ? and user_id = ?', messageId, user.id)
  rt.emitToMany(memberIds(msg.chat_id), 'reaction', {
    messageId,
    userId: user.id,
    emoji: null,
  })
  json(res, 200, { ok: true })
})

route('POST', '/api/reactions/for', async (req, res, url) => {
  const user = requireUser(req, res, url)
  const ids = (await readJson(req)).message_ids ?? []
  if (!ids.length) return json(res, 200, [])
  const placeholders = ids.map(() => '?').join(',')
  json(
    res,
    200,
    db.all(
      `select message_id, user_id, emoji from reactions where message_id in (${placeholders})`,
      ...ids,
    ),
  )
})

// ── файлы ──

/**
 * Загрузка зашифрованного файла.
 *
 * Тело запроса — уже шифротекст, сервер его не разбирает и не проверяет:
 * проверять нечего, содержимое для него бессмысленный набор байт.
 * Имя файла приходит отдельно и тоже зашифрованным.
 */
route('POST', '/api/files/:chatId', async (req, res, url, { chatId }) => {
  const user = requireUser(req, res, url)
  if (!user) return
  try {
    requireMembership(chatId, user.id)
  } catch (e) {
    return fail(res, e.status ?? 403, e.message)
  }

  const buffer = await readBody(req)
  if (!buffer.length) return fail(res, 400, 'Пустой файл')

  const name = `${chatId}/${randomUUID()}.bin`
  const full = join(db.FILES_DIR, name)
  await mkdir(join(db.FILES_DIR, chatId), { recursive: true })
  await writeFile(full, buffer)

  res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ path: name, size: buffer.length }))
})

route('GET', '/api/files/:chatId/:name', async (req, res, url, { chatId, name }) => {
  const user = requireUser(req, res, url)
  if (!user) return
  try {
    requireMembership(chatId, user.id)
  } catch (e) {
    return fail(res, e.status ?? 403, e.message)
  }

  // Защита от выхода за пределы папки: имя приходит из адреса, и без
  // проверки через «../» можно было бы прочитать произвольный файл.
  const safeName = normalize(name).replace(/^([/\\])+/, '')
  if (safeName.includes('..') || safeName.includes('/') || safeName.includes('\\')) {
    return fail(res, 400, 'Некорректное имя файла')
  }

  const full = join(db.FILES_DIR, chatId, safeName)
  if (!existsSync(full)) return fail(res, 404, 'Файл не найден')

  const info = await stat(full)
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-store',
  })
  createReadStream(full).pipe(res)
})

route('DELETE', '/api/files/:chatId/:name', async (req, res, url, { chatId, name }) => {
  const user = requireUser(req, res, url)
  if (!user) return
  try {
    requireMembership(chatId, user.id)
  } catch (e) {
    return fail(res, e.status ?? 403, e.message)
  }

  const safeName = normalize(name).replace(/^([/\\])+/, '')
  if (safeName.includes('..') || safeName.includes('/') || safeName.includes('\\')) {
    return fail(res, 400, 'Некорректное имя файла')
  }

  try {
    await unlink(join(db.FILES_DIR, chatId, safeName))
  } catch {
    /* файла уже нет — это не ошибка */
  }
  json(res, 200, { ok: true })
})

// ── realtime ──

/**
 * Поток событий.
 *
 * Токен приходит в адресе, а не в заголовке: EventSource не умеет задавать
 * заголовки. Это безопасно, потому что соединение идёт на свой же сервер,
 * а токен не попадает в логи браузера — но требует осторожности при
 * развёртывании через чужие прокси.
 */
route('GET', '/api/events', async (req, res, url) => {
  const user = auth.sessionUser(tokenOf(req, url))
  if (!user) return fail(res, 401, 'Требуется вход', 'UNAUTHORIZED')

  const stream = rt.addStream(user.id, res)

  // Подписка на звонки конкретного чата.
  const callChat = url.searchParams.get('callChat')
  if (callChat && isMember(callChat, user.id)) {
    rt.joinCallRoom(callChat, user.id, stream.id)
  }

  // Первым делом сообщаем список тех, кто в сети: клиент сразу покажет
  // зелёные точки, не дожидаясь чьего-то входа или выхода.
  rt.emitTo(user.id, 'presence', { online: rt.onlineUsers() })
})

// ── служебные сообщения звонка ──

/**
 * Пересылка служебных сообщений звонка.
 * Медиа идёт напрямую между участниками; сервер передаёт только описания
 * сессий и сетевые кандидаты — и ничего не сохраняет.
 */
route('POST', '/api/call/:chatId', async (req, res, url, { chatId }) => {
  const user = requireUser(req, res, url)
  if (!user) return
  if (!isMember(chatId, user.id)) return fail(res, 403, 'Нет доступа к этому чату')

  const payload = await readJson(req)
  const delivered = rt.broadcastCall(chatId, user.id, payload)
  json(res, 200, { ok: true, delivered })
})

/** Подписаться на звонки чата, не открывая отдельного соединения. */
route('POST', '/api/call/:chatId/subscribe', async (req, res, url, { chatId }) => {
  const user = requireUser(req, res, url)
  if (!user) return
  if (!isMember(chatId, user.id)) return fail(res, 403, 'Нет доступа к этому чату')
  // Комната подключается вместе с потоком событий; здесь достаточно подтверждения.
  json(res, 200, { ok: true, online: rt.onlineUsers() })
})

// ─────────────────────────── статика ───────────────────────────

/**
 * Папка собранного интерфейса.
 *
 * Задаётся переменной окружения, когда программу упаковали: файлы клиента
 * лежат в ресурсах приложения, а не в текущем каталоге.
 */
const DIST = resolve(process.env.AURORA_CLIENT_DIR || join(process.cwd(), 'dist'))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

async function serveStatic(req, res, url) {
  if (!existsSync(DIST)) {
    return fail(
      res,
      503,
      'Клиент не собран. Выполните: npm run build, затем запустите сервер снова.',
      'NOT_BUILT',
    )
  }

  const requested = url.pathname === '/' ? '/index.html' : url.pathname
  const safe = normalize(requested).replace(/^([/\\])+/, '')
  let full = join(DIST, safe)

  // Любой неизвестный путь отдаёт index.html: это одностраничное приложение,
  // и переход по внутренней ссылке не должен давать 404.
  if (!existsSync(full) || !extname(full)) full = join(DIST, 'index.html')

  if (!full.startsWith(DIST)) return fail(res, 403, 'Доступ запрещён')

  const ext = extname(full)
  const info = await stat(full)
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': info.size,
    // Ассеты содержат хеш в имени, поэтому кешируются надолго.
    // index.html — никогда: иначе обновление приложения не доедет до человека.
    'Cache-Control':
      ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  createReadStream(full).pipe(res)
}

// ─────────────────────────── сервер ───────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  // Метка начала обработки: время работы сервера кладётся в заголовок
  // ответа. Без этого нельзя отличить задержку сети от медленной обработки,
  // а у HTTP-клиента есть свой пул соединений, который искажает замеры.
  res.startedAt = process.hrtime.bigint()

  // Локальная разработка: страница на другом порту обращается к API.
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With',
  )
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      await dispatch(req, res, url)
    } else {
      await serveStatic(req, res, url)
    }
  } catch (e) {
    const status = e.status ?? 500
    if (status >= 500) console.error('[aurora]', e)
    if (!res.headersSent) fail(res, status, e.message || 'Внутренняя ошибка')
    else res.end()
  }
})

// ─────────────────────────── запуск ───────────────────────────

export function start(port = PORT, host = HOST) {
  db.openDatabase()

  // Встроенный STUN/TURN поднимается вместе с сервером. Это решает главную
  // проблему звонков: без ретранслятора соединение между мобильным
  // интернетом и домашним Wi-Fi не устанавливается из-за симметричного NAT.
  const turnInfo = turn.startTurn(db.DATA_DIR)
  if (turnInfo) {
    console.log(`AURORA_TURN_PORT=${turnInfo.port}`)
  } else {
    // Не беда: мессенджер и звонки внутри одной сети работают без TURN.
    console.log('AURORA_TURN_PORT=0')
  }

  /**
   * Запуск с автоматическим подбором порта.
   *
   * Если порт занят, пробуем следующий: занимать его может совсем другая
   * программа, а обычный пользователь не знает, что с этим делать. Отказать
   * и попросить разобраться самому — плохой вариант, когда можно просто
   * взять свободный и сказать, куда открывать.
   */
  return new Promise((resolve, reject) => {
    let attempts = 0
    const maxAttempts = 40

    const tryListen = (p) => {
      const onError = (e) => {
        server.removeListener('listening', onListening)
        if (e.code === 'EADDRINUSE' && attempts < maxAttempts) {
          attempts++
          tryListen(p + 1)
          return
        }
        reject(e)
      }

      const onListening = () => {
        server.removeListener('error', onError)
        resolve({ port: server.address().port, server })
      }

      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(p, host)
    }

    tryListen(port)
  })
}

export { server }

/**
 * Прямой запуск: node server/index.mjs
 *
 * Сравнивать import.meta.url со склеенной вручную строкой нельзя: на Windows
 * путь содержит обратные слэши, а кириллица в пути — процентное кодирование.
 * Строки не совпадут, сервер молча ничего не сделает. pathToFileURL приводит
 * путь к тому же виду, что и import.meta.url.
 */
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  try {
    const { port } = await start()

    // Сообщаем выбранный порт отдельной строкой: launcher читает её и
    // открывает браузер именно на этом адресе. Если порт пришлось сменить,
    // человек всё равно попадёт туда, где всё работает.
    console.log(`AURORA_PORT=${port}`)

    const line = '─'.repeat(54)
    console.log('')
    console.log(`  ┌${line}┐`)
    console.log('  │  AURORA — мессенджер запущен                           │')
    console.log(`  └${line}┘`)
    console.log('')
    console.log(`  Откройте:  http://localhost:${port}`)
    console.log('')
    console.log('  Всё работает локально: своя база, свои файлы, свой сервер.')
    console.log('  Переписка шифруется в браузере — сервер её не читает.')
    console.log('')
    console.log('  Остановить: Ctrl+C')
    console.log('')
  } catch (e) {
    console.error('')
    console.error('  Не удалось запустить сервер:', e.message)
    console.error('')
    if (e.code === 'EADDRINUSE') {
      console.error(`  Порт ${PORT} и следующие за ним заняты.`)
      console.error('  Запустите с другим портом: set PORT=5555 && node server/index.mjs')
    } else if (e.code === 'ERR_UNKNOWN_BUILTIN_MODULE' || /sqlite/i.test(e.message)) {
      console.error('  Нужен Node.js 22.5 или новее — в нём появилась встроенная база данных.')
      console.error('  Скачайте LTS: https://nodejs.org')
    } else if (e.code === 'EACCES') {
      console.error('  Нет прав на этот порт. Антивирус или брандмауэр могут блокировать запуск.')
    }
    console.error('')
    process.exit(1)
  }
}