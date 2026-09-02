import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import {
  FsBlobStore,
  SearchQueryError,
  countCapturedSince,
  countJobsByStatus,
  enqueueJob,
  getAcervoCase,
  getAcervoTotals,
  getCaseById,
  getDocumentById,
  getDocumentsByCase,
  getMovementsByCase,
  getMovementsForCases,
  getPartiesByCase,
  listCasesPage,
  listFailures,
  listJobs,
  openDatabase,
  searchCases,
  type AcervoCaseRow,
  type Db,
  type Failure,
  type Job as StoredJob,
  type StoredDocument,
  type StoredMovement,
} from '@pje/core'
import type { WebDataConfig } from '../config.ts'
import type { DocumentFile, WebDataSource } from '../source.ts'
import type {
  ArchiveStats,
  ArchiveStatus,
  CaptureFailure,
  CaptureOverview,
  CaseDetail,
  CaseDocument,
  CasePage,
  CaseSummary,
  ChatMessage,
  ChatSource,
  Conversation,
  Coverage,
  EnqueueOutcome,
  Job,
  JobKind,
  JobState,
  Movement,
  Party,
  SearchHit,
  SearchResult,
} from '../types.ts'
import { declaredMovements, declaredParties } from './declared.ts'
import { explainFailure } from './failure-text.ts'
import { agoLabel, captureLabel, courtDate, courtTimestamp, startOfTodayStored } from './labels.ts'
import { describeTarget, parseTarget } from './jobs.ts'
import { HIGHLIGHT_END, HIGHLIGHT_START, toSegments } from './snippet.ts'

/**
 * The `WebDataSource` over the SQLite file the scraper writes.
 *
 * Two rules run through all of it.
 *
 * **Nothing here throws for an absent acervo.** The database is opened lazily
 * and, if it is not there, every method answers empty while `status()` says
 * why — a deployment pointed at the wrong path renders an explanation, not a
 * 500. It is also never *created*: `openDatabase` would happily make an empty
 * one, and an empty database at the wrong path looks exactly like a court with
 * no cases in it, so the file's existence is checked first.
 *
 * **A count the portal declared is never quietly rounded to what we hold.**
 * The declared totals are not columns — they survive only in the wording of
 * the `failures` rows the scraper files when a list comes back short (see
 * `./declared.ts`) — and reading them back is what keeps `10 de 41` from
 * rendering as `10`.
 */

/** How many jobs the queue screen shows, newest first. */
const JOB_WINDOW = 50

/** Hits the chat answer aggregates over before it starts summarising. */
const CHAT_SAMPLE = 50

/** Cases cited by number in a chat answer; the rest are counted. */
const CHAT_CITATIONS = 2

interface Connection {
  db: Db
  blobs: FsBlobStore
}

export function createSqliteDataSource(config: WebDataConfig): WebDataSource {
  let connection: Connection | null = null
  let openError: string | null = null

  /**
   * Opens once and keeps the handle: better-sqlite3 is synchronous and a
   * connection is cheap to hold, but not cheap to reopen per request. A failed
   * open is remembered too — retrying a corrupt file on every page render
   * would turn one bad path into a stall.
   */
  const connect = (): Connection | null => {
    if (connection !== null) return connection
    if (openError !== null) return null
    if (!existsSync(config.databasePath)) return null
    try {
      connection = {
        db: openDatabase(config.databasePath),
        blobs: new FsBlobStore(config.blobRoot),
      }
      return connection
    } catch (err) {
      openError = err instanceof Error ? err.message : String(err)
      return null
    }
  }

  const paths = { databasePath: config.databasePath, blobRoot: config.blobRoot }

  return {
    async status(): Promise<ArchiveStatus> {
      const conn = connect()
      if (conn === null) {
        if (openError !== null) return { kind: 'unreadable', ...paths, error: openError }
        return { kind: 'missing', ...paths }
      }
      const totals = getAcervoTotals(conn.db)
      if (totals.caseCount === 0) return { kind: 'empty', ...paths }
      return { kind: 'ready', ...paths }
    },

    async archiveStats(): Promise<ArchiveStats> {
      const conn = connect()
      if (conn === null) {
        return { caseCount: 0, documentCount: 0, coveragePct: 0, lastSyncLabel: 'nunca' }
      }
      const totals = getAcervoTotals(conn.db)
      return {
        caseCount: totals.caseCount,
        documentCount: totals.documentCount,
        coveragePct: coveragePct(totals.minCaseId, totals.maxCaseId, totals.caseCount + totals.probedIds),
        lastSyncLabel: agoLabel(totals.lastScrapedAt),
      }
    },

    async listCases(page: number, pageSize: number): Promise<CasePage> {
      const conn = connect()
      const size = Math.max(1, pageSize)
      if (conn === null) return { items: [], total: 0, page: 1, pageSize: size, pageCount: 1 }

      const total = getAcervoTotals(conn.db).caseCount
      const pageCount = Math.max(1, Math.ceil(total / size))
      const safePage = Math.min(Math.max(1, Number.isFinite(page) ? page : 1), pageCount)

      const rows = listCasesPage(conn.db, { limit: size, offset: (safePage - 1) * size })
      const declared = declaredTotals(conn.db)
      // One query for the whole page's movements: the listing needs the newest
      // one per case and would otherwise pay a round trip per row.
      const newest = newestPerCase(getMovementsForCases(conn.db, rows.map((r) => r.idProcessoTrf)))

      const items: CaseSummary[] = rows.map((row) => ({
        number: row.number,
        className: row.className,
        organ: row.court,
        parties: coverageFor(row.partyCount, declared.parties.get(row.idProcessoTrf)),
        documents: { captured: row.documentCount, declared: null },
        lastMovement: toMovement(newest.get(row.idProcessoTrf)),
      }))

      return { items, total, page: safePage, pageSize: size, pageCount }
    },

    async getCase(number: string): Promise<CaseDetail | null> {
      const conn = connect()
      if (conn === null) return null
      const row = getAcervoCase(conn.db, number)
      if (row === null) return null

      const parties = getPartiesByCase(conn.db, row.idProcessoTrf)
      const movements = getMovementsByCase(conn.db, row.idProcessoTrf)
      const documents = getDocumentsByCase(conn.db, row.idProcessoTrf)
      const failures = caseFailures(conn.db, row.idProcessoTrf, documents)

      const declaredFrom = (kind: string, read: (error: string) => number | null): number | null => {
        const failure = failures.find((f) => f.kind === kind)
        return failure === undefined ? null : read(failure.error)
      }

      return {
        number: row.number,
        className: row.className,
        classCode: row.classCode,
        organ: row.court,
        panel: row.panel,
        jurisdiction: row.jurisdiction,
        distributedAt: courtDate(row.distributedAt),
        referenceNumber: row.referenceNumber,
        parties: parties.map(toParty),
        // `position` is the portal's own ordering and it is newest-first;
        // sorting on the printed timestamps instead would shuffle the several
        // entries a court files within the same second.
        movements: movements.map(toMovement).filter((m): m is Movement => m !== null),
        documents: await Promise.all(documents.map((d) => toCaseDocument(conn.blobs, d))),
        documentsBytes: await totalBytes(conn.blobs, documents),
        capture: {
          documents: { captured: documents.length, declared: null },
          movements: coverageFor(movements.length, declaredFrom('movements', declaredMovements)),
          parties: coverageFor(parties.length, declaredFrom('parties', declaredParties)),
          lastCaptureAt: captureLabel(row.lastScrapedAt),
          // Nothing counts a case's HTTP requests today — see the report.
          requestCount: null,
          failures: failures.map(toCaptureFailure),
        },
      }
    },

    async search(query: string, page: number, pageSize: number): Promise<SearchResult> {
      const size = Math.max(1, pageSize)
      const asked = Number.isFinite(page) ? Math.max(1, page) : 1
      const empty = (error: string | null): SearchResult => ({
        query, ftsQuery: null, hits: [], total: 0,
        page: 1, pageSize: size, pageCount: 1, elapsedMs: 0, error,
      })

      const conn = connect()
      if (conn === null || query.trim() === '') return empty(null)

      const started = performance.now()
      try {
        const results = searchCases(conn.db, query, {
          limit: size,
          offset: (asked - 1) * size,
          highlightStart: HIGHLIGHT_START,
          highlightEnd: HIGHLIGHT_END,
        })
        const pageCount = Math.max(1, Math.ceil(results.total / size))
        return {
          query,
          ftsQuery: results.ftsQuery,
          hits: results.hits.map(toSearchHit),
          total: results.total,
          page: Math.min(asked, pageCount),
          pageSize: size,
          pageCount,
          elapsedMs: Math.round(performance.now() - started),
          error: null,
        }
      } catch (err) {
        if (err instanceof SearchQueryError) {
          return empty('La consulta no tiene ningún término que se pueda buscar.')
        }
        throw err
      }
    },

    async conversation(question: string | null): Promise<Conversation> {
      const conn = connect()
      const totals = conn === null
        ? { caseCount: 0, documentCount: 0 }
        : getAcervoTotals(conn.db)
      const scope = conn === null
        ? 'Sin acervo conectado'
        : `Sobre ${totals.caseCount} expedientes y ${totals.documentCount} documentos del TRF5`

      const asked = question?.trim() ?? ''
      if (conn === null || asked === '') {
        return { scope, messages: [openingMessage(totals.documentCount)], sources: [], sourceCount: 0 }
      }

      let results
      try {
        results = searchCases(conn.db, asked, {
          limit: CHAT_SAMPLE,
          highlightStart: HIGHLIGHT_START,
          highlightEnd: HIGHLIGHT_END,
        })
      } catch (err) {
        if (!(err instanceof SearchQueryError)) throw err
        return {
          scope,
          messages: [
            userMessage(asked),
            assistantMessage(['Esa pregunta no tiene ningún término que se pueda buscar en el texto del acervo.']),
          ],
          sources: [],
          sourceCount: 0,
        }
      }

      const hits = results.hits.map(toSearchHit)
      const citations = hits.slice(0, CHAT_CITATIONS).map((h) => abbreviate(h.number))
      const sources: ChatSource[] = hits.slice(0, 3).map((h) => ({
        number: h.number,
        className: h.className,
        fragment: h.snippet === null
          ? 'Coincide en los datos del proceso o en el nombre de una parte; ningún documento contiene el término.'
          : h.snippet.segments.map((s) => s.text).join(''),
      }))

      return {
        scope,
        messages: [userMessage(asked), assistantMessage(answerParagraphs(asked, results.total, hits), citations, Math.max(0, results.total - citations.length))],
        sources,
        sourceCount: results.total,
      }
    },

    async captureOverview(): Promise<CaptureOverview> {
      const conn = connect()
      if (conn === null) {
        return {
          runningJobs: 0, queuedJobs: 0, casesToday: 0, documentsToday: 0,
          openFailures: 0, updatedAgoLabel: 'nunca', jobs: [], failures: [],
        }
      }
      const counts = countJobsByStatus(conn.db)
      const total = counts.pending + counts.running + counts.done + counts.failed
      // `listJobs` orders by id ascending and takes no direction, so the last
      // window is read by offset and reversed here rather than by asking the
      // repository for something it does not offer.
      const jobs = listJobs(conn.db, { limit: JOB_WINDOW, offset: Math.max(0, total - JOB_WINDOW) })
      const today = countCapturedSince(conn.db, startOfTodayStored())
      const failures = listFailures(conn.db, { unresolvedOnly: true })

      return {
        runningJobs: counts.running,
        queuedJobs: counts.pending,
        casesToday: today.cases,
        documentsToday: today.documents,
        openFailures: failures.length,
        updatedAgoLabel: agoLabel(getAcervoTotals(conn.db).lastScrapedAt),
        jobs: jobs.reverse().map(toJob),
        failures: failures.map(toCaptureFailure),
      }
    },

    async enqueue(kind: JobKind, target: string): Promise<EnqueueOutcome> {
      const conn = connect()
      if (conn === null) {
        return { ok: false, error: `No hay ninguna base en ${config.databasePath}: no se puede encolar nada.` }
      }
      const parsed = parseTarget(kind, target)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      return { ok: true, job: toJob(enqueueJob(conn.db, kind, parsed.payload)) }
    },

    async openDocument(id: number): Promise<DocumentFile | null> {
      const conn = connect()
      if (conn === null || !Number.isInteger(id)) return null
      const doc = getDocumentById(conn.db, id)
      if (doc === null) return null
      const caseNumber = getCaseById(conn.db, doc.idProcessoTrf)?.number ?? String(doc.idProcessoTrf)

      if (doc.pdfKey !== null) {
        // Straight through `FsBlobStore`, whose key check is what stops a
        // stored key from ever addressing a file outside the PDF directory.
        // A row whose blob is gone (a half-deleted `data/`) reads as absent
        // rather than as a crash.
        try {
          const body = await conn.blobs.get(doc.pdfKey)
          return {
            filename: documentFilename(caseNumber, doc, 'pdf'),
            contentType: 'application/pdf',
            body,
          }
        } catch {
          return null
        }
      }
      if (doc.textContent !== null) {
        return {
          filename: documentFilename(caseNumber, doc, 'txt'),
          // The stored HTML document is the judicial act's extracted text, not
          // a page — see `extractActText`. Serving it as `text/html` would
          // render the tribunal's prose as broken markup.
          contentType: 'text/plain; charset=utf-8',
          body: doc.textContent,
        }
      }
      return null
    },

    async openCaseSummary(number: string): Promise<DocumentFile | null> {
      const conn = connect()
      if (conn === null) return null
      const row = getAcervoCase(conn.db, number)
      if (row === null) return null
      const key = getCaseById(conn.db, row.idProcessoTrf)?.summaryPdfKey ?? null
      if (key === null) return null
      try {
        return {
          filename: `${safeSegment(row.number)} - resumen del proceso.pdf`,
          contentType: 'application/pdf',
          body: await conn.blobs.get(key),
        }
      } catch {
        return null
      }
    },
  }
}

