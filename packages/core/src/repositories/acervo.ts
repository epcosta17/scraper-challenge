import type { Db } from '../db.ts'
import type { StoredMovement } from '../types.ts'
import type { StoredDocument } from './documents.ts'

/**
 * Read-only projections of the acervo, for a reader — a UI, a report — that
 * needs a *page* of cases with their counts rather than one case at a time.
 *
 * Everything here is a SELECT. The write path stays where it is (see
 * `cases.ts`, `documents.ts`, `parties.ts`, `movements.ts`); these functions
 * exist because reading the archive as a whole was the one thing the
 * repositories could not do: `getCaseByNumber` answers about one case,
 * `getDocumentsByCase` about one case's documents, and a listing built out of
 * them costs one query per case per column.
 */

/** One row of a case listing: the case, when it was captured, and how much of it there is. */
export interface AcervoCaseRow {
  idProcessoTrf: number
  number: string
  className: string
  classCode: string | null
  court: string | null
  panel: string | null
  distributedAt: string | null
  jurisdiction: string | null
  referenceNumber: string | null
  firstSeenAt: string
  lastScrapedAt: string
  partyCount: number
  documentCount: number
  movementCount: number
}

interface CaseRow {
  id_processo_trf: number
  number: string
  class_name: string | null
  class_code: string | null
  court: string | null
  panel: string | null
  distributed_at: string | null
  jurisdiction: string | null
  reference_number: string | null
  first_seen_at: string
  last_scraped_at: string
  party_count: number
  document_count: number
  movement_count: number
}

const toCaseRow = (r: CaseRow): AcervoCaseRow => ({
  idProcessoTrf: r.id_processo_trf,
  number: r.number,
  className: r.class_name ?? '',
  classCode: r.class_code,
  court: r.court,
  panel: r.panel,
  distributedAt: r.distributed_at,
  jurisdiction: r.jurisdiction,
  referenceNumber: r.reference_number,
  firstSeenAt: r.first_seen_at,
  lastScrapedAt: r.last_scraped_at,
  partyCount: r.party_count,
  documentCount: r.document_count,
  movementCount: r.movement_count,
})

// Correlated subqueries rather than three LEFT JOIN ... GROUP BYs: each one
// rides its table's `idx_*_case` index, and joining three one-to-many tables
// at once would multiply the rows out before the grouping could put them back.
const CASE_COLUMNS = `
  c.id_processo_trf, c.number, c.class_name, c.class_code, c.court, c.panel,
  c.distributed_at, c.jurisdiction, c.reference_number,
  c.first_seen_at, c.last_scraped_at,
  (SELECT COUNT(*) FROM parties   p WHERE p.id_processo_trf = c.id_processo_trf) AS party_count,
  (SELECT COUNT(*) FROM documents d WHERE d.id_processo_trf = c.id_processo_trf) AS document_count,
  (SELECT COUNT(*) FROM movements m WHERE m.id_processo_trf = c.id_processo_trf) AS movement_count
`

/**
 * A page of the acervo, most recently captured first.
 *
 * `last_scraped_at` has a one-second resolution and a range run stores several
 * cases within the same second, so `id_processo_trf` breaks the tie — without
 * it two cases could swap places between two page requests and one of them
 * would never be seen.
 */
export function listCasesPage(db: Db, opts: { limit: number; offset?: number }): AcervoCaseRow[] {
  const rows = db.prepare(`
    SELECT ${CASE_COLUMNS}
    FROM cases c
    ORDER BY c.last_scraped_at DESC, c.id_processo_trf DESC
    LIMIT @limit OFFSET @offset
  `).all({ limit: opts.limit, offset: opts.offset ?? 0 }) as CaseRow[]
  return rows.map(toCaseRow)
}

/** The same row shape as `listCasesPage`, for one case, by its CNJ number. */
export function getAcervoCase(db: Db, number: string): AcervoCaseRow | null {
  const row = db.prepare(`
    SELECT ${CASE_COLUMNS} FROM cases c WHERE c.number = ?
  `).get(number) as CaseRow | undefined
  return row ? toCaseRow(row) : null
}

/**
 * Every movement of every case in `ids`, in one query — the listing needs one
 * movement per case and would otherwise pay a round trip per row.
 * An empty `ids` returns `[]` without touching the database.
 */
export function getMovementsForCases(db: Db, ids: readonly number[]): StoredMovement[] {
  if (ids.length === 0) return []
  const rows = db.prepare(`
    SELECT id_processo_trf, position, timestamp, description
    FROM movements
    WHERE id_processo_trf IN (${ids.map(() => '?').join(', ')})
    ORDER BY id_processo_trf, position
  `).all(...ids) as Array<{
    id_processo_trf: number; position: number; timestamp: string | null; description: string
  }>
  return rows.map((r) => ({
    idProcessoTrf: r.id_processo_trf,
    position: r.position,
    timestamp: r.timestamp,
    description: r.description,
  }))
}

/** One document by its own id, whatever case it belongs to — the lookup a document URL needs. */
export function getDocumentById(db: Db, idProcessoDocumento: number): StoredDocument | null {
  const r = db.prepare('SELECT * FROM documents WHERE id_processo_documento = ?')
    .get(idProcessoDocumento) as {
      id_processo_documento: number; id_processo_trf: number; id_bin: number | null
      numero_documento: string | null; label: string | null; doc_type: string | null
      doc_date: string | null; pdf_key: string | null; text_content: string | null
      downloaded_at: string | null
    } | undefined
  if (!r) return null
  return {
    idProcessoDocumento: r.id_processo_documento,
    idProcessoTrf: r.id_processo_trf,
    idBin: r.id_bin,
    numeroDocumento: r.numero_documento,
    label: r.label ?? '',
    docType: r.doc_type,
    docDate: r.doc_date,
    pdfKey: r.pdf_key,
    textContent: r.text_content,
    downloadedAt: r.downloaded_at,
  }
}

/**
 * Acervo-wide counters, in one round trip.
 *
 * `probedIds` counts the ids the scraper has already looked at and found
 * nothing behind (sealed or unassigned — see `probes`); together with
 * `caseCount` over `minCaseId..maxCaseId` it is what makes "how much of the id
 * space have we actually read" answerable rather than guessed.
 */
export interface AcervoTotals {
  caseCount: number
  documentCount: number
  partyCount: number
  movementCount: number
  probedIds: number
  minCaseId: number | null
  maxCaseId: number | null
  /** UTC `YYYY-MM-DD HH:MM:SS`, as `datetime('now')` writes it. Null on an empty acervo. */
  lastScrapedAt: string | null
}

export function getAcervoTotals(db: Db): AcervoTotals {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM cases)                   AS case_count,
      (SELECT COUNT(*) FROM documents)               AS document_count,
      (SELECT COUNT(*) FROM parties)                 AS party_count,
      (SELECT COUNT(*) FROM movements)               AS movement_count,
      (SELECT COUNT(*) FROM probes)                  AS probed_ids,
      (SELECT MIN(id_processo_trf) FROM cases)       AS min_case_id,
      (SELECT MAX(id_processo_trf) FROM cases)       AS max_case_id,
      (SELECT MAX(last_scraped_at) FROM cases)       AS last_scraped_at
  `).get() as {
    case_count: number; document_count: number; party_count: number; movement_count: number
    probed_ids: number; min_case_id: number | null; max_case_id: number | null
    last_scraped_at: string | null
  }
  return {
    caseCount: row.case_count,
    documentCount: row.document_count,
    partyCount: row.party_count,
    movementCount: row.movement_count,
    probedIds: row.probed_ids,
    minCaseId: row.min_case_id,
    maxCaseId: row.max_case_id,
    lastScrapedAt: row.last_scraped_at,
  }
}

/**
 * How much was captured since `sinceUtc` (a `YYYY-MM-DD HH:MM:SS` string in
 * the same UTC scale `datetime('now')` writes, which is what every timestamp
 * column in this schema holds).
 */
export function countCapturedSince(db: Db, sinceUtc: string): { cases: number; documents: number } {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM cases     WHERE last_scraped_at >= @since) AS cases,
      (SELECT COUNT(*) FROM documents WHERE downloaded_at   >= @since) AS documents
  `).get({ since: sinceUtc }) as { cases: number; documents: number }
  return row
}
