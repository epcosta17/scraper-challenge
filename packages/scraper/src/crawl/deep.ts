import {
  upsertCase, getCaseById, getCaseByNumber, recordFailure, resolveFailure,
  isDocumentDownloaded, upsertDocument,
  type Db, type BlobStore, type StoredCase,
} from '@pje/core'
import { HttpClient } from '../http/client.ts'
import { fetchReportPdf } from '../pje/report.ts'
import { startSession } from '../pje/session.ts'
import { search } from '../pje/search.ts'
import { fetchDetail, type DocumentRef } from '../pje/detail.ts'
import { downloadDocument } from '../pje/download.ts'
import { parseCaseRecord, type CaseRecord } from '../pdf/parse.ts'
import { pdfKeyFor } from './enumerate.ts'

export interface DeepDeps {
  client: HttpClient
  db: Db
  blobs: BlobStore
}

/** Either a known internal id, or a case number to resolve through the search bridge. */
export type DeepTarget = { kind: 'id'; id: number } | { kind: 'number'; number: string }

export interface DeepDocumentProgress {
  idProcessoTrf: number
  idProcessoDoc: number
  docKind: DocumentRef['kind']
  outcome: 'stored' | 'skipped' | 'failed'
}

export interface DeepOptions {
  onDocumentProgress?: (p: DeepDocumentProgress) => void
}

export type DeepCaseOutcome =
  | {
      kind: 'done'
      idProcessoTrf: number
      number: string
      documentsStored: number
      documentsSkipped: number
      documentsFailed: number
    }
  | { kind: 'failed'; ref: string; error: string }

export class CaseNotFoundError extends Error {
  constructor(number: string) {
    super(`The search bridge found no case matching number ${number}.`)
    this.name = 'CaseNotFoundError'
  }
}

/**
 * Strips or replaces everything a filesystem path segment can't safely
 * carry: path separators (so a document label can never fake a nested
 * directory or, worse, `..` its way out of one), control characters, and
 * anything that isn't a letter, digit, dot, dash, underscore or space —
 * letters keep their accents (`\p{L}`), since this is display data, not an
 * ascii-only identifier. Collapsing repeated dots also closes off `..`
 * arriving disguised inside an otherwise-ordinary-looking label.
 */
export function sanitizeFilename(raw: string): string {
  const cleaned = raw
    .normalize('NFC')
    .replace(/[/\\:]/g, '-')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/[^\p{L}\p{N}._\- ]+/gu, '_')
    .replace(/\s+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-._\s]+|[-._\s]+$/g, '')
  // A result with no actual letter or digit (e.g. input that was nothing but
  // separators, like `///`) is as good as empty — fall back rather than
  // handing the blob store a filename of pure dashes/underscores.
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : 'document'
}

/**
 * `<year>/<case-number>/documents/<date>-<type>-<id>.pdf` — hangs off the
 * same case directory `pdfKeyFor` (in `enumerate.ts`) uses for the summary
 * PDF. The document's own id is appended (not just decoration: two
 * documents of the same type filed in the same second are possible, and
 * this is what keeps the key collision-free without it).
 */
export function documentPdfKeyFor(caseNumber: string, ref: DocumentRef): string {
  const year = caseNumber.split('.')[1] ?? 'unknown'
  const date = ref.date ?? 'unknown-date'
  const type = ref.type ?? 'documento'
  const base = sanitizeFilename(`${date}-${type}-${ref.id}`)
  return `${year}/${caseNumber}/documents/${base}.pdf`
}

function caseUpsertFromRecord(idProcessoTrf: number, record: CaseRecord, ca: string | null, summaryPdfKey: string): StoredCase {
  return {
    idProcessoTrf,
    number: record.number,
    ca,
    className: record.className,
    classCode: record.classCode,
    court: record.court,
    panel: record.panel,
    distributedAt: record.distributedAt,
    subjects: record.subjects,
    // Parties still come only from the summary PDF path (none — see
    // enumerate.ts) until a party parser is built; out of scope here.
    parties: [],
    summaryPdfKey,
  }
}

/**
 * Serializes the search bridge per `HttpClient`. Found live under
 * `deepRange`'s worker pool: `startSession` + `search` share one cookie jar
 * across every worker (the same jar the whole run's requests share), and two
 * of them bootstrapping a session at once can interleave — one worker's
 * session cookie lands in the jar just as another's POST goes out bound to
 * the OTHER worker's now-stale `actionUrl`/`submitParam`, and the server
 * reports the AJAX action never ran. The bridge itself is only hit for ids
 * without an already-valid cached `ca`, so serializing just this part costs
 * little against the throughput a whole run needs.
 */
const searchBridgeQueue = new WeakMap<HttpClient, Promise<unknown>>()

