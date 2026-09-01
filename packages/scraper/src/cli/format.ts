import type { CrawlProgress, CrawlSummary } from '../crawl/enumerate.ts'
import { DEFAULT_STOP_AFTER_MISSES } from '../crawl/enumerate.ts'
import type { DeepDocumentProgress, DeepCaseOutcome, DeepRangeSummary, DeepStepEvent } from '../crawl/deep.ts'
import type { SearchFilters } from '../pje/search.ts'
import type { HttpEvent } from '../http/client.ts'

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * The per-id line `--verbose` keeps for `crawl`/`daily`. Says what the id
 * turned out to be (the case number for a hit, the reason for a failure)
 * rather than only moving counters: a wall of `+ id=…` lines that never
 * names a case can't be checked against the portal by eye.
 */
export function progressLine(p: CrawlProgress): string {
  const mark = p.outcome === 'stored' ? '+' : p.outcome === 'absent' ? '.' : '!'
  const what =
    p.outcome === 'stored' ? (p.number ? `stored ${p.number}` : 'stored')
    : p.outcome === 'absent' ? 'absent'
    : p.error ? `failed: ${p.error}` : 'failed'
  return `${mark} id=${p.id}  ${what}  (stored=${p.stored} absent=${p.absent} failed=${p.failed})`
}

/**
 * A failed id, reported at the moment it fails. Printed at every level
 * except `--quiet`, unlike the per-id lines above: a failure is the one
 * per-id event that must not wait for the final summary to be seen.
 */
export function crawlFailureLine(p: CrawlProgress): string {
  return `! id ${p.id} failed: ${p.error ?? 'unknown error'}`
}

/**
 * The default (non-`--verbose`) periodic line `crawl`/`daily` print to
 * stderr — see `crawlPeriodicProgressLine`'s call site in `reporter.ts` for
 * how often. Per-id detail stays behind `--verbose` (`progressLine` above);
 * this is only meant to prove the run is alive and roughly how far it has
 * gotten.
 */
export function crawlPeriodicProgressLine(
  p: { checked: number; id: number; stored: number; absent: number; failed: number; number?: string },
): string {
  const at = p.number ? `at id ${p.id}, ${p.number}` : `at id ${p.id}`
  return `… ${plural(p.checked, 'id')} checked (${at})  stored=${p.stored} absent=${p.absent} failed=${p.failed}`
}

export function summaryLines(s: CrawlSummary): string {
  return [
    '',
    `Stored:  ${s.stored}`,
    `Absent:  ${s.absent}   (secret or unassigned ids — expected)`,
    `Failed:  ${s.failed}   (recorded in the failures table for retry)`,
    `Last id: ${s.lastId}`,
  ].join('\n')
}

/**
 * One line per document, kept for `--verbose`. `tag` attributes the line to
 * a case (see `DeepStepEvent`): with `--concurrency` above 1 several cases
 * narrate at once, and an untagged line belongs to no one.
 */
export function deepDocumentProgressLine(p: DeepDocumentProgress, tag: string): string {
  const mark = p.outcome === 'stored' ? '+' : p.outcome === 'skipped' ? '.' : '!'
  return `${tag}   ${mark} document id=${p.idProcessoDoc} (${p.docKind}) ${p.outcome}`
}

export function deepCaseOutcomeLines(o: DeepCaseOutcome): string {
  if (o.kind === 'failed') return `Case ${o.ref} failed: ${o.error}`
  return [
    `Case ${o.number} (id ${o.idProcessoTrf}):`,
    `  Documents stored:  ${o.documentsStored}`,
    `  Documents skipped: ${o.documentsSkipped}   (already downloaded)`,
    `  Documents failed:  ${o.documentsFailed}   (recorded in the failures table for retry)`,
  ].join('\n')
}

/**
 * The line a case ends on, tagged like every other line it printed. A
 * failed case is reported here, at its own position in the run, not only in
 * the final summary — a failure an hour into a range is worth seeing when
 * it happens.
 */
export function deepCaseProgressLine(o: DeepCaseOutcome, tag: string): string {
  if (o.kind === 'failed') return `${tag} FAILED: ${o.error}`
  const documents = o.documentsStored + o.documentsSkipped + o.documentsFailed
  const detail = o.documentsFailed > 0 ? `${o.documentsStored} new, ${o.documentsFailed} failed` : `${o.documentsStored} new`
  return `${tag} done: ${o.number} - ${plural(documents, 'document')} (${detail})`
}

/**
 * One step of the per-case chain, narrated as it starts (see
 * `DeepStepEvent` in `deep.ts` for why at the start rather than at the
 * end). `tag` identifies the case the line belongs to.
 */
export function deepStepLine(e: DeepStepEvent, tag: string): string {
  const line = (text: string): string => `${tag} ${text}`
  switch (e.kind) {
    case 'summary_pdf':
      return line('fetching the summary PDF')
    case 'summary_pdf_retry':
      return line(`! summary PDF came back HTTP ${e.status} - retry ${e.attempt} of ${e.of}`)
    case 'summary_pdf_ok':
      return line(`got ${e.number}${e.className ? ` (${e.className})` : ''}`)
    case 'detail_key':
      return line(`resolving the detail key: ${
        e.source === 'cached' ? 'reusing the cached ca'
        : e.source === 'search' ? 'searching by case number'
        : 'the cached ca is stale, searching by case number'
      }`)
    case 'detail_key_retry':
      return line(`! search bridge failed: ${e.reason} - retry ${e.attempt} of ${e.of}`)
    case 'case_file':
      return line('reading the case file')
    case 'case_file_ok':
      return line(`the case file lists ${plural(e.documentCount, 'document')}`)
    case 'documents':
      if (e.total === 0) return line('no documents to download')
      if (e.alreadyOnDisk >= e.total) return line(`downloading documents: ${e.total} already on disk, nothing to fetch`)
      if (e.alreadyOnDisk > 0) return line(`downloading documents: ${e.total - e.alreadyOnDisk} of ${e.total} (${e.alreadyOnDisk} already on disk)`)
      return line(`downloading documents: ${e.total} of ${e.total}`)
  }
}

