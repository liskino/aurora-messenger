import { AlertTriangle } from 'lucide-react'

/**
 * Предупреждение о ненастроенном бэкенде.
 *
 * Показывается, когда .env.local пуст: без Supabase не работает ни вход,
 * ни доставка сообщений. Честнее сказать это на входе, чем дать человеку
 * зарегистрироваться и удивиться тишине.
 */
export function ConnectionWarning() {
  return (
    <div className="anim-fade fixed inset-x-0 top-0 z-50 flex items-start gap-2 bg-amber-500/15 px-4 py-2.5 text-xs text-amber-200 backdrop-blur">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <p>
        Бэкенд не подключён. Создайте файл <code className="font-mono">.env.local</code> по образцу{' '}
        <code className="font-mono">.env.example</code> и укажите адрес и ключ Supabase — инструкция в
        README, раздел «Запуск за 5 минут».
      </p>
    </div>
  )
}