/**
 * Аутентификация автономного сервера.
 *
 * Пароль здесь нужен только для входа в аккаунт — он не имеет никакого
 * отношения к шифрованию переписки. Ключ, которым шифруются сообщения,
 * выводится из пароля в браузере (PBKDF2) и на сервер не уходит.
 * Поэтому даже полная база сервера не даёт прочитать переписку.
 *
 * Пароль хранится как scrypt-хеш с индивидуальной солью: извлечь его
 * из базы невозможно, а перебор стоит дорого.
 */
import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto'
import { all, get, run, now } from './db.mjs'

const SCRYPT_KEYLEN = 64
/** Сессия живёт 90 дней: именно это делает «запоминание устройства» работающим. */
const SESSION_DAYS = 90

export function hashPassword(password) {
  const salt = randomBytes(16).toString('base64')
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('base64')
  return { hash, salt }
}

export function verifyPassword(password, hashB64, salt) {
  try {
    const expected = Buffer.from(hashB64, 'base64')
    const actual = scryptSync(password, salt, SCRYPT_KEYLEN)
    // Сравнение с постоянным временем: обычное === раскрывает длину
    // совпадающего префикса и позволяет подбирать хеш по одной байту.
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

export function createSession(userId, userAgent) {
  const token = randomBytes(32).toString('base64url')
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString()
  run(
    'insert into sessions (token, user_id, created_at, expires_at, user_agent) values (?, ?, ?, ?, ?)',
    token,
    userId,
    now(),
    expires,
    userAgent ?? null,
  )
  return { token, expiresAt: expires }
}

export function sessionUser(token) {
  if (!token) return null
  const row = get(
    `select s.token, s.expires_at, u.id, u.email
       from sessions s join users u on u.id = s.user_id
      where s.token = ?`,
    token,
  )
  if (!row) return null
  if (row.expires_at < now()) {
    run('delete from sessions where token = ?', token)
    return null
  }
  return { id: row.id, email: row.email }
}

export function destroySession(token) {
  if (token) run('delete from sessions where token = ?', token)
}

export function registerUser(email, password) {
  const normalized = email.trim().toLowerCase()
  const existing = get('select id from users where email = ?', normalized)
  if (existing) {
    const err = new Error('Такая почта уже зарегистрирована — войдите')
    err.code = 'EMAIL_TAKEN'
    throw err
  }

  const { hash, salt } = hashPassword(password)
  const id = randomUUID()
  run(
    'insert into users (id, email, password_hash, password_salt, created_at) values (?, ?, ?, ?, ?)',
    id,
    normalized,
    hash,
    salt,
    now(),
  )
  return { id, email: normalized }
}

export function loginUser(email, password) {
  const normalized = email.trim().toLowerCase()
  const user = get('select * from users where email = ?', normalized)

  // Одинаковое сообщение для «нет такого пользователя» и «неверный пароль»:
  // иначе по тексту ошибки можно узнать, какие почты зарегистрированы.
  const invalid = () => {
    const err = new Error('Неверная почта или пароль')
    err.code = 'BAD_CREDENTIALS'
    return err
  }
  if (!user) throw invalid()
  if (!verifyPassword(password, user.password_hash, user.password_salt)) throw invalid()

  return { id: user.id, email: user.email }
}

/** Список активных сессий пользователя — видно, где ещё открыт мессенджер. */
export function listSessions(userId) {
  return all(
    'select token, created_at, expires_at, user_agent from sessions where user_id = ? order by created_at desc',
    userId,
  )
}