export function deepRangeSummaryLines(s: DeepRangeSummary): string {
  return [
    '',
    `Cases done:        ${s.casesDone}`,
    `Cases failed:       ${s.casesFailed}   (recorded in the failures table for retry)`,
    `Documents stored:   ${s.documentsStored}`,
    `Documents skipped:  ${s.documentsSkipped}   (already downloaded)`,
    `Documents failed:   ${s.documentsFailed}   (recorded in the failures table for retry)`,
  ].join('\n')
}

/** Where a run's output is going — the same clause for every command's header. */
function destination(db: string, out: string): string {
  return `-> db ${db}, files ${out}`
}

/**
 * The first thing a run says: what it is about to do, at what scale, and
 * where the result will land. Printed before the first request, so a
 * mistyped `--db` or a range that is nothing like the one intended is
 * visible immediately rather than after the run.
 */
export function deepRunHeader(o: {
  target?: string; fromId?: number; toId?: number; concurrency: number; db: string; out: string
}): string {
  if (o.target !== undefined) return `Scraping case ${o.target} ${destination(o.db, o.out)}`
  const count = o.toId! - o.fromId! + 1
  const range = count === 1 ? `(id ${o.fromId})` : `(ids ${o.fromId}-${o.toId})`
  // Only worth saying when it can actually happen: a one-case range runs
  // one case whatever --concurrency says.
  const parallel = o.concurrency > 1 && count > 1 ? `, ${o.concurrency} at a time` : ''
  return `Scraping ${plural(count, 'case')} ${range}${parallel} ${destination(o.db, o.out)}`
}

export function crawlRunHeader(o: {
  command: 'crawl' | 'daily'; fromId?: number; toId?: number; limit?: number
  concurrency: number; rps: number; db: string; out: string
}): string {
  const scope =
    o.fromId !== undefined && o.toId !== undefined
      ? `${plural(o.toId - o.fromId + 1, 'id')} (${o.fromId}-${o.toId})`
      : `from ${o.fromId !== undefined ? `id ${o.fromId}` : 'the stored watermark'} ` +
        `${o.toId !== undefined ? `to id ${o.toId}` : `until ${DEFAULT_STOP_AFTER_MISSES} consecutive misses`}`
  const limit = o.limit !== undefined ? `, at most ${plural(o.limit, 'id')}` : ''
  const parallel = o.concurrency > 1 ? `, ${o.concurrency} at a time` : ''
  return `Crawling ${scope}${limit}${parallel} at ${o.rps} req/s ${destination(o.db, o.out)}`
}

export function searchRunHeader(filters: SearchFilters): string {
  const shown = Object.entries(filters).map(([k, v]) => `${k}=${v}`).join(', ')
  return `Searching the portal: ${shown || 'no filters'}`
}

/** `512 B`, `2.0 kB` — enough to spot an error page served where a PDF was expected. */
function bytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`
}

/** `900ms`, `2.0s` — a wait is quoted in whatever unit reads fastest. */
function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * One request, one line, under `--verbose` only. Indented under the
 * narration it belongs to: these are the requests a single narrated step
 * (see `deepStepLine`) actually made, retries included.
 */
export function httpEventLine(e: HttpEvent): string {
  switch (e.kind) {
    case 'request':
      return `  → ${e.method} ${e.url}${e.attempt > 1 ? ` (attempt ${e.attempt})` : ''}`
    case 'response':
      return `  ← ${e.status}  ${bytes(e.bytes)} in ${e.ms} ms`
    case 'retry': {
      const why =
        e.reason === 'rate_limited' ? `rate limited (HTTP ${e.status})`
        : e.reason === 'server_error' ? `server error (HTTP ${e.status})`
        : 'transport error'
      return `  ↻ ${why} - waiting ${duration(e.delayMs)} before attempt ${e.attempt + 1} of ${e.of}`
    }
  }
}

export function cappedWarning(): string {
  return [
    '',
    'WARNING: 30 results — the server cap was reached, so there are more.',
    "         The portal has no pagination. --partition is not implemented",
    "         in this phase; use `crawl` for complete coverage.",
  ].join('\n')
}

/**
 * What a `--dry-run` would do, as data rather than as a sentence. Both
 * output modes render this one object — `--json` serializes it, the default
 * runs it through `dryRunPlanLine` below — so the plan a pipeline reads can
 * never drift from the plan a human reads. A bound the command would have
 * defaulted is `null`, not a missing key, so a consumer can tell "defaulted"
 * from "given" without probing for absence.
 */
export type DryRunPlan =
  | { dryRun: true; command: 'search'; filters: SearchFilters }
  | { dryRun: true; command: 'crawl' | 'daily'; fromId: number | null; toId: number | null }
  | { dryRun: true; command: 'deep'; target: string | null; fromId: number | null; toId: number | null }

export function dryRunPlanLine(plan: DryRunPlan): string {
  switch (plan.command) {
    case 'search':
      return `Would search with filters: ${JSON.stringify(plan.filters)}`
    case 'deep':
      return plan.target !== null
        ? `Would deep-fetch case ${plan.target}`
        : `Would deep-fetch every case from id ${plan.fromId} to ${plan.toId}`
    default:
      return `Would crawl from ${plan.fromId ?? '(database watermark)'} ` +
             `to ${plan.toId ?? '(until 50 consecutive misses)'}`
  }
}
