import {
  upsertCase, getCaseById, getCaseByNumber, recordFailure, resolveFailure,
  isDocumentDownloaded, upsertDocument, replacePartiesForCase, replaceMovementsForCase, recordProbe,
  type Db, type BlobStore, type StoredCase, type PartyInput, type MovementInput,
} from '@pje/core'
import { HttpClient } from '../http/client.ts'
import { CookieJar } from '../http/cookie-jar.ts'
import { fetchReportPdf } from '../pje/report.ts'
import { startSession } from '../pje/session.ts'
import { search, ActionNotExecutedError } from '../pje/search.ts'
import { fetchAllMovements } from '../pje/movement-pages.ts'
import { fetchDetail, type DocumentRef, type BinaryDocumentRef, type HtmlDocumentRef, type DetailResult, type ProcessFields } from '../pje/detail.ts'
import { downloadDocument } from '../pje/download.ts'
import { parseCaseRecord, parseMovements, extractPdfText, isUnnumberedSummary, type CaseRecord } from '../pdf/parse.ts'
import { pdfKeyFor } from './enumerate.ts'

/** The `'valid'` arm of `DetailResult` — pulled out once so the truncation helpers below don't repeat the union narrowing. */
type ValidDetail = Extract<DetailResult, { kind: 'valid' }>

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

/**
 * Narrates the per-case chain: every slow step is announced as it *starts*
 * (`summary_pdf`, `detail_key`, `case_file`, `documents`), and the ones
 * whose result is worth saying out loud answer with their own `_ok` event.
 * Retries get their own events too — the search bridge fails on roughly one
 * run in four and silently retries, which used to look like a stall.
 *
 * Every event carries `ref` (the target as the caller named it: an id for a
 * range, a case number for a single target) so a caller running several
 * cases at once can attribute each line to the case that produced it.
 */
export type DeepStepEvent =
  | { kind: 'summary_pdf'; ref: string }
  | { kind: 'summary_pdf_retry'; ref: string; attempt: number; of: number; status: number }
  | { kind: 'summary_pdf_ok'; ref: string; idProcessoTrf: number; number: string; className: string | null }
  | { kind: 'detail_key'; ref: string; source: 'cached' | 'search' | 'stale' }
  | { kind: 'detail_key_retry'; ref: string; attempt: number; of: number; reason: string }
  | { kind: 'case_file'; ref: string }
  | { kind: 'case_file_ok'; ref: string; documentCount: number }
  | { kind: 'documents'; ref: string; total: number; alreadyOnDisk: number }
  | { kind: 'movements_page'; ref: string; page: number; of: number }

export interface DeepOptions {
  onDocumentProgress?: (p: DeepDocumentProgress) => void
  onStep?: (e: DeepStepEvent) => void
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
  /**
   * The portal answered, and there is no case to capture. Distinct from
   * `failed` because nothing here is worth retrying: the summary names no
   * case, so there is no key to store one under and no request that would
   * produce one.
   */
  | { kind: 'absent'; ref: string; reason: string }

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
 *
 * One scheme for both kinds of document: a judicial act now arrives with a
 * PDF of its own (see `downloadActPdf`), and there is no reason for it to
 * land anywhere else on disk than the binaries it sits beside in the case
 * file. The ids can't collide either — both are `idProcessoDocumento`,
 * unique within the case.
 */
export function documentPdfKeyFor(caseNumber: string, ref: BinaryDocumentRef | HtmlDocumentRef): string {
  const year = caseNumber.split('.')[1] ?? 'unknown'
  const date = ref.date ?? 'unknown-date'
  const type = ref.type ?? 'documento'
  const base = sanitizeFilename(`${date}-${type}-${ref.id}`)
  return `${year}/${caseNumber}/documents/${base}.pdf`
}

/**
 * `processFields` is only ever known once the detail page has been fetched
 * — omitted (or absent from the response), the three fields it carries
 * (`jurisdiction`, `courtAddress`, `referenceNumber`) go in as `null`, and
 * `upsertCase`'s own COALESCE-on-conflict treatment of them (see
 * `cases.ts`) is what stops that from blanking out a value a previous run
 * already captured.
 */
function caseUpsertFromRecord(
  idProcessoTrf: number, record: CaseRecord, ca: string | null, summaryPdfKey: string,
  processFields: ProcessFields | null = null,
): StoredCase {
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
    // enumerate.ts) until a party parser is built; out of scope here. The
    // richer, per-polo parties this module now parses live in their own
    // `parties` table (see `replacePartiesForCase` below), not this column.
    parties: [],
    summaryPdfKey,
    jurisdiction: processFields?.jurisdiction ?? null,
    courtAddress: processFields?.courtAddress ?? null,
    referenceNumber: processFields?.referenceNumber ?? null,
  }
}

function countByPolo(parties: readonly PartyInput[], polo: PartyInput['polo']): number {
  return parties.filter((p) => p.polo === polo).length
}

/**
 * True when the detail page's own stated total for either polo disagrees
 * with how many party rows were actually parsed — the signal that the
 * Richfaces.Datascroller (never driven here — a separate problem) is hiding
 * a further page of participants. A `null` total (the polo's table itself
 * wasn't found) is not evidence of truncation on its own.
 */
function partiesTruncated(detail: ValidDetail): boolean {
  const ativo = countByPolo(detail.parties, 'ativo')
  const passivo = countByPolo(detail.parties, 'passivo')
  return (
    (detail.partiesAtivoTotal !== null && ativo !== detail.partiesAtivoTotal) ||
    (detail.partiesPassivoTotal !== null && passivo !== detail.partiesPassivoTotal)
  )
}

/**
 * Stores a case's parties (from the detail page — see `parseParties`), and
 * records — loudly, in `failures`, never silently — whenever either polo
 * came back shorter than the page's own stated total (see
 * `partiesTruncated`).
 *
 * A `failures` row was chosen over a boolean flag on the case itself: it
 * reuses infrastructure this codebase already has for "something needs a
 * retry or a human's attention" (visible via `listFailures`, cleared via
 * `resolveFailure` exactly like every other failure kind here), whereas a
 * new `cases` column would need its own migration, its own query surface,
 * and would still leave the *reason* — which polo, how many rows short —
 * needing to live somewhere; `failures.error` already has room for that.
 * The case itself is NOT marked failed: a truncated party list is a real,
 * if incomplete, result, and the rest of the case (documents, the other
 * polo) is still worth keeping — unlike a `deep_case` failure, this must
 * never make the caller skip storing what it does have.
 */
function storeParties(db: Db, idProcessoTrf: number, detail: ValidDetail): void {
  replacePartiesForCase(db, idProcessoTrf, detail.parties)
  if (partiesTruncated(detail)) {
    const ativo = countByPolo(detail.parties, 'ativo')
    const passivo = countByPolo(detail.parties, 'passivo')
    recordFailure(
      db, 'parties', String(idProcessoTrf),
      `Parsed ${ativo} ativo / ${passivo} passivo parties but the page states ` +
      `${detail.partiesAtivoTotal ?? '?'} / ${detail.partiesPassivoTotal ?? '?'} — ` +
      'the Datascroller is hiding a further page, never followed by this scraper.',
      idProcessoTrf,
    )
  } else {
    resolveFailure(db, 'parties', String(idProcessoTrf))
  }
}

/**
 * Cross-checks the movements already parsed from the summary PDF (see
 * `pdf/parse.ts`'s `parseMovements` for why the PDF, not the HTML, is the
 * source of the rows themselves) against the *detail page's own* stated
 * total for the same table (`detail.movementsTotal`). The two sources
 * normally agree (verified live: PDF count 39 vs HTML-stated 39 for
 * 0800245-51.2020.4.05.8002); a disagreement means "the PDF is complete"
 * has stopped holding for this case, which is exactly the kind of silent
 * data loss `failures` exists to surface instead of swallow. Only `deep`
 * can run this check — `crawl` never fetches the detail page — so a case
 * scraped only by `crawl` has movements stored with no cross-check done.
 */
function checkMovementsTruncation(db: Db, idProcessoTrf: number, movements: readonly MovementInput[], detail: ValidDetail): void {
  if (detail.movementsTotal !== null && movements.length !== detail.movementsTotal) {
    recordFailure(
      db, 'movements', String(idProcessoTrf),
      `Parsed ${movements.length} movements from the summary PDF but the detail page states ` +
      `${detail.movementsTotal} — the "PDF has the complete log" assumption may have broken for this case.`,
      idProcessoTrf,
    )
  } else {
    resolveFailure(db, 'movements', String(idProcessoTrf))
  }
}

