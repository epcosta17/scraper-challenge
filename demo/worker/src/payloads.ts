import type { JobPayload } from '@pje/core'
import type { DeepTarget } from '@pje/scraper'
import { JobPayloadError } from './errors.ts'

/**
 * Every payload is checked against the exact set of keys its job type
 * understands, and an unrecognised one is an error rather than something to
 * ignore.
 *
 * Ignoring it is the tempting default — "be liberal in what you accept" —
 * and it is wrong here, because these payloads are mostly optional: a
 * `crawl` whose `fromId` was misspelled `fron` is still a perfectly valid
 * `crawl`, so it would run happily from the watermark, finish green, and
 * scrape a completely different range than the one that was asked for. The
 * failure would be invisible. Refusing the key turns that into a job whose
 * error says `fron`.
 */
function checkKeys(payload: JobPayload, allowed: readonly string[], type: string): void {
  const unknown = Object.keys(payload).filter((k) => !allowed.includes(k))
  if (unknown.length > 0) {
    throw new JobPayloadError(
      `A ${type} payload does not understand ${unknown.map((k) => `"${k}"`).join(', ')}. ` +
      `Known keys: ${allowed.join(', ')}.`,
    )
  }
}

/**
 * Reads an optional count. Ids and limits are whole numbers a person could
 * have typed into a form, so the ways they arrive wrong — a string that was
 * never parsed, a float, a negative, a NaN out of a failed `Number()` — all
 * have to be caught here rather than reaching the engine as an id it will
 * dutifully request.
 */
function optionalCount(payload: JobPayload, key: string, min: number): number | undefined {
  const raw = payload[key]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min) {
    throw new JobPayloadError(`"${key}" must be a whole number of at least ${min}, not ${JSON.stringify(raw)}.`)
  }
  return raw
}

function checkForwards(fromId: number | undefined, toId: number | undefined): void {
  if (fromId !== undefined && toId !== undefined && toId < fromId) {
    throw new JobPayloadError(`The range runs backwards: fromId ${fromId} is past toId ${toId}.`)
  }
}

/**
 * What `crawl` needs, which is deliberately the same shape the engine's own
 * `CrawlOptions` has — this is a queued spelling of that call, not a second
 * vocabulary to keep in step with it.
 *
 * Every field is optional, and the combinations mean what they mean in the
 * engine: no `fromId` resumes from the stored watermark, no `toId` walks on
 * until a streak of consecutive misses ends the run.
 */
export interface CrawlSpec {
  fromId?: number
  toId?: number
  limit?: number
  concurrency?: number
  stopAfterMisses?: number
}

const CRAWL_KEYS = ['fromId', 'toId', 'limit', 'concurrency', 'stopAfterMisses'] as const

/** Drops the keys that were absent, so the result compares equal to what was asked for. */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

export function parseCrawlPayload(payload: JobPayload): CrawlSpec {
  checkKeys(payload, CRAWL_KEYS, 'crawl')
  const spec: CrawlSpec = {
    fromId: optionalCount(payload, 'fromId', 0),
    toId: optionalCount(payload, 'toId', 0),
    limit: optionalCount(payload, 'limit', 1),
    concurrency: optionalCount(payload, 'concurrency', 1),
    stopAfterMisses: optionalCount(payload, 'stopAfterMisses', 1),
  }
  checkForwards(spec.fromId, spec.toId)
  return compact(spec)
}

const DEEP_CASE_KEYS = ['idProcessoTrf', 'number'] as const

/**
 * Resolves a single-case payload to the engine's own `DeepTarget`, which
 * already knows the difference between an internal id (used directly) and a
 * case number (resolved through the search bridge).
 *
 * Exactly one of the two, never both: a payload carrying an id *and* a
 * number is one whose author believed they agree, and the engine has no way
 * to check that belief — it would simply use one and silently ignore the
 * other, which is the wrong case to be quiet about.
 */
export function parseDeepCasePayload(payload: JobPayload): DeepTarget {
  checkKeys(payload, DEEP_CASE_KEYS, 'deep_case')
  const id = optionalCount(payload, 'idProcessoTrf', 1)
  const rawNumber = payload.number
  const number = typeof rawNumber === 'string' ? rawNumber.trim() : rawNumber

  if (id !== undefined && number !== undefined && number !== null) {
    throw new JobPayloadError('Name a case by exactly one of "idProcessoTrf" or "number", not both.')
  }
  if (id !== undefined) return { kind: 'id', id }
  if (typeof number === 'string' && number.length > 0) return { kind: 'number', number }
  if (number !== undefined && number !== null) {
    throw new JobPayloadError(`"number" must be a non-empty case number, not ${JSON.stringify(rawNumber)}.`)
  }
  throw new JobPayloadError('Name a case by exactly one of "idProcessoTrf" or "number".')
}

export interface DeepRangeSpec {
  fromId: number
  toId: number
  concurrency?: number
}

const DEEP_RANGE_KEYS = ['fromId', 'toId', 'concurrency'] as const

/**
 * Both ends are required, matching `deepRange` itself: a deep run has no
 * "stop after N misses" heuristic to end an open range with, because each
 * case costs a detail page and every document in it, and the caller is
 * expected to already know which ids are worth that.
 */
export function parseDeepRangePayload(payload: JobPayload): DeepRangeSpec {
  checkKeys(payload, DEEP_RANGE_KEYS, 'deep_range')
  const fromId = optionalCount(payload, 'fromId', 1)
  const toId = optionalCount(payload, 'toId', 1)
  if (fromId === undefined || toId === undefined) {
    throw new JobPayloadError('A deep_range needs both "fromId" and "toId" — there is no watermark to resume from.')
  }
  checkForwards(fromId, toId)
  return compact({ fromId, toId, concurrency: optionalCount(payload, 'concurrency', 1) })
}
