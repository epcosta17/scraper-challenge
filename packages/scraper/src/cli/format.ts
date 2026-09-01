import type { CrawlProgress, CrawlSummary } from '../crawl/enumerate.ts'
import type { DeepDocumentProgress, DeepCaseOutcome, DeepRangeSummary, DeepStepEvent } from '../crawl/deep.ts'

export function progressLine(p: CrawlProgress): string {
  const mark = p.outcome === 'stored' ? '+' : p.outcome === 'absent' ? '.' : '!'
  return `${mark} id=${p.id}  stored=${p.stored} absent=${p.absent} failed=${p.failed}`
}

/**
 * The default (non-`--verbose`) periodic line `crawl`/`daily` print to
 * stderr — see `crawlPeriodicProgressLine`'s call site in `run.ts` for how
 * often. Per-id detail stays behind `--verbose` (`progressLine` above); this
 * is only meant to prove the run is alive and roughly how far it has gotten.
 */
export function crawlPeriodicProgressLine(p: { checked: number; id: number; stored: number; absent: number; failed: number }): string {
  return `… ${p.checked} ids checked (at id ${p.id})  stored=${p.stored} absent=${p.absent} failed=${p.failed}`
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

export function deepDocumentProgressLine(p: DeepDocumentProgress): string {
  const mark = p.outcome === 'stored' ? '+' : p.outcome === 'skipped' ? '.' : '!'
  return `  ${mark} document id=${p.idProcessoDoc} (${p.docKind}) ${p.outcome}`
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
 * The default (non-`--verbose`) line `deep` prints, to stderr, as each case
 * in a range *finishes* — the one place a default run stays visibly alive
 * (see the module doc in `run.ts` for why: the per-case chain is otherwise
 * silent for the several seconds it takes to run). `pos`/`total` give the
 * running position within the range; a failed case is reported here too,
 * not only in the final summary, so a failure is visible the moment it
 * happens rather than only after the whole range finishes.
 */
export function deepCaseProgressLine(pos: number, total: number, o: DeepCaseOutcome): string {
  const prefix = `[${pos}/${total}]`
  if (o.kind === 'failed') return `${prefix} ${o.ref} FAILED: ${o.error}`
  const documents = o.documentsStored + o.documentsSkipped + o.documentsFailed
  const detail = o.documentsFailed > 0 ? `${o.documentsStored} new, ${o.documentsFailed} failed` : `${o.documentsStored} new`
  return `${prefix} ${o.number}  ${documents} documents (${detail})`
}

/**
 * The `--verbose` trace of one step of the per-case chain starting — see
 * `DeepStepEvent`'s doc comment in `deep.ts` for why each step is named as
 * it *starts* rather than only reported once the whole chain is done.
 */
export function deepStepLine(e: DeepStepEvent): string {
  switch (e.kind) {
    case 'case_start': return e.ref
    case 'summary_pdf': return '  → summary PDF'
    case 'search_bridge': return '  → resolving ca (search bridge)'
    case 'detail_page': return `  → detail page: ${e.documentCount} document${e.documentCount === 1 ? '' : 's'}`
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

export function cappedWarning(): string {
  return [
    '',
    'WARNING: 30 results — the server cap was reached, so there are more.',
    "         The portal has no pagination. --partition is not implemented",
    "         in this phase; use `crawl` for complete coverage.",
  ].join('\n')
}