// ── Coverage ────────────────────────────────────────────────────────────────

const coverageFor = (captured: number, declared: number | null | undefined): Coverage => ({
  captured,
  declared: declared ?? null,
})

/**
 * Every declared total the acervo still knows about, keyed by case id.
 *
 * Read in one sweep over the open failures rather than per case: the listing
 * needs them for a whole page at once, and an acervo's unresolved failures are
 * a short list by construction — they are the things somebody still has to
 * deal with.
 */
function declaredTotals(db: Db): { parties: Map<number, number>; movements: Map<number, number> } {
  const parties = new Map<number, number>()
  const movements = new Map<number, number>()
  for (const failure of listFailures(db, { unresolvedOnly: true })) {
    const id = Number(failure.ref)
    if (!Number.isInteger(id)) continue
    if (failure.kind === 'parties') {
      const declared = declaredParties(failure.error)
      if (declared !== null) parties.set(id, declared)
    } else if (failure.kind === 'movements') {
      const declared = declaredMovements(failure.error)
      if (declared !== null) movements.set(id, declared)
    }
  }
  return { parties, movements }
}

/**
 * The open failures filed against one case: those keyed by the case's own id,
 * plus the per-document ones whose id belongs to a document of this case.
 *
 * A document that failed on its very first attempt has no `documents` row to
 * match against, so it cannot be attributed to a case here — it stays visible
 * on `/procesos`, where failures are listed by their own key. See the report.
 */
