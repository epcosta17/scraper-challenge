import {
  upsertCase, recordProbe, recordFailure, getMaxCaseId,
  type Db, type BlobStore,
} from '@pje/core'
import { HttpClient } from '../http/client.ts'
import { fetchReportPdf } from '../pje/report.ts'
import { parseCaseRecord } from '../pdf/parse.ts'

export interface CrawlDeps {
  client: HttpClient
  db: Db
  blobs: BlobStore
}

export interface CrawlOptions {
  fromId?: number
  toId?: number
  limit?: number
  concurrency?: number
  /** When `toId` is absent, stop after this many consecutive misses. */
  stopAfterMisses?: number
  onProgress?: (p: CrawlProgress) => void
}

export interface CrawlProgress {
  id: number
  outcome: 'stored' | 'absent' | 'failed'
  stored: number
  absent: number
  failed: number
}

export interface CrawlSummary {
  stored: number
  absent: number
  failed: number
  lastId: number
}

/** `2026/0013475-36.2026.4.05.0000/summary.pdf` — descriptive and collision-free. */
export function pdfKeyFor(record: { number: string }): string {
  const year = record.number.split('.')[1] ?? 'unknown'
  return `${year}/${record.number}/summary.pdf`
}

/**
 * Enumerates `idProcessoTrf` sequentially, downloading each case's summary
 * PDF with up to `concurrency` workers in flight at once.
 *
 * Resumable: the watermark is `MAX(id_processo_trf)` in SQLite. Because the
 * report endpoint is stateless, a restart needs no session recovery.
 *
 * Every id examined resolves to exactly one of three outcomes, and none of
 * them stop the crawl:
 *  - `stored`: the PDF parsed and the case was upserted.
 *  - `absent`: the id yielded no PDF (unassigned or sealed) — recorded as a
 *    probe, not a failure, because roughly 15% of ids are expected misses.
 *  - `failed`: a 429 that survived every retry, or a malformed PDF —
 *    recorded as a failure. The crawl continues past it.
 */
export async function crawl(deps: CrawlDeps, opts: CrawlOptions): Promise<CrawlSummary> {
  const { client, db, blobs } = deps
  const concurrency = Math.max(1, opts.concurrency ?? 4)
  const stopAfterMisses = opts.stopAfterMisses ?? 50
  const start = opts.fromId ?? getMaxCaseId(db) + 1

  let stored = 0
  let absent = 0
  let failed = 0
  let lastId = start - 1
  let nextId = start

  // Workers race, so ids can *complete* out of order even though they are
  // *dispatched* in strict order. "Consecutive misses" must describe a run
  // at the tail of id order, not completion order — otherwise a fast miss
  // finishing ahead of a slow hit (or vice versa) could make the streak
  // fire early on an alternating id/hit interleaving, or under-count a
  // genuine one. A frontier walks ids in order and only folds an outcome
  // into `consecutiveMisses` once every id up to it is known, so the count
  // is exactly what it would be for a single-threaded crawl.
  const outcomes = new Map<number, CrawlProgress['outcome']>()
  let frontier = start
  let consecutiveMisses = 0

  const advanceFrontier = (): void => {
    for (;;) {
      const outcome = outcomes.get(frontier)
      if (outcome === undefined) return
      outcomes.delete(frontier)
      consecutiveMisses = outcome === 'absent' ? consecutiveMisses + 1 : 0
      frontier++
    }
  }

  const exhausted = (): boolean =>
    opts.toId !== undefined ? nextId > opts.toId : consecutiveMisses >= stopAfterMisses

  const takeId = (): number | null => {
    if (exhausted()) return null
    if (opts.limit !== undefined && nextId - start >= opts.limit) return null
    return nextId++
  }

  const handle = async (id: number): Promise<void> => {
    let outcome: CrawlProgress['outcome']
    try {
      const result = await fetchReportPdf(client, id)
      if (result.kind === 'absent') {
        recordProbe(db, id, 'not_found')
        absent++
        outcome = 'absent'
      } else {
        const record = parseCaseRecord(result.pdf)
        const key = pdfKeyFor(record)
        await blobs.put(key, result.pdf)
        upsertCase(db, {
          idProcessoTrf: id,
          number: record.number,
          ca: null,
          className: record.className,
          classCode: record.classCode,
          court: record.court,
          panel: record.panel,
          distributedAt: record.distributedAt,
          subjects: record.subjects,
          // Parties no longer come from the summary PDF; they arrive later
          // from the case detail page's HTML.
          parties: [],
          summaryPdfKey: key,
        })
        stored++
        outcome = 'stored'
      }
    } catch (err) {
      // A 429 that survived every retry, a malformed PDF, or two different
      // ids resolving to the same case number (DuplicateCaseNumberError).
      // Record and move on: the challenge requires continuing past
      // persistent failures.
      const message = err instanceof Error ? err.message : String(err)
      recordFailure(db, 'summary_pdf', String(id), message)
      failed++
      outcome = 'failed'
    }

    lastId = Math.max(lastId, id)
    outcomes.set(id, outcome)
    advanceFrontier()
    opts.onProgress?.({ id, outcome, stored, absent, failed })
  }

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const id = takeId()
      if (id === null) return
      await handle(id)
    }
  })
  await Promise.all(workers)

  return { stored, absent, failed, lastId }
}
