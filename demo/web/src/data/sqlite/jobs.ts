import type { JobKind } from '../types.ts'

/**
 * The contract between the button on `/procesos` and whatever drains the
 * queue.
 *
 * `jobs.payload_json` is free-form by design (see `schema.ts`), which means
 * the enqueuer and the worker have to agree on a shape somewhere, and there is
 * no schema to hold them to it. This module is the web's half of that
 * agreement, written down in one place so the other half has something exact
 * to read:
 *
 *   deep_case     { "number": "0800120-05.2024.4.05.8306" } | { "id": 130105 }
 *   refresh_case  { "number": "…" }                        | { "id": 130105 }
 *   backfill      { "fromId": 130100, "toId": 130400 }
 *   discover      { "fromId": 130100, "toId": 130400 }      | {}
 *
 * `deep_case`/`refresh_case` take one case, by the number a person can read
 * off the screen or by the portal's internal id. `backfill` takes a closed id
 * range and needs both ends. `discover` walks forward from the watermark and
 * takes an optional range to bound it.
 */

const CASE_NUMBER_RE = /^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/
// A dash, an en dash or `..`, so a range pasted out of the CLI's own output
// ("ids 130100–130400") parses as readily as one typed by hand.
const RANGE_RE = /^(\d+)\s*(?:-|–|\.\.)\s*(\d+)$/
const ID_RE = /^\d+$/

export type JobPayload = Record<string, unknown>

export type TargetParse =
  | { ok: true; payload: JobPayload }
  | { ok: false; error: string }

/** Drops the decoration the CLI prints around a range: `ids 130100–130400`. */
const clean = (raw: string): string => raw.trim().replace(/^ids?\s+/i, '').trim()

export function parseTarget(kind: JobKind, raw: string): TargetParse {
  const value = clean(raw)

  if (kind === 'deep_case' || kind === 'refresh_case') {
    if (CASE_NUMBER_RE.test(value)) return { ok: true, payload: { number: value } }
    if (ID_RE.test(value)) return { ok: true, payload: { id: Number(value) } }
    return {
      ok: false,
      error: 'Indica un nº de expediente (0800120-05.2024.4.05.8306) o un id interno (130105).',
    }
  }

  const range = RANGE_RE.exec(value)
  if (kind === 'backfill') {
    if (!range) return { ok: false, error: 'Un backfill necesita un rango de ids: 130100–130400.' }
    return rangePayload(range)
  }

  // discover
  if (value === '') return { ok: true, payload: {} }
  if (!range) return { ok: false, error: 'Deja el objetivo vacío para seguir la marca de agua, o indica un rango: 130100–130400.' }
  return rangePayload(range)
}

function rangePayload(range: RegExpExecArray): TargetParse {
  const fromId = Number(range[1]!)
  const toId = Number(range[2]!)
  if (fromId > toId) return { ok: false, error: `El rango va al revés: ${fromId} es mayor que ${toId}.` }
  return { ok: true, payload: { fromId, toId } }
}

/**
 * The payload as a line of the queue table. Reads back what was enqueued
 * rather than a stored label, so a job a *worker* or the CLI put on the queue
 * — with a payload this module never wrote — still describes itself instead of
 * showing a blank cell.
 */
export function describeTarget(payload: JobPayload): string {
  if (typeof payload.number === 'string') return payload.number
  if (typeof payload.id === 'number') return `id ${payload.id}`
  if (typeof payload.fromId === 'number' && typeof payload.toId === 'number') {
    return `ids ${payload.fromId}–${payload.toId}`
  }
  const keys = Object.keys(payload)
  if (keys.length === 0) return 'desde la marca de agua'
  return JSON.stringify(payload)
}

export const JOB_KINDS: readonly JobKind[] = ['deep_case', 'refresh_case', 'backfill', 'discover']

export const isJobKind = (value: string): value is JobKind =>
  (JOB_KINDS as readonly string[]).includes(value)
