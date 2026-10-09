import { useState } from 'react'
import { AtSign, KeyRound, Loader2, LogIn, ShieldCheck, UserPlus } from 'lucide-react'
import { engine } from '@/lib/engine'
import { isConfigured } from '@/lib/api'

interface Props {
  onAuthed: () => void
}

/**
 * Вход и регистрация.
 *
 * Регистрация создаёт пару ключей прямо в браузере: приватный ключ уходит на
 * сервер только зашифрованным паролем. Поэтому «забыли пароль» = потеря
 * истории, и текст на экране об этом честно предупреждает.
 */
export function AuthView({ onAuthed }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setNotice(null)

    if (!isConfigured) {
      setError('Мессенджер не подключён к бэкенду: заполните .env.local (см. README).')
      return
    }
    if (mode === 'register' && !/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
      setError('Логин: 3–24 символа, латиница, цифры и подчёркивание')
      return
    }
    if (password.length < 8) {
      setError('Пароль не короче 8 символов — им шифруется ваш приватный ключ')
      return
    }

    setBusy(true)
    try {
      if (mode === 'register') {
        await engine.register(email, password, username, displayName)
        setNotice('Аккаунт создан. Ключи сгенерированы на этом устройстве.')
        onAuthed()
      } else {
        await engine.login(email, password)
        onAuthed()
      }
    } catch (err) {
      const msg = (err as Error).message
      // Supabase просит подтвердить почту — это не ошибка, а шаг регистрации.
      if (/confirm|подтверд/i.test(msg)) {
        setNotice('Проверьте почту и перейдите по ссылке из письма, затем войдите.')
      } else {
        setError(translateError(msg))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative grid h-full place-items-center overflow-hidden px-4">
      {/* Живой фон: только transform — не мешает кадрам */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="anim-drift absolute -left-1/4 top-0 size-[46rem] rounded-full bg-brand-500/22 blur-[120px]" />
        <div
          className="anim-drift absolute -right-1/4 bottom-0 size-[40rem] rounded-full bg-aqua-500/16 blur-[120px]"
          style={{ animationDelay: '-8s' }}
        />
      </div>

      <div className="anim-rise w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-aqua-500 shadow-2xl shadow-brand-600/30">
            <ShieldCheck size={26} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Aurora</h1>
          <p className="mt-1 text-sm text-mist-400">Шифрование на устройстве, работа из любой сети</p>
        </div>

        <div className="rounded-2xl border border-white/8 bg-ink-850/70 p-5 shadow-2xl shadow-black/40 backdrop-blur-xl">
          <div className="mb-5 flex rounded-xl bg-ink-800 p-1">
            {(['login', 'register'] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m)
                  setError(null)
                  setNotice(null)
                }}
                className={`relative flex-1 rounded-lg py-2 text-sm font-medium transition-transform duration-200 will-change-transform ${
                  mode === m ? 'bg-brand-500 text-white shadow-lg shadow-brand-600/25' : 'text-mist-300 hover:text-white'
                }`}
              >
                {m === 'login' ? 'Вход' : 'Регистрация'}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-3">
            {mode === 'register' && (
              <>
                <Field
                  icon={<AtSign size={15} />}
                  value={username}
                  onChange={setUsername}
                  placeholder="логин"
                  autoComplete="username"
                />
                <Field
                  icon={<UserPlus size={15} />}
                  value={displayName}
                  onChange={setDisplayName}
                  placeholder="отображаемое имя"
                  autoComplete="name"
                />
              </>
            )}

            <Field
              type="email"
              icon={<AtSign size={15} />}
              value={email}
              onChange={setEmail}
              placeholder="email"
              autoComplete="email"
              required
            />

            <Field
              type="password"
              icon={<KeyRound size={15} />}
              value={password}
              onChange={setPassword}
              placeholder="пароль"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
            />

            {error && (
              <p className="anim-fade rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>
            )}
            {notice && (
              <p className="anim-fade rounded-lg bg-aqua-500/10 px-3 py-2 text-xs text-aqua-400">{notice}</p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-brand-600 to-brand-500 py-2.5 font-medium text-white shadow-lg shadow-brand-600/25 transition-transform duration-150 will-change-transform hover:scale-[1.015] active:scale-[0.985] disabled:opacity-50"
            >
              {busy ? (
                <Loader2 size={16} className="anim-spin" />
              ) : mode === 'login' ? (
                <LogIn size={16} />
              ) : (
                <UserPlus size={16} />
              )}
              {busy ? 'Ключи и пароль…' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}
            </button>
          </form>

          <p className="mt-4 text-center text-[0.6875rem] leading-relaxed text-mist-400">
            Пароль не отправляется на сервер: из него выводится ключ, которым зашифрован ваш приватный
            ключ. Устройство запоминается — при следующем входе пароль не потребуется.
          </p>
        </div>
      </div>
    </div>
  )
}

function Field({
  icon,
  value,
  onChange,
  placeholder,
  type = 'text',
  autoComplete,
  required,
}: {
  icon: React.ReactNode
  value: string
  onChange: (v: string) => void
  placeholder: string
  type?: string
  autoComplete?: string
  required?: boolean
}) {
  return (
    <label className="flex items-center gap-2.5 rounded-xl bg-ink-800 px-3 py-2.5 ring-1 ring-transparent transition-colors duration-150 focus-within:ring-brand-500/60">
      <span className="text-mist-400">{icon}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        className="w-full bg-transparent text-sm outline-none placeholder:text-mist-400/60"
      />
    </label>
  )
}

/** Понятные сообщения вместо кодов Supabase. */
function translateError(msg: string): string {
  if (/Invalid login credentials/i.test(msg)) return 'Неверная почта или пароль'
  if (/already registered/i.test(msg)) return 'Такая почта уже зарегистрирована — войдите'
  if (/duplicate key.*username/i.test(msg)) return 'Этот логин уже занят'
  if (/Password should be at least/i.test(msg)) return 'Пароль слишком короткий'
  if (/rate limit/i.test(msg)) return 'Слишком много попыток, подождите минуту'
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Нет связи с сервером — проверьте интернет'
  return msg
}