function caseFailures(db: Db, idProcessoTrf: number, documents: readonly StoredDocument[]): Failure[] {
  const ownDocuments = new Set(documents.map((d) => String(d.idProcessoDocumento)))
  const ref = String(idProcessoTrf)
  return listFailures(db, { unresolvedOnly: true }).filter((f) =>
    f.kind === 'document' ? ownDocuments.has(f.ref) : f.ref === ref)
}

/**
 * How much of the id space between the first and last case we hold has
 * actually been looked at — cases we captured plus ids we probed and found
 * nothing behind. Clamped, because probes can sit outside that span.
 */
function coveragePct(minId: number | null, maxId: number | null, known: number): number {
  if (minId === null || maxId === null) return 0
  const span = maxId - minId + 1
  if (span <= 0) return 0
  return Math.min(100, (known / span) * 100)
}

// ── Row → view ──────────────────────────────────────────────────────────────

const toParty = (p: ReturnType<typeof getPartiesByCase>[number]): Party => ({
  polo: p.polo,
  name: p.name,
  documentType: p.documentType,
  documentNumber: p.documentNumber,
  oab: p.oab,
  role: p.role,
})

const toMovement = (m: StoredMovement | undefined): Movement | null =>
  m === undefined ? null : { timestamp: courtTimestamp(m.timestamp), description: m.description }

