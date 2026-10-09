-- ═══════════════════════════════════════════════════════════════════════
-- Aurora Messenger — схема базы данных Supabase
--
-- Выполните этот файл в Supabase → SQL Editor → Run.
-- Сервер хранит только шифротекст и метаданные маршрутизации.
-- ═══════════════════════════════════════════════════════════════════════

-- ─────────────────────────── профили ───────────────────────────

create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  username          text unique not null check (char_length(username) between 3 and 24),
  display_name      text not null default '',
  avatar_url        text,
  -- Открытый ключ ECDH P-256 (base64). Публичная информация.
  public_key        text not null,
  -- Приватный ключ, зашифрованный ключом из пароля. Сервер прочитать не может.
  wrapped_private   text not null,
  kdf_salt          text not null,
  kdf_iterations    integer not null default 600000,
  last_seen         timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

create index if not exists profiles_username_idx on public.profiles (lower(username));

-- ─────────────────────────── чаты ───────────────────────────

create type chat_kind as enum ('direct', 'group');

create table if not exists public.chats (
  id          uuid primary key default gen_random_uuid(),
  kind        chat_kind not null,
  title       text,
  created_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table if not exists public.chat_members (
  chat_id     uuid not null references public.chats(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- Ключ чата, зашифрованный для этого участника (ECDH-shared → AES-GCM).
  wrapped_key text not null,
  joined_at   timestamptz not null default now(),
  primary key (chat_id, user_id)
);

create index if not exists chat_members_user_idx on public.chat_members (user_id);

-- ─────────────────────────── сообщения ───────────────────────────

create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  chat_id     uuid not null references public.chats(id) on delete cascade,
  sender_id   uuid not null references auth.users(id) on delete cascade,
  -- Шифротекст AES-256-GCM и его IV. Открытого текста здесь не бывает.
  ciphertext  text not null,
  iv          text not null,
  kind        text not null default 'text' check (kind in ('text', 'file', 'system')),
  -- Для файлов: ссылка на объект в Storage и обёрнутый ключ файла.
  file_path   text,
  file_name_sealed text,
  file_name_iv     text,
  file_type   text,
  file_size   bigint,
  wrapped_file_key text,
  created_at  timestamptz not null default now(),
  edited_at   timestamptz
);

create index if not exists messages_chat_time_idx
  on public.messages (chat_id, created_at desc);

-- ─────────────────────────── устройства и сессии ───────────────────────────

create table if not exists public.devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  label        text not null default 'Устройство',
  user_agent   text,
  last_active  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists devices_user_idx on public.devices (user_id);

-- ─────────────────────────── доставка и прочтение ───────────────────────────

create table if not exists public.receipts (
  message_id  uuid not null references public.messages(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  delivered_at timestamptz,
  read_at      timestamptz,
  primary key (message_id, user_id)
);

-- ─────────────────────────── печатает ───────────────────────────

create table if not exists public.typing (
  chat_id    uuid not null references public.chats(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);

-- ═══════════════════════════════════════════════════════════════════════
-- Row Level Security: каждый видит только свои чаты
-- ═══════════════════════════════════════════════════════════════════════

alter table public.profiles     enable row level security;
alter table public.chats        enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages     enable row level security;
alter table public.devices      enable row level security;
alter table public.receipts     enable row level security;
alter table public.typing       enable row level security;

-- Помощник: состоит ли текущий пользователь в чате
create or replace function public.is_member(chat uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.chat_members m
    where m.chat_id = chat and m.user_id = auth.uid()
  );
$$;

-- profiles: читают все авторизованные (нужны открытые ключи), пишет только владелец
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to authenticated with check (id = auth.uid());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- chats
drop policy if exists chats_read on public.chats;
create policy chats_read on public.chats
  for select to authenticated using (public.is_member(id) or created_by = auth.uid());

drop policy if exists chats_insert on public.chats;
create policy chats_insert on public.chats
  for insert to authenticated with check (created_by = auth.uid());

-- chat_members
drop policy if exists members_read on public.chat_members;
create policy members_read on public.chat_members
  for select to authenticated using (public.is_member(chat_id));

drop policy if exists members_insert on public.chat_members;
create policy members_insert on public.chat_members
  for insert to authenticated with check (true);

drop policy if exists members_delete on public.chat_members;
create policy members_delete on public.chat_members
  for delete to authenticated using (user_id = auth.uid() or public.is_member(chat_id));

-- messages
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages
  for select to authenticated using (public.is_member(chat_id));

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert to authenticated with check (sender_id = auth.uid() and public.is_member(chat_id));

drop policy if exists messages_update on public.messages;
create policy messages_update on public.messages
  for update to authenticated using (sender_id = auth.uid());

-- devices
drop policy if exists devices_all on public.devices;
create policy devices_all on public.devices
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- receipts
drop policy if exists receipts_read on public.receipts;
create policy receipts_read on public.receipts
  for select to authenticated using (user_id = auth.uid() or exists (
    select 1 from public.messages m where m.id = message_id and m.sender_id = auth.uid()
  ));

drop policy if exists receipts_write on public.receipts;
create policy receipts_write on public.receipts
  for all to authenticated using (user_id = auth.uid()) with check (true);

-- typing
drop policy if exists typing_read on public.typing;
create policy typing_read on public.typing
  for select to authenticated using (public.is_member(chat_id));

drop policy if exists typing_write on public.typing;
create policy typing_write on public.typing
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════
-- Realtime: включаем публикацию для таблиц, которые должны жить мгновенно
-- ═══════════════════════════════════════════════════════════════════════

alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.typing;
alter publication supabase_realtime add table public.receipts;
alter publication supabase_realtime add table public.chat_members;

-- ═══════════════════════════════════════════════════════════════════════
-- Автосоздание профиля-заглушки при регистрации (ключи заполняет клиент)
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.handle_last_seen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles set last_seen = now() where id = new.id;
  return new;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- Хранилище зашифрованных файлов
-- ═══════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public)
values ('encrypted', 'encrypted', false)
on conflict (id) do nothing;

drop policy if exists files_read on storage.objects;
create policy files_read on storage.objects
  for select to authenticated using (bucket_id = 'encrypted');

drop policy if exists files_insert on storage.objects;
create policy files_insert on storage.objects
  for insert to authenticated with check (bucket_id = 'encrypted' and owner = auth.uid());

drop policy if exists files_delete on storage.objects;
create policy files_delete on storage.objects
  for delete to authenticated using (bucket_id = 'encrypted' and owner = auth.uid());