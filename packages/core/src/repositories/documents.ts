import type { Db } from '../db.ts'

/**
 * A single document within a case's file. Binary (PDF) documents carry
 * `idBin`/`numeroDocumento` and a `pdfKey` into the blob store; HTML
 * documents carry neither — their content is small enough to live directly
 * in `textContent`, with no blob write at all. Exactly one of `pdfKey` /
 * `textContent` is populated, depending on which kind this row is.
 */
export interface DocumentRecord {
  idProcessoDocumento: number
  idProcessoTrf: number
  idBin: number | null
  numeroDocumento: string | null
  label: string
  docType: string | null
  docDate: string | null
  pdfKey: string | null
  textContent: string | null
}

export interface StoredDocument extends DocumentRecord {
  downloadedAt: string | null
}

interface Row {
  id_processo_documento: number
  id_processo_trf: number
  id_bin: number | null
  numero_documento: string | null
  label: string | null
  doc_type: string | null
  doc_date: string | null
  pdf_key: string | null
  text_content: string | null
  downloaded_at: string | null
}

const toStored = (r: Row): StoredDocument => ({
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
})

/**
 * Inserts or replaces a document row, stamping `downloaded_at`. Called only
 * once the document's content (a blob key, or the HTML text itself) is
 * already in hand — never as a "pending" placeholder — so a row in this
 * table always means "downloaded", matching `isDocumentDownloaded` below.
 *
 * For a binary document, call this *before* writing the blob (mirroring
 * `upsertCase` in `crawl/enumerate.ts`): if the row insert fails, the blob
 * is never touched, so a failed insert can't orphan a PDF with no row
 * pointing at it.
 */
export function upsertDocument(db: Db, d: DocumentRecord): void {
  db.prepare(`
    INSERT INTO documents (
      id_processo_documento, id_processo_trf, id_bin, numero_documento,
      label, doc_type, doc_date, pdf_key, text_content, downloaded_at
    ) VALUES (
      @idProcessoDocumento, @idProcessoTrf, @idBin, @numeroDocumento,
      @label, @docType, @docDate, @pdfKey, @textContent, datetime('now')
    )
    ON CONFLICT(id_processo_documento) DO UPDATE SET
      id_processo_trf = excluded.id_processo_trf,
      id_bin = excluded.id_bin,
      numero_documento = excluded.numero_documento,
      label = excluded.label,
      doc_type = excluded.doc_type,
      doc_date = excluded.doc_date,
      pdf_key = excluded.pdf_key,
      text_content = excluded.text_content,
      downloaded_at = datetime('now')
  `).run({
    idProcessoDocumento: d.idProcessoDocumento,
    idProcessoTrf: d.idProcessoTrf,
    idBin: d.idBin,
    numeroDocumento: d.numeroDocumento,
    label: d.label,
    docType: d.docType,
    docDate: d.docDate,
    pdfKey: d.pdfKey,
    textContent: d.textContent,
  })
}

/** True once a document has been downloaded and stored — the resume check. */
export function isDocumentDownloaded(db: Db, idProcessoDocumento: number): boolean {
  const row = db.prepare('SELECT downloaded_at FROM documents WHERE id_processo_documento = ?')
    .get(idProcessoDocumento) as { downloaded_at: string | null } | undefined
  return row?.downloaded_at != null
}

export function getDocumentsByCase(db: Db, idProcessoTrf: number): StoredDocument[] {
  const rows = db.prepare('SELECT * FROM documents WHERE id_processo_trf = ? ORDER BY id_processo_documento')
    .all(idProcessoTrf) as Row[]
  return rows.map(toStored)
}

/** A document with the case it belongs to, for listings that cross cases. */
export interface SampledDocument extends StoredDocument {
  caseNumber: string
  className: string
}

/**
 * Documents from across the acervo, for browsing rather than searching.
 *
 * Every other document query needs an id or a case, which leaves no way to
 * answer "show me a few" — the question someone asks before they know what is
 * in here. `random` is the honest reading of "any three"; `recent` orders by
 * the document's own date, newest first.
 *
 * Only downloaded documents are returned: one still queued has a row but no
 * content behind it, and offering it would promise something unreadable.
 */
export function sampleDocuments(
  db: Db,
  limit: number,
  order: 'random' | 'recent' = 'random',
): SampledDocument[] {
  const rows = db.prepare(`
    SELECT d.*, c.number AS case_number, c.class_name AS case_class_name
    FROM documents d
    JOIN cases c ON c.id_processo_trf = d.id_processo_trf
    WHERE d.downloaded_at IS NOT NULL
    ORDER BY ${order === 'recent'
      // dd/mm/yyyy reordered so it sorts as text; undated documents last.
      ? `CASE WHEN d.doc_date IS NULL THEN 1 ELSE 0 END,
         substr(d.doc_date, 7, 4) || substr(d.doc_date, 4, 2) || substr(d.doc_date, 1, 2) DESC`
      : 'RANDOM()'}
    LIMIT ?
  `).all(limit) as Array<Row & { case_number: string; case_class_name: string }>

  return rows.map((r) => ({
    ...toStored(r),
    caseNumber: r.case_number,
    className: r.case_class_name,
  }))
}
