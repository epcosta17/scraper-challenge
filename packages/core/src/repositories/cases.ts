import type { Db } from '../db.ts'
import type { StoredCase, Party } from '../types.ts'

export class DuplicateCaseNumberError extends Error {
  readonly number: string
  readonly idProcessoTrf: number

  constructor(number: string, idProcessoTrf: number) {
    super(
      `Case number ${number} is already stored under a different id_processo_trf ` +
        `(attempted with id_processo_trf ${idProcessoTrf})`,
    )
    this.name = 'DuplicateCaseNumberError'
    this.number = number
    this.idProcessoTrf = idProcessoTrf
  }
}

interface Row {
  id_processo_trf: number
  number: string
  ca: string | null
  class_code: string | null
  class_name: string | null
  court: string | null
  panel: string | null
  distributed_at: string | null
  subjects_json: string
  parties_json: string
  summary_pdf_key: string | null
  jurisdiction: string | null
  court_address: string | null
  reference_number: string | null
}

const toStored = (r: Row): StoredCase => ({
  idProcessoTrf: r.id_processo_trf,
  number: r.number,
  ca: r.ca,
  className: r.class_name ?? '',
  classCode: r.class_code,
  court: r.court,
  panel: r.panel,
  distributedAt: r.distributed_at,
  subjects: JSON.parse(r.subjects_json) as string[],
  parties: JSON.parse(r.parties_json) as Party[],
  summaryPdfKey: r.summary_pdf_key,
  jurisdiction: r.jurisdiction,
  courtAddress: r.court_address,
  referenceNumber: r.reference_number,
})

export function upsertCase(db: Db, c: StoredCase): void {
  try {
    runUpsert(db, c)
  } catch (err) {
    if (isUniqueConstraintOn(err, 'cases.number')) {
      throw new DuplicateCaseNumberError(c.number, c.idProcessoTrf)
    }
    throw err
  }
}

function isUniqueConstraintOn(err: unknown, column: string): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: string }).code
  return code === 'SQLITE_CONSTRAINT_UNIQUE' && err.message.includes(column)
}

function runUpsert(db: Db, c: StoredCase): void {
  db.prepare(`
    INSERT INTO cases (
      id_processo_trf, number, ca, class_code, class_name, court, panel,
      distributed_at, subjects_json, parties_json, summary_pdf_key,
      jurisdiction, court_address, reference_number,
      first_seen_at, last_scraped_at
    ) VALUES (
      @id, @number, @ca, @classCode, @className, @court, @panel,
      @distributedAt, @subjects, @parties, @pdfKey,
      @jurisdiction, @courtAddress, @referenceNumber,
      datetime('now'), datetime('now')
    )
    ON CONFLICT(id_processo_trf) DO UPDATE SET
      number = excluded.number,
      ca = COALESCE(excluded.ca, cases.ca),
      class_code = excluded.class_code,
      class_name = excluded.class_name,
      court = excluded.court,
      panel = excluded.panel,
      distributed_at = excluded.distributed_at,
      subjects_json = CASE WHEN excluded.subjects_json = '[]' THEN cases.subjects_json ELSE excluded.subjects_json END,
      parties_json = CASE WHEN excluded.parties_json = '[]' THEN cases.parties_json ELSE excluded.parties_json END,
      summary_pdf_key = COALESCE(excluded.summary_pdf_key, cases.summary_pdf_key),
      -- Only ever known once the detail page has been fetched (see
      -- deep.ts's first, detail-less upsert right after the summary PDF),
      -- so a call that doesn't have them yet must not blank out a value a
      -- previous run already captured -- same COALESCE treatment as ca
      -- and summary_pdf_key above.
      jurisdiction = COALESCE(excluded.jurisdiction, cases.jurisdiction),
      court_address = COALESCE(excluded.court_address, cases.court_address),
      reference_number = COALESCE(excluded.reference_number, cases.reference_number),
      last_scraped_at = datetime('now')
  `).run({
    id: c.idProcessoTrf,
    number: c.number,
    ca: c.ca,
    classCode: c.classCode,
    className: c.className,
    court: c.court,
    panel: c.panel,
    distributedAt: c.distributedAt,
    subjects: JSON.stringify(c.subjects),
    parties: JSON.stringify(c.parties),
    pdfKey: c.summaryPdfKey,
    jurisdiction: c.jurisdiction,
    courtAddress: c.courtAddress,
    referenceNumber: c.referenceNumber,
  })
}

export function getCaseByNumber(db: Db, number: string): StoredCase | null {
  const row = db.prepare('SELECT * FROM cases WHERE number = ?').get(number) as Row | undefined
  return row ? toStored(row) : null
}

export function getCaseById(db: Db, id: number): StoredCase | null {
  const row = db.prepare('SELECT * FROM cases WHERE id_processo_trf = ?').get(id) as Row | undefined
  return row ? toStored(row) : null
}

export function getMaxCaseId(db: Db): number {
  const row = db.prepare('SELECT COALESCE(MAX(id_processo_trf), 0) AS m FROM cases')
    .get() as { m: number }
  return row.m
}
