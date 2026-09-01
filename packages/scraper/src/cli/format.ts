import type { CrawlProgress, CrawlSummary } from '../crawl/enumerate.ts'
import type { DeepDocumentProgress, DeepCaseOutcome, DeepRangeSummary } from '../crawl/deep.ts'

export function progressLine(p: CrawlProgress): string {
  const mark = p.outcome === 'stored' ? '+' : p.outcome === 'absent' ? '.' : '!'
  return `${mark} id=${p.id}  stored=${p.stored} absent=${p.absent} failed=${p.failed}`
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
