import type { CrawlProgress, CrawlSummary } from '../crawl/enumerate.ts'

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

export function cappedWarning(): string {
  return [
    '',
    'WARNING: 30 results — the server cap was reached, so there are more.',
    "         The portal has no pagination. --partition is not implemented",
    "         in this phase; use `crawl` for complete coverage.",
  ].join('\n')
}