/**
 * Bounds how many search-bridge sequences (session GET + search POST) run
 * at once against the *original*, run-wide `HttpClient` — independent of
 * the per-case cookie isolation below, this just keeps the bridge itself
 * polite under a high `--concurrency`, the same way a single `HttpClient`
 * chokepoint keeps the rest of the run polite.
 *
 * This pairs with `startSession` clearing its jar before every GET (see
 * `session.ts`): once a session is allowed to start from a clean jar, two
 * workers doing that *concurrently* on jars they otherwise share would
 * clobber each other's freshly-planted cookie mid-sequence — the exact
 * cross-case corruption `deepCase`'s per-case `caseClient` isolation exists
 * to prevent, reintroduced at the sub-case level if the bridge weren't also
 * serialized here. The jar-clearing fix makes starting clean *safe*; this
 * queue is what makes starting clean *exclusive*, so no two starts race.
 */
const searchBridgeQueue = new WeakMap<HttpClient, Promise<unknown>>()

async function runExclusive<T>(lockOn: HttpClient, fn: () => Promise<T>): Promise<T> {
  const prior = searchBridgeQueue.get(lockOn) ?? Promise.resolve()
  const result = prior.then(fn, fn)
  searchBridgeQueue.set(lockOn, result.then(() => undefined, () => undefined))
  return result
}

/**
 * Extra attempts against a bridge sequence that fails with
 * `ActionNotExecutedError` — verified live, reproducible even at
 * `--concurrency 1` (so not a client-side race) and against a case whose
 * search succeeds instantly run alone: a real, if intermittent, portal
 * hiccup, not a submit-parameter bug, since a *fresh* session (a brand-new
 * GET, not a retried POST against the old one) is what clears it. Each
 * retry re-runs `startSession` too, for exactly that reason. Mirrors the
 * `TRANSIENT_RETRIES` pattern already established in `report.ts` for the
 * same class of problem on the summary PDF endpoint.
 */
const SEARCH_BRIDGE_RETRIES = 3
const SEARCH_BRIDGE_RETRY_DELAY_MS = 500

/**
 * Runs the search bridge for one case number, returning its id and a fresh
 * `ca`. `lockClient` is only an identity to queue behind (see
 * `runExclusive`); `execClient` is the one the actual requests run on —
 * always a case-isolated client (see `deepCase`'s `caseClient`), never the
 * shared run-wide one, so this sequence's session cookie can't be
 * overwritten by a concurrent, unrelated request for a different case.
 */
async function searchForCa(
  lockClient: HttpClient, execClient: HttpClient, number: string,
  onRetry?: (r: { attempt: number; of: number; reason: string }) => void,
): Promise<{ idProcessoTrf: number; ca: string }> {
  return runExclusive(lockClient, async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const session = await startSession(execClient)
        const outcome = await search(execClient, session, { number })
        const row = outcome.rows.find((r) => r.number === number)
        if (!row) throw new CaseNotFoundError(number)
        return { idProcessoTrf: row.idProcessoTrf, ca: row.ca }
      } catch (err) {
        if (!(err instanceof ActionNotExecutedError) || attempt >= SEARCH_BRIDGE_RETRIES) throw err
        // Only the first sentence: the rest of the message is advice for a
        // developer reading a failure, not for someone watching a run.
        onRetry?.({ attempt: attempt + 1, of: SEARCH_BRIDGE_RETRIES + 1, reason: err.message.split('. ')[0]! })
        await execClient.sleep(SEARCH_BRIDGE_RETRY_DELAY_MS)
      }
    }
  })
}

/**
 * Resolves a target to an id and whatever `ca` is already on file for it (a
 * cache, not a fact — see `fetchDetail`). `bridged` says whether that `ca`
 * came from the search bridge just now rather than from storage, so the
 * caller does not narrate "reusing the cached ca" about a `ca` it has this
 * second gone and fetched.
 */