async function runExclusive<T>(client: HttpClient, fn: () => Promise<T>): Promise<T> {
  const prior = searchBridgeQueue.get(client) ?? Promise.resolve()
  const result = prior.then(fn, fn)
  searchBridgeQueue.set(client, result.then(() => undefined, () => undefined))
  return result
}

/** Runs the search bridge for one case number, returning its id and a fresh `ca`. */
async function searchForCa(client: HttpClient, number: string): Promise<{ idProcessoTrf: number; ca: string }> {
  return runExclusive(client, async () => {
    const session = await startSession(client)
    const outcome = await search(client, session, { number })
    const row = outcome.rows.find((r) => r.number === number)
    if (!row) throw new CaseNotFoundError(number)
    return { idProcessoTrf: row.idProcessoTrf, ca: row.ca }
  })
}

/** Resolves a target to an id and whatever `ca` is already on file for it (a cache, not a fact — see `fetchDetail`). */
async function resolveTarget(deps: DeepDeps, target: DeepTarget): Promise<{ idProcessoTrf: number; ca: string | null }> {
  if (target.kind === 'id') {
    const stored = getCaseById(deps.db, target.id)
    return { idProcessoTrf: target.id, ca: stored?.ca ?? null }
  }
  const stored = getCaseByNumber(deps.db, target.number)
  if (stored) return { idProcessoTrf: stored.idProcessoTrf, ca: stored.ca }
  return searchForCa(deps.client, target.number)
}

/**
 * Downloads and stores one document. Binary documents get a row plus a
 * blob, written in that order — matching the ordering decision already
 * made for the summary PDF in `enumerate.ts` — so a failed blob write can
 * never leave a PDF on disk with no row pointing at it. HTML documents get
 * only a row: their content is small enough to live in `text_content`
 * directly, with no blob write at all.
 *
 * Throws on `absent`/`transient` so the caller's per-document catch
 * handles every failure mode uniformly.
 */
async function downloadOneDocument(deps: DeepDeps, idProcessoTrf: number, caseNumber: string, ref: DocumentRef): Promise<void> {
  const result = await downloadDocument(deps.client, ref)

  if (result.kind === 'absent') {
    throw new Error(`Document ${ref.id} came back as a recognised error page: ${result.finalUrl}`)
  }
  if (result.kind === 'transient') {
    throw new Error(`Document ${ref.id} failed with a transient HTTP ${result.status} from ${result.finalUrl}`)
  }

  if (ref.kind === 'binary' && result.kind === 'pdf') {
    const key = documentPdfKeyFor(caseNumber, ref)
    upsertDocument(deps.db, {
      idProcessoDocumento: ref.id,
      idProcessoTrf,
      idBin: ref.idBin,
      numeroDocumento: ref.numeroDocumento,
      label: ref.label,
      docType: ref.type,
      docDate: ref.date,
      pdfKey: key,
      textContent: null,
    })
    await deps.blobs.put(key, result.pdf)
    return
  }
  if (ref.kind === 'html' && result.kind === 'html') {
    upsertDocument(deps.db, {
      idProcessoDocumento: ref.id,
      idProcessoTrf,
      idBin: null,
      numeroDocumento: null,
      label: ref.label,
      docType: ref.type,
      docDate: ref.date,
      pdfKey: null,
      textContent: result.html,
    })
    return
  }
  // downloadDocument's result kind always tracks ref.kind (binary -> pdf,
  // html -> html); reaching here would mean that contract broke.
  throw new Error(`Unexpected '${result.kind}' download result for a '${ref.kind}' document reference (id ${ref.id}).`)
}

/**
 * Runs the whole chain for one case: summary PDF -> case number -> `ca`
 * (reused from storage, or re-derived through the search bridge) -> detail
 * page -> every document in it.
 *
 * Never throws for an expected failure — an absent id, a search-bridge
 * miss, a `ca` still invalid after refreshing it, any single document
 * failure — all come back as part of the returned outcome (and are
 * recorded in `failures`) so `deepRange` can always continue with the next
 * id. A document failure never aborts the case, and a case failure never
 * aborts the range.
 */
