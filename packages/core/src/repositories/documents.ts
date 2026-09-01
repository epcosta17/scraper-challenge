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