async function resolveTarget(
  deps: DeepDeps, execClient: HttpClient, target: DeepTarget, ref: string, onStep?: (e: DeepStepEvent) => void,
): Promise<{ idProcessoTrf: number; ca: string | null; bridged: boolean }> {
  if (target.kind === 'id') {
    const stored = getCaseById(deps.db, target.id)
    return { idProcessoTrf: target.id, ca: stored?.ca ?? null, bridged: false }
  }
  const stored = getCaseByNumber(deps.db, target.number)
  if (stored) return { idProcessoTrf: stored.idProcessoTrf, ca: stored.ca, bridged: false }
  onStep?.({ kind: 'detail_key', ref, source: 'search' })
  const bridged = await searchForCa(
    deps.client, execClient, target.number,
    (r) => onStep?.({ kind: 'detail_key_retry', ref, ...r }),
  )
  return { ...bridged, bridged: true }
}

/**
 * Downloads and stores one document, and answers with what could NOT be
 * captured — a message for the failures table — or `null` when everything
 * was.
 *
 * Both kinds get a row plus a blob, written in that order — matching the
 * ordering decision already made for the summary PDF in `enumerate.ts` —
 * so a failed blob write can never leave a PDF on disk with no row
 * pointing at it. A judicial act's row additionally keeps the act's text in
 * `text_content` (small, and what the full-text index is built from);
 * that text is stored whatever happens to its PDF, which is why an act
 * whose PDF is missing returns a message here instead of throwing. A page
 * that offers no PDF at all is not a failure and returns `null` — see
 * `ActPdfResult`.
 *
 * A `MalformedDocumentRef` (see `detail.ts`) is never fetched at all — it
 * throws immediately, with the raw trigger text for diagnosis, so the
 * caller's per-document catch records it as a failure exactly like a
 * download that failed over the wire. One row the parser couldn't make
 * sense of must not cost every other document on the page.
 *
 * Otherwise throws on `absent`/`transient` so the caller's per-document
 * catch handles every failure mode uniformly.
 */
