export interface BackoffOptions {
  baseMs: number
  factor: number
  /** Fractional jitter band, e.g. 0.25 means +/-25%. */
  jitter: number
  capMs: number
  maxAttempts: number
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 1000,
  factor: 2,
  jitter: 0.25,
  capMs: 60_000,
  maxAttempts: 5,
}

/**
 * Delay before retry number `attempt` (0-based), with symmetric jitter.
 * `random` is injectable so the schedule is testable.
 */
export function backoffDelay(
  attempt: number,
  opts: Partial<BackoffOptions> = {},
  random: () => number = Math.random,
): number {
  const o = { ...DEFAULT_BACKOFF, ...opts }
  const raw = Math.min(o.baseMs * o.factor ** attempt, o.capMs)
  const offset = (random() * 2 - 1) * o.jitter // -jitter..+jitter
  return Math.max(0, Math.round(raw * (1 + offset)))
}

/** Parse a Retry-After header in either delay-seconds or HTTP-date form. */
export function retryAfterMs(header: string | null, now: Date = new Date()): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const when = Date.parse(trimmed)
  if (Number.isNaN(when)) return null
  return Math.max(0, when - now.getTime())
}