/** Position 0 is the portal's own newest-first ordering. */
function newestPerCase(movements: readonly StoredMovement[]): Map<number, StoredMovement> {
  const out = new Map<number, StoredMovement>()
  for (const m of movements) {
    const current = out.get(m.idProcessoTrf)
    if (current === undefined || m.position < current.position) out.set(m.idProcessoTrf, m)
  }
  return out
}

async function toCaseDocument(blobs: FsBlobStore, d: StoredDocument): Promise<CaseDocument> {
  return {
    id: d.idProcessoDocumento,
    // `label` is the portal's whole link text — `22/05/2026 08:25:14 -
    // Decisão (Decisão)` — with the date already in its own column. `docType`
    // is the same row's clean name, which is what the design shows.
    label: d.docType ?? d.label,
    docDate: courtDate(d.docDate),
    format: d.pdfKey !== null ? 'PDF' : 'HTML',
    sizeBytes: await documentBytes(blobs, d),
  }
}

async function documentBytes(blobs: FsBlobStore, d: StoredDocument): Promise<number | null> {
  if (d.pdfKey !== null) return blobs.size(d.pdfKey)
  return d.textContent === null ? null : Buffer.byteLength(d.textContent, 'utf8')
}

async function totalBytes(blobs: FsBlobStore, documents: readonly StoredDocument[]): Promise<number | null> {
  const sizes = await Promise.all(documents.map((d) => documentBytes(blobs, d)))
  const known = sizes.filter((n): n is number => n !== null)
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0)
}

const JOB_STATE: Record<StoredJob['status'], JobState> = {
  pending: 'queued',
  running: 'running',
  done: 'done',
  failed: 'failed',
}

const toJob = (j: StoredJob): Job => ({
  id: j.id,
  kind: j.type,
  target: describeTarget(j.payload),
  state: JOB_STATE[j.status],
  attempts: j.attempts,
  createdAt: j.createdAt,
  startedAt: j.startedAt,
  finishedAt: j.finishedAt,
  error: j.error,
  progress: j.progress,
  stage: j.stage,
})

const toCaptureFailure = (f: Failure): CaptureFailure => ({
  kind: f.kind,
  ref: f.ref,
  error: explainFailure(f.kind, f.error) ?? f.error,
  raw: f.error,
  attempts: f.attempts,
  lastAttemptAt: captureLabel(f.lastAttemptAt),
})

const toSearchHit = (h: ReturnType<typeof searchCases>['hits'][number]): SearchHit => ({
  number: h.number,
  className: h.className,
  organ: h.court,
  distributedAt: courtDate(h.distributedAt),
  matchedIn: h.matchedIn,
  snippet: h.snippet === null ? null : {
    label: h.snippet.label,
    documentId: h.snippet.idProcessoDocumento,
    segments: toSegments(h.snippet.text),
  },
})

