/**
 * Turning what SQLite stores into what the screens say.
 *
 * Two clocks meet here. Every timestamp column this schema writes comes from
 * `datetime('now')`, which is UTC with a space instead of a `T` and no zone
 * marker — parsed by `Date` as *local* time unless it is told otherwise, which
 * would silently shift every "hace 4 min" by the machine's offset. The court's
 * own timestamps are a different thing entirely: they arrive already formatted
 * by the portal (`22 de Agosto de 2026`, `01/09/2026 17:42:40`) and are never
 * reinterpreted, only trimmed — a date the tribunal printed is data, not a
 * moment we get to recompute.
 */

/** `2026-09-02 00:38:01` (UTC, as `datetime('now')` writes it) → a Date. */
export function parseStoredTime(value: string | null): Date | null {
  if (value === null || value.trim() === '') return null
  const d = new Date(`${value.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** The same format, for the start of today in the machine's own timezone. */
export function startOfTodayStored(now: Date = new Date()): string {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return midnight.toISOString().slice(0, 19).replace('T', ' ')
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "hace 3 s", "hace 4 min", "hace 2 h", "hace 3 d" — the nav's sync pill. */
export function agoLabel(value: string | null, now: Date = new Date()): string {
  const then = parseStoredTime(value)
  if (then === null) return 'nunca'
  const ms = Math.max(0, now.getTime() - then.getTime())
  if (ms < MINUTE) return `hace ${Math.floor(ms / 1000)} s`
  if (ms < HOUR) return `hace ${Math.floor(ms / MINUTE)} min`
  if (ms < DAY) return `hace ${Math.floor(ms / HOUR)} h`
  return `hace ${Math.floor(ms / DAY)} d`
}

const two = (n: number): string => String(n).padStart(2, '0')

/** "hoy, 14:22" · "ayer, 03:11" · "12/08/2026, 09:55" — when a case was last captured. */
export function captureLabel(value: string | null, now: Date = new Date()): string {
  const then = parseStoredTime(value)
  if (then === null) return '—'
  const clock = `${two(then.getHours())}:${two(then.getMinutes())}`
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.floor((midnight.getTime() - new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) / DAY)
  if (days <= 0) return `hoy, ${clock}`
  if (days === 1) return `ayer, ${clock}`
  return `${two(then.getDate())}/${two(then.getMonth() + 1)}/${then.getFullYear()}, ${clock}`
}

const MONTHS_PT = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
]

/**
 * The portal prints a distribution date as `22 de Agosto de 2026`. The design
 * shows `22/08/2026`. Anything this does not recognise is passed through
 * untouched: a date we cannot parse is still the tribunal's own answer, and
 * showing it verbatim beats showing a dash.
 */
export function courtDate(raw: string | null): string | null {
  if (raw === null) return null
  const value = raw.trim()
  if (value === '') return null

  const long = /^(\d{1,2})\s+de\s+(\p{L}+)\s+de\s+(\d{4})$/u.exec(value)
  if (long) {
    const month = MONTHS_PT.indexOf(long[2]!.toLowerCase())
    if (month !== -1) return `${two(Number(long[1]!))}/${two(month + 1)}/${long[3]!}`
  }
  // Already `DD/MM/YYYY`, possibly with a clock after it.
  const numeric = /^(\d{2}\/\d{2}\/\d{4})/.exec(value)
  if (numeric) return numeric[1]!
  return value
}

/** `01/09/2026 17:42:40` → `01/09/2026 17:42`; the design's timeline has no seconds. */
export function courtTimestamp(raw: string | null): string | null {
  if (raw === null) return null
  const value = raw.trim()
  if (value === '') return null
  const m = /^(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2})(?::\d{2})?$/.exec(value)
  return m ? m[1]! : value
}

/** `2026-09-02 02:48:28` (UTC) → `23:48:28` on a machine three hours behind. */
export function clockLabel(value: string | null): string {
  const at = parseStoredTime(value)
  if (at === null) return '—'
  return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`
}
