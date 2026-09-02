/**
 * Reading the portal's own declared totals back out of the acervo.
 *
 * The schema has no "declared" column: when the scraper finds that a case's
 * detail page announces more rows than it could read, it files the discrepancy
 * as a `failures` row and puts both numbers in the message (see
 * `storeParties` and `checkMovementsTruncation` in
 * `packages/scraper/src/crawl/deep.ts`). That message is the only place the
 * declared total survives, so this is where the interface goes to find it.
 *
 * Both patterns are anchored on the fixed wording those two functions emit —
 * this is not a general-purpose parser for prose, it is the reader for one
 * writer. A message that does not match yields `null`, which the caller shows
 * as "incomplete, by an unknown amount" rather than as a clean count.
 */

/**
 * `Parsed 1 ativo / 10 passivo parties but the page states 1 / 40 — …`
 * The two stated numbers are per polo; the case's declared total is their sum.
 * A polo whose own table was not found is written `?` and makes the total
 * unknowable, so the whole thing comes back null rather than half-counted.
 */
const PARTIES_RE = /but the page states (\d+|\?) \/ (\d+|\?)/

/** `Parsed 12 movements from the summary PDF but the detail page states 39 — …` */
const MOVEMENTS_RE = /but the detail page states (\d+)/

export function declaredParties(error: string): number | null {
  const m = PARTIES_RE.exec(error)
  if (!m) return null
  const ativo = m[1]!
  const passivo = m[2]!
  if (ativo === '?' || passivo === '?') return null
  return Number(ativo) + Number(passivo)
}

export function declaredMovements(error: string): number | null {
  const m = MOVEMENTS_RE.exec(error)
  return m ? Number(m[1]!) : null
}
