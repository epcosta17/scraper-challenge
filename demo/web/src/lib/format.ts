/** Number and date formatting for the interface — Spanish conventions. */

// 'always': es-ES would otherwise print 1284 ungrouped, and the design says 1.284.
const int = new Intl.NumberFormat('es-ES', { useGrouping: 'always' })
const compact = new Intl.NumberFormat('es-ES', {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const oneDecimal = new Intl.NumberFormat('es-ES', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

export const formatInt = (n: number): string => int.format(n)

/** 1_204_388 → "1,2 M" */
export const formatCompact = (n: number): string => compact.format(n)

/** 98.7 → "98,7 %" */
export const formatPercent = (n: number): string => `${oneDecimal.format(n)} %`

export const formatRate = (n: number): string => `${oneDecimal.format(n)} req/s`

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1000) return `${Math.round(kb)} KB`
  return `${oneDecimal.format(kb / 1024)} MB`
}

/** "31/08/2026 14:29" → "31/08/2026" */
export const dateOnly = (timestamp: string | null): string =>
  timestamp === null ? '—' : (timestamp.split(' ')[0] ?? timestamp)

/** Plural that reads right in Spanish for the counts this app shows. */
export const plural = (n: number, one: string, many: string): string =>
  `${formatInt(n)} ${n === 1 ? one : many}`

/** 1400 → "1,4 s" */
export const formatSeconds = (ms: number): string => `${oneDecimal.format(ms / 1000)} s`
