/**
 * Хранилище сервера: SQLite из состава Node.js.
 *
 * Никаких внешних баз и зависимостей: файл `aurora.db` в папке данных.
 * Схема повторяет привычную структуру мессенджера, поэтому клиентский код
 * работает с ней напрямую.
 *
 * Принцип важнее удобства: сервер хранит только шифротекст. Ни одно поле
 * здесь не содержит открытого текста сообщения.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Папки данных.
 *
 * Пути берутся из переменных окружения, а не из текущего каталога:
 * в собранном приложении cwd — это Program Files, куда писать нельзя.
 * Веб-версия ничего не задаёт и получает папку рядом с сервером.
 */
export const DATA_DIR = process.env.AURORA_DATA_DIR || join(process.cwd(), 'data')
export const FILES_DIR = join(DATA_DIR, 'files')

let db

export function openDatabase(file = join(DATA_DIR, 'aurora.db')) {
  mkdirSync(dirname(file), { recursive: true })
  mkdirSync(FILES_DIR, { recursive: true })

  db = new DatabaseSync(file)

  // WAL заметно ускоряет запись при одновременных чтениях — а именно так
  // и работает мессенджер: одно incoming-сообщение при активном чтении истории.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')

  migrate()
  return db
}

export function database() {
  if (!db) throw new Error('База данных не открыта')
  return db
}

function migrate() {
  db.exec(`
    -- ── пользователи ────────────────────────────────────────────────
    create table if not exists users (
      id            text primary key,
      email         text not null unique,
      -- Пароль нужен только для входа в аккаунт. Он не имеет отношения
      -- к шифрованию переписки и никогда не используется как ключ.
      password_hash text not null,
      password_salt text not null,
      created_at    text not null
    );

    create table if not exists sessions (
      token      text primary key,
      user_id    text not null references users(id) on delete cascade,
      created_at text not null,
      expires_at text not null,
      user_agent text
    );
    create index if not exists sessions_user_idx on sessions(user_id);

    -- ── профиль: здесь живут ключи шифрования ───────────────────────
    create table if not exists profiles (
      user_id         text primary key references users(id) on delete cascade,
      username        text not null unique collate nocase,
      display_name    text not null default '',
      avatar_url      text,
      -- Открытый ключ ECDH P-256. Публичная информация.
      public_key      text not null,
      -- Приватный ключ, зашифрованный ключом из пароля. Сервер его не прочитает.
      wrapped_private text not null,
      kdf_salt        text not null,
      kdf_iterations  integer not null default 600000,
      last_seen       text not null,
      created_at      text not null
    );

    -- ── устройства ──────────────────────────────────────────────────
    create table if not exists devices (
      id          text primary key,
      user_id     text not null references users(id) on delete cascade,
      label       text not null default 'Устройство',
      user_agent  text,
      last_active text not null,
      created_at  text not null
    );
    create index if not exists devices_user_idx on devices(user_id);

    -- ── чаты ────────────────────────────────────────────────────────
    create table if not exists chats (
      id         text primary key,
      kind       text not null check (kind in ('direct','group')),
      title      text,
      created_by text not null references users(id) on delete cascade,
      created_at text not null
    );

    create table if not exists chat_members (
      chat_id     text not null references chats(id) on delete cascade,
      user_id     text not null references users(id) on delete cascade,
      -- Ключ чата, зашифрованный для этого участника. Открытого ключа нет нигде.
      wrapped_key text not null,
      joined_at   text not null,
      primary key (chat_id, user_id)
    );
    create index if not exists chat_members_user_idx on chat_members(user_id);

    -- ── сообщения ───────────────────────────────────────────────────
    create table if not exists messages (
      id               text primary key,
      chat_id          text not null references chats(id) on delete cascade,
      sender_id        text not null references users(id) on delete cascade,
      ciphertext       text not null default '',
      iv               text not null default '',
      kind             text not null default 'text' check (kind in ('text','file','system')),
      file_path        text,
      file_name_sealed text,
      file_name_iv     text,
      file_type        text,
      file_size        integer,
      wrapped_file_key text,
      created_at       text not null,
      edited_at        text
    );
    create index if not exists messages_chat_time_idx on messages(chat_id, created_at);

    -- ── доставлено и прочитано ──────────────────────────────────────
    create table if not exists receipts (
      message_id   text not null references messages(id) on delete cascade,
      user_id      text not null references users(id) on delete cascade,
      delivered_at text,
      read_at      text,
      primary key (message_id, user_id)
    );

    -- ── «печатает» ──────────────────────────────────────────────────
    create table if not exists typing (
      chat_id    text not null references chats(id) on delete cascade,
      user_id    text not null references users(id) on delete cascade,
      updated_at text not null,
      primary key (chat_id, user_id)
    );

    -- ── реакции ─────────────────────────────────────────────────────
    create table if not exists reactions (
      message_id text not null references messages(id) on delete cascade,
      user_id    text not null references users(id) on delete cascade,
      emoji      text not null,
      created_at text not null,
      primary key (message_id, user_id)
    );
    create index if not exists reactions_message_idx on reactions(message_id);
  `)
}

// ─────────────────────────── помощники запросов ───────────────────────────

/** Все строки запроса. */
export function all(sql, ...params) {
  return database().prepare(sql).all(...params)
}

/** Первая строка или undefined. */
export function get(sql, ...params) {
  return database().prepare(sql).get(...params)
}

/** Выполняет запрос, не возвращая строк. */
export function run(sql, ...params) {
  return database().prepare(sql).run(...params)
}

/** Выполняет запрос в транзакции: либо всё, либо ничего. */
export function transaction(fn) {
  const d = database()
  d.exec('BEGIN')
  try {
    const result = fn()
    d.exec('COMMIT')
    return result
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
}

/** Короткий уникальный идентификатор. */
export function newId() {
  return crypto.randomUUID()
}

/** Текущее время в формате ISO — совпадает с тем, что ждёт клиент. */
export function now() {
  return new Date().toISOString()
}