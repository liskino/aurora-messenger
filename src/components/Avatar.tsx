/**
 * Аватар пользователя.
 *
 * Картинки нет: цвет выводится из идентификатора, поэтому он стабилен между
 * сессиями и устройствами, не требует ни одного запроса к сети и не даёт
 * «мигания» при загрузке списка чатов.
 */
export function Avatar({
  name,
  id,
  size = 40,
  online,
}: {
  name: string
  id: string
  size?: number
  online?: boolean
}) {
  const hue = [...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 360
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className="grid size-full place-items-center rounded-full font-semibold text-white"
        style={{
          fontSize: size * 0.38,
          background: `linear-gradient(135deg, hsl(${hue} 70% 52%), hsl(${(hue + 55) % 360} 75% 44%))`,
        }}
      >
        {initials || '?'}
      </div>
      {online && (
        <span
          className="absolute bottom-0 right-0 rounded-full border-2 border-ink-850 bg-emerald-400"
          style={{ width: size * 0.32, height: size * 0.32 }}
          title="в сети"
        />
      )}
    </div>
  )
}