// ── Chat ────────────────────────────────────────────────────────────────────

const userMessage = (text: string): ChatMessage =>
  ({ role: 'user', paragraphs: [text], citations: [], extraCitations: 0 })

const assistantMessage = (paragraphs: string[], citations: string[] = [], extra = 0): ChatMessage =>
  ({ role: 'assistant', paragraphs, citations, extraCitations: extra })

const openingMessage = (documentCount: number): ChatMessage =>
  assistantMessage([
    `Escribe una pregunta y buscaré los términos que la componen en el texto de los ${documentCount} documentos capturados, en los nombres de las partes y en los datos de cada proceso.`,
    'No hay ningún modelo de lenguaje detrás de esta pantalla: lo que responde es el índice de texto completo del acervo, y cada cifra de la respuesta es un recuento sobre las filas que coinciden.',
  ])

/** `0801438-34.2016.4.05.8102` → `0801438-34.2016`, as the design cites cases. */
const abbreviate = (number: string): string => number.split('.').slice(0, 2).join('.')

/**
 * The answer, built only out of things that were counted.
 *
 * Every sentence is an aggregate over rows that matched — how many cases, how
 * the classes and the judging organs divide, which of them the term was
 * actually found in. Nothing is generated or inferred, and the last paragraph
 * says so, because a chat window is exactly where a reader would assume
 * otherwise.
 */
function answerParagraphs(question: string, total: number, hits: readonly SearchHit[]): string[] {
  if (total === 0) {
    return [
      `Ningún expediente del acervo coincide con «${question}».`,
      'La búsqueda cubre el número y la clase del proceso, el órgano, los nombres de las partes y el texto completo de cada documento capturado. Si el expediente no se ha capturado todavía, no está aquí: encólalo desde Procesos.',
    ]
  }

  const shown = hits.length
  const classes = topOf(hits.map((h) => h.className))
  const organs = topOf(hits.map((h) => h.organ ?? '—'))
  const inDocuments = hits.filter((h) => h.matchedIn.includes('document')).length
  const inParties = hits.filter((h) => h.matchedIn.includes('party')).length

  const sample = total > shown
    ? `Sobre los ${shown} mejor puntuados`
    : `Sobre los ${shown}`

  return [
    `${total} ${total === 1 ? 'expediente coincide' : 'expedientes coinciden'} con «${question}».`,
    `${sample}: la clase más frecuente es ${classes} y el órgano con más coincidencias es ${organs}. ` +
      `En ${inDocuments} el término aparece dentro del texto de un documento; en ${inParties}, en el nombre de una parte.`,
    'Esto es el índice de texto completo del acervo, no una respuesta generada: cada cifra de arriba es un recuento sobre las filas que coinciden, y los fragmentos de la derecha son el texto tal cual quedó capturado.',
  ]
}

/** The most frequent value, with its count: `REMESSA NECESSÁRIA CÍVEL (7)`. */
function topOf(values: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best = '—'
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) { best = value; bestCount = count }
  }
  return `${best} (${bestCount})`
}

// ── Filenames ───────────────────────────────────────────────────────────────

/**
 * `0800120-05.2024.4.05.8306 - Despacho - 09-04-2024.pdf`: the case, the act
 * and its date, which is what makes a file recognisable in a downloads folder
 * a week later. Every path separator and control character is stripped, so a
 * label out of the portal can never shape the name of a file on disk.
 */
export function documentFilename(caseNumber: string, d: StoredDocument, extension: string): string {
  const parts = [caseNumber, d.docType ?? d.label, (courtDate(d.docDate) ?? '').replaceAll('/', '-')]
  const name = parts.map(safeSegment).filter((p) => p !== '').join(' - ')
  return `${name === '' ? basename(String(d.idProcessoDocumento)) : name}.${extension}`
}

const safeSegment = (raw: string): string =>
  raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