export async function deepCase(deps: DeepDeps, target: DeepTarget, opts: DeepOptions = {}): Promise<DeepCaseOutcome> {
  const { client, db, blobs } = deps
  const targetRef = target.kind === 'id' ? String(target.id) : target.number
  let idProcessoTrf: number | undefined

  try {
    const resolved = await resolveTarget(deps, target)
    idProcessoTrf = resolved.idProcessoTrf
    let ca = resolved.ca

    const report = await fetchReportPdf(client, idProcessoTrf)
    if (report.kind !== 'pdf') {
      throw new Error(
        report.kind === 'absent'
          ? `No summary PDF for id ${idProcessoTrf} (unassigned or sealed).`
          : `Transient HTTP ${report.status} fetching the summary PDF for id ${idProcessoTrf}.`,
      )
    }
    const record = parseCaseRecord(report.pdf)
    const summaryKey = pdfKeyFor(record)
    // Row before blob — see `downloadOneDocument`'s comment; same reasoning
    // applies to the summary PDF (and is already established in enumerate.ts).
    upsertCase(db, caseUpsertFromRecord(idProcessoTrf, record, ca, summaryKey))
    await blobs.put(summaryKey, report.pdf)
    resolveFailure(db, 'summary_pdf', String(idProcessoTrf))

    let detail = ca ? await fetchDetail(client, ca) : null
    if (!detail || detail.kind !== 'valid') {
      // `ca` is absent or the detail page said it's stale: re-derive it
      // through the search bridge and update the stored value.
      const bridged = await searchForCa(client, record.number)
      ca = bridged.ca
      detail = await fetchDetail(client, ca)
      if (detail.kind !== 'valid') {
        throw new Error(`Detail page for case ${record.number} is still invalid right after refreshing ca.`)
      }
      upsertCase(db, caseUpsertFromRecord(idProcessoTrf, record, ca, summaryKey))
    }

    let stored = 0
    let skipped = 0
    let failed = 0
    for (const docRef of detail.documents) {
      if (isDocumentDownloaded(db, docRef.id)) {
        skipped++
        opts.onDocumentProgress?.({ idProcessoTrf, idProcessoDoc: docRef.id, docKind: docRef.kind, outcome: 'skipped' })
        continue
      }
      try {
        await downloadOneDocument(deps, idProcessoTrf, record.number, docRef)
        stored++
        // This document may have failed on an earlier run; it just
        // succeeded, so any such record is no longer accurate (mirrors
        // `resolveFailure(db, 'summary_pdf', ...)` above).
        resolveFailure(db, 'document', String(docRef.id))
        opts.onDocumentProgress?.({ idProcessoTrf, idProcessoDoc: docRef.id, docKind: docRef.kind, outcome: 'stored' })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        recordFailure(db, 'document', String(docRef.id), message)
        failed++
        opts.onDocumentProgress?.({ idProcessoTrf, idProcessoDoc: docRef.id, docKind: docRef.kind, outcome: 'failed' })
      }
    }

    // The case itself may have failed on an earlier run — recorded under
    // `targetRef` if that failure happened before the id was even resolved,
    // or under the id otherwise (see the catch block below). Clear both:
    // whichever key an old failure used, this run's success makes it stale.
    resolveFailure(db, 'deep_case', targetRef)
    resolveFailure(db, 'deep_case', String(idProcessoTrf))

    return { kind: 'done', idProcessoTrf, number: record.number, documentsStored: stored, documentsSkipped: skipped, documentsFailed: failed }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const ref = idProcessoTrf !== undefined ? String(idProcessoTrf) : targetRef
    recordFailure(db, 'deep_case', ref, message)
    return { kind: 'failed', ref, error: message }
  }
}

export interface DeepRangeOptions extends DeepOptions {
  fromId: number
  toId: number
  concurrency?: number
  onCaseProgress?: (o: DeepCaseOutcome) => void
}

export interface DeepRangeSummary {
  casesDone: number
  casesFailed: number
  documentsStored: number
  documentsSkipped: number
  documentsFailed: number
}

/**
 * Runs `deepCase` over every id in `[fromId, toId]` with up to `concurrency`
 * workers in flight. Unlike `crawl`, the range here is always explicit —
 * there is no "stop after N misses" heuristic, since a deep run is
 * expensive per case and the caller is expected to already know which ids
 * are worth the cost.
 */
export async function deepRange(deps: DeepDeps, opts: DeepRangeOptions): Promise<DeepRangeSummary> {
  const concurrency = Math.max(1, opts.concurrency ?? 4)
  let nextId = opts.fromId
  const summary: DeepRangeSummary = { casesDone: 0, casesFailed: 0, documentsStored: 0, documentsSkipped: 0, documentsFailed: 0 }

  const takeId = (): number | null => (nextId <= opts.toId ? nextId++ : null)

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const id = takeId()
      if (id === null) return
      const outcome = await deepCase(deps, { kind: 'id', id }, { onDocumentProgress: opts.onDocumentProgress })
      if (outcome.kind === 'done') {
        summary.casesDone++
        summary.documentsStored += outcome.documentsStored
        summary.documentsSkipped += outcome.documentsSkipped
        summary.documentsFailed += outcome.documentsFailed
      } else {
        summary.casesFailed++
      }
      opts.onCaseProgress?.(outcome)
    }
  })
  await Promise.all(workers)

  return summary
}