async function downloadOneDocument(
  deps: DeepDeps, execClient: HttpClient, idProcessoTrf: number, caseNumber: string, ref: DocumentRef,
): Promise<string | null> {
  if (ref.kind === 'malformed') {
    throw new Error(`Unrecognised document link, never fetched: ${ref.raw}`)
  }

  const result = await downloadDocument(execClient, ref)

  if (result.kind === 'absent') {
    throw new Error(`Document ${ref.id} came back as a recognised error page: ${result.finalUrl}`)
  }
  if (result.kind === 'transient') {
    throw new Error(`Document ${ref.id} failed with a transient HTTP ${result.status} from ${result.finalUrl}`)
  }

  if (ref.kind === 'binary' && result.kind === 'pdf') {
    const key = documentPdfKeyFor(caseNumber, ref)
    // Reuses the same stream-walking extractor `parseCaseRecord` runs on the
    // summary PDF (see `pdf/parse.ts`) — a binary document's text otherwise
    // lives only inside a PDF on disk, invisible to anything indexing this
    // column later. `result.pdf` already passed the `%PDF-` magic check
    // inside `fetchClassifiedPdf`, so `extractPdfText` here can't throw for
    // that reason; it's still wrapped, because a page whose only text lives
    // in a stream this scanner can't inflate (a non-Flate filter — see
    // `streams.ts`) must degrade to a null `text_content`, not fail the
    // whole document over a PDF that downloaded and stored just fine.
    let textContent: string | null
    try {
      textContent = extractPdfText(result.pdf)
    } catch {
      textContent = null
    }
    upsertDocument(deps.db, {
      idProcessoDocumento: ref.id,
      idProcessoTrf,
      idBin: ref.idBin,
      numeroDocumento: ref.numeroDocumento,
      label: ref.label,
      docType: ref.type,
      docDate: ref.date,
      pdfKey: key,
      textContent,
    })
    await deps.blobs.put(key, result.pdf)
    return null
  }
  if (ref.kind === 'html' && result.kind === 'html') {
    const key = result.pdf.kind === 'pdf' ? documentPdfKeyFor(caseNumber, ref) : null
    upsertDocument(deps.db, {
      idProcessoDocumento: ref.id,
      idProcessoTrf,
      idBin: null,
      numeroDocumento: null,
      label: ref.label,
      docType: ref.type,
      docDate: ref.date,
      pdfKey: key,
      textContent: result.text,
    })
    if (result.pdf.kind === 'pdf') await deps.blobs.put(key!, result.pdf.pdf)
    return result.pdf.kind === 'failed'
      ? `Document ${ref.id} was stored with its text, but ${result.pdf.reason}`
      : null
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
 *
 * Every request this case makes runs on `caseClient`: `deps.client` with an
 * independent, freshly-created cookie jar (`HttpClient.withJar`), sharing
 * the run-wide pacing/backoff so the aggregate rate limit still holds.
 * Found live: without this, a concurrent, unrelated request for a
 * *different* case sharing the same jar could overwrite this case's session
 * cookie mid-sequence (between the search bridge's session GET and its
 * search POST, or between fetching the detail page and its session-bound
 * HTML documents), and the failure it caused looked nothing like a
 * cookie problem — a search POST reported as "the action did not execute"
 * with no other clue. Isolating the jar per case removes the possibility
 * entirely rather than just narrowing the window.
 */
export async function deepCase(deps: DeepDeps, target: DeepTarget, opts: DeepOptions = {}): Promise<DeepCaseOutcome> {
  const { db, blobs } = deps
  const caseClient = deps.client.withJar(new CookieJar())
  const targetRef = target.kind === 'id' ? String(target.id) : target.number
  let idProcessoTrf: number | undefined

  try {
    const resolved = await resolveTarget(deps, caseClient, target, targetRef, opts.onStep)
    idProcessoTrf = resolved.idProcessoTrf
    let ca = resolved.ca

    opts.onStep?.({ kind: 'summary_pdf', ref: targetRef })
    const report = await fetchReportPdf(caseClient, idProcessoTrf, {
      onRetry: (r) => opts.onStep?.({ kind: 'summary_pdf_retry', ref: targetRef, attempt: r.attempt, of: r.of, status: r.status }),
    })
    if (report.kind !== 'pdf') {
      throw new Error(
        report.kind === 'absent'
          ? `No summary PDF for id ${idProcessoTrf} (unassigned or sealed).`
          : `Transient HTTP ${report.status} fetching the summary PDF for id ${idProcessoTrf}.`,
      )
    }
    if (isUnnumberedSummary(report.pdf)) {
      // The portal answered with a real summary that names no case: the
      // class, the subjects and both poles' parties are all there, the
      // number is not. There is nothing to key a case on and nothing a
      // retry would change, so this is a probe and an absence rather than
      // the failure this used to record — and then retry, up to seven times
      // per id, against a page that answers the same way every time.
      recordProbe(db, idProcessoTrf, 'unnumbered')
      resolveFailure(db, 'summary_pdf', String(idProcessoTrf))
      resolveFailure(db, 'deep_case', targetRef)
      return {
        kind: 'absent',
        ref: targetRef,
        reason: `the portal's summary for id ${idProcessoTrf} names no case — `
          + 'not distributed yet, or its numbering is withheld',
      }
    }
    const record = parseCaseRecord(report.pdf)
    opts.onStep?.({ kind: 'summary_pdf_ok', ref: targetRef, idProcessoTrf, number: record.number, className: record.className })
    const summaryKey = pdfKeyFor(record)
    // Row before blob — see `downloadOneDocument`'s comment; same reasoning
    // applies to the summary PDF (and is already established in enumerate.ts).
    upsertCase(db, caseUpsertFromRecord(idProcessoTrf, record, ca, summaryKey))
    await blobs.put(summaryKey, report.pdf)
    resolveFailure(db, 'summary_pdf', String(idProcessoTrf))

    // From the PDF, not the detail page's own movements table — see
    // `parseMovements`'s doc comment for why. Stored now, independent of
    // whatever happens below with the detail page/search bridge, exactly
    // like `crawl` does (see `enumerate.ts`): a case whose detail page never
    // resolves should still keep the procedural log its summary PDF already
    // gave up for free.
    let movements = parseMovements(report.pdf)
    replaceMovementsForCase(db, idProcessoTrf, movements, 'pdf')

    let detail: DetailResult | null = null
    if (ca) {
      if (!resolved.bridged) opts.onStep?.({ kind: 'detail_key', ref: targetRef, source: 'cached' })
      opts.onStep?.({ kind: 'case_file', ref: targetRef })
      detail = await fetchDetail(caseClient, ca)
    }
    if (!detail || detail.kind !== 'valid') {
      // `ca` is absent or the detail page said it's stale: re-derive it
      // through the search bridge and update the stored value.
      opts.onStep?.({ kind: 'detail_key', ref: targetRef, source: ca ? 'stale' : 'search' })
      const bridged = await searchForCa(
        deps.client, caseClient, record.number,
        (r) => opts.onStep?.({ kind: 'detail_key_retry', ref: targetRef, ...r }),
      )
      ca = bridged.ca
      opts.onStep?.({ kind: 'case_file', ref: targetRef })
      detail = await fetchDetail(caseClient, ca)
      if (detail.kind !== 'valid') {
        throw new Error(`Detail page for case ${record.number} is still invalid right after refreshing ca.`)
      }
    }
    opts.onStep?.({ kind: 'case_file_ok', ref: targetRef, documentCount: detail.documents.length })
    // Only known once the detail page is in hand, whichever branch above got
    // it — `jurisdiction`/`courtAddress`/`referenceNumber` (from
    // `processFields`) and the parties table both live there, not in the
    // summary PDF. Upserting again here (idempotent — see `cases.ts`'s
    // ON CONFLICT) is what fills them in even when `ca` was already valid
    // and the first upsert above ran with none of this yet known.
    upsertCase(db, caseUpsertFromRecord(idProcessoTrf, record, ca, summaryKey, detail.processFields))
    storeParties(db, idProcessoTrf, detail)

    // The movements, now from where they are actually published. One extra
    // request per page of fifteen beyond the first, and none at all for a
    // case whose log already fits on one. The PDF's version stays as the
    // fallback for a case whose detail page never resolved at all.
    const fromTable = ca === null
      ? null
      : await fetchAllMovements(
          caseClient, ca, detail.html, detail.movementsTotal,
          (page, of) => opts.onStep?.({ kind: 'movements_page', ref: targetRef, page, of }),
        )
    if (fromTable !== null) {
      // Positioned by where they sit in the table, which is the only stable
      // key these rows have — the portal gives them no id of their own.
      movements = fromTable.map((row, position) => ({
        position,
        timestamp: row.timestamp,
        description: row.description,
      }))
      replaceMovementsForCase(db, idProcessoTrf, movements, 'table')
    }
    checkMovementsTruncation(db, idProcessoTrf, movements, detail)

    let stored = 0
    let skipped = 0
    let failed = 0
    // Partitioned before the first download rather than discovered one
    // document at a time, so the run can say up front how much work is
    // actually left — "4 already on disk, nothing to fetch" is a different
    // thing to watch than four downloads about to happen.
    const onDisk: DocumentRef[] = []
    const pending: DocumentRef[] = []
    for (const docRef of detail.documents) {
      (isDocumentDownloaded(db, docRef.id) ? onDisk : pending).push(docRef)
    }
    opts.onStep?.({ kind: 'documents', ref: targetRef, total: detail.documents.length, alreadyOnDisk: onDisk.length })

    for (const docRef of onDisk) {
      skipped++
      opts.onDocumentProgress?.({ idProcessoTrf, idProcessoDoc: docRef.id, docKind: docRef.kind, outcome: 'skipped' })
    }
    for (const docRef of pending) {
      try {
        const partial = await downloadOneDocument(deps, caseClient, idProcessoTrf, record.number, docRef)
        stored++
        if (partial !== null) {
          // The document itself is stored — a judicial act keeps its text
          // whatever happens to its PDF — so it counts as stored, not
          // failed. What is missing goes in `failures` all the same, under
          // the same kind and ref as an outright download failure, rather
          // than being quietly dropped because most of the row made it.
          recordFailure(db, 'document', String(docRef.id), partial, idProcessoTrf)
        } else {
          // This document may have failed on an earlier run; it just
          // succeeded, so any such record is no longer accurate (mirrors
          // `resolveFailure(db, 'summary_pdf', ...)` above).
          resolveFailure(db, 'document', String(docRef.id))
        }
        opts.onDocumentProgress?.({ idProcessoTrf, idProcessoDoc: docRef.id, docKind: docRef.kind, outcome: 'stored' })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        recordFailure(db, 'document', String(docRef.id), message, idProcessoTrf)
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
      const outcome = await deepCase(deps, { kind: 'id', id }, { onDocumentProgress: opts.onDocumentProgress, onStep: opts.onStep })
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
