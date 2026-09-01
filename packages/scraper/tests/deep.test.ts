import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  openDatabase, FsBlobStore, upsertCase, getCaseById, getDocumentsByCase, listFailures, recordFailure,
  getPartiesByCase, getMovementsByCase,
} from '@pje/core'
import { HttpClient } from '../src/http/client.ts'
import { deepCase, deepRange, sanitizeFilename, documentPdfKeyFor, type DeepStepEvent } from '../src/crawl/deep.ts'
import type { BinaryDocumentRef } from '../src/pje/detail.ts'

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))

const realSummaryPdf = fixture('case-130100.pdf') // parses to '0013475-36.2026.4.05.0000'
const REAL_NUMBER = '0013475-36.2026.4.05.0000'
const detailWithDocs = fixture('detail-with-docs.html') // 9 binary + 1 html doc
const detailHtmlOnly = fixture('detail-html-docs-only.html') // 0 binary + 2 html doc
// `detailHtmlOnly` and `realSummaryPdf` are live captures of two different,
// unrelated real cases, glued together purely for document-shape tests —
// nothing about them agrees, including the movements count `checkMovementsTruncation`
// now cross-checks between the two (see `deep.ts`). Patching just that one
// stated total (7 -> the 10 movements `realSummaryPdf`'s own PDF actually
// contains — verified in `pdf-parse.test.ts`) keeps that check quiet for
// tests that pair the two and assert on failures, without touching anything
// else `detailHtmlOnly` is used for elsewhere in this file.
const detailHtmlOnlyMatchingMovements = Buffer.from(
  detailHtmlOnly.toString('latin1').replace('7 resultados encontrados', '10 resultados encontrados'),
  'latin1',
)
const detailInvalidCa = fixture('detail-invalid-ca.html')
const listViewSession = fixture('list-view.html') // action=..., submitParam=fPP:j_id244
const samplePdf = fixture('sample-document.pdf')
const errorHtml = fixture('error-seam.html')

const VALID_CA = 'ca'.repeat(24)
const STALE_CA = 'aa'.repeat(24)
const BRIDGED_CA = 'bb'.repeat(24)

/** Minimal well-formed search AJAX response `parseSearchResponse` accepts, for one row. */
function searchXmlFor(idProcessoTrf: number, number: string, ca: string): Buffer {
  const xml =
    `<partial-response><meta name="Ajax-Update-Ids" content="fPP:processosGridPanel" />` +
    `<div id="fPP:processosTable:${idProcessoTrf}:j_id1">${number}` +
    `<a href="listView.seam?ca=${ca}">detail</a></div></partial-response>`
  return Buffer.from(xml, 'latin1')
}

interface Spec { body: Buffer; status?: number; url?: string; headers?: Record<string, string> }
type MaybePromise<T> = T | Promise<T>
interface PortalScript {
  summaryPdf?: (id: number) => MaybePromise<Spec>
  detail?: (ca: string) => MaybePromise<Spec>
  searchSession?: (cookieSent: string | null) => MaybePromise<Spec>
  searchAction?: (body: string) => MaybePromise<Spec>
  binaryDoc?: (idBin: number) => MaybePromise<Spec>
  htmlDoc?: (ca: string, idProcessoDoc: number) => MaybePromise<Spec>
}

function fakePortal(script: PortalScript, requestLog: string[] = []): HttpClient {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    requestLog.push(`${init?.method ?? 'GET'} ${u.pathname}${u.search}`)

    let spec: Spec
    if (u.pathname.endsWith('/reportPDF.seam')) {
      spec = await script.summaryPdf!(Number(u.searchParams.get('idProcessoTrf')))
    } else if (u.pathname.endsWith('/documentoSemLoginHTML.seam')) {
      spec = await script.htmlDoc!(u.searchParams.get('ca')!, Number(u.searchParams.get('idProcessoDoc')))
    } else if (u.pathname.endsWith('/DetalheProcessoConsultaPublica/listView.seam')) {
      spec = u.searchParams.has('idBin')
        ? await script.binaryDoc!(Number(u.searchParams.get('idBin')))
        : await script.detail!(u.searchParams.get('ca')!)
    } else if (u.pathname.startsWith('/pjeconsulta/ConsultaPublica/listView.seam')) {
      spec = init?.method === 'POST'
        ? await script.searchAction!(String(init.body ?? ''))
        : await script.searchSession!(new Headers(init?.headers).get('cookie'))
    } else {
      throw new Error(`Unhandled URL in test fake: ${String(url)}`)
    }

    const r = new Response(spec.body, { status: spec.status ?? 200, headers: spec.headers })
    Object.defineProperty(r, 'url', { value: spec.url ?? String(url) })
    return r
  }) as unknown as typeof fetch
  return new HttpClient({ fetchImpl, sleep: async () => {}, rps: 0 })
}

let dir: string
let db: ReturnType<typeof openDatabase>
let blobs: FsBlobStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pje-deep-'))
  db = openDatabase(join(dir, 'test.db'))
  blobs = new FsBlobStore(join(dir, 'pdfs'))
  return () => { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

describe('sanitizeFilename', () => {
  it('keeps accented letters, digits, dots and dashes', () => {
    expect(sanitizeFilename('Despacho Inspeção')).toBe('Despacho_Inspeção')
  })

  it('replaces path separators instead of letting them nest a directory', () => {
    expect(sanitizeFilename('a/b\\c')).toBe('a-b-c')
  })

  it('collapses a .. traversal attempt', () => {
    expect(sanitizeFilename('../../etc/passwd')).not.toContain('..')
  })

  it('falls back to a default name for input that sanitizes to nothing', () => {
    expect(sanitizeFilename('///')).toBe('document')
  })
})

describe('documentPdfKeyFor', () => {
  it('hangs the document off the same case directory as the summary PDF, keyed by year', () => {
    const ref: BinaryDocumentRef = {
      kind: 'binary', id: 12284583, idBin: 1, numeroDocumento: 'x',
      label: 'l', date: '24/07/2025 20:30:45', type: 'Despacho',
    }
    expect(documentPdfKeyFor('0801438-34.2016.4.05.8102', ref))
      .toBe('2016/0801438-34.2016.4.05.8102/documents/24-07-2025_20-30-45-Despacho-12284583.pdf')
  })
})

describe('deepCase', () => {
  it('runs the whole chain and stores every document when the cached ca is already valid', async () => {
    upsertCase(db, {
      idProcessoTrf: 1, number: REAL_NUMBER, ca: VALID_CA, className: 'x', classCode: null,
      court: null, panel: null, distributedAt: null, subjects: [], parties: [], summaryPdfKey: null,
      jurisdiction: null, courtAddress: null, referenceNumber: null,
    })

    const client = fakePortal({
      summaryPdf: () => ({ body: realSummaryPdf }),
      detail: (ca) => {
        expect(ca).toBe(VALID_CA)
        return { body: detailWithDocs }
      },
      binaryDoc: () => ({ body: samplePdf }),
      htmlDoc: () => ({ body: Buffer.from('<html>ato judicial</html>', 'latin1') }),
    })

    const outcome = await deepCase({ client, db, blobs }, { kind: 'id', id: 1 })
    expect(outcome).toMatchObject({
      kind: 'done', idProcessoTrf: 1, number: REAL_NUMBER,
      documentsStored: 10, documentsSkipped: 0, documentsFailed: 0,
    })

    const docs = getDocumentsByCase(db, 1)
    expect(docs).toHaveLength(10)
    const binaryDocs = docs.filter((d) => d.pdfKey !== null)
    const htmlDocs = docs.filter((d) => d.pdfKey === null)
    expect(binaryDocs).toHaveLength(9)
    expect(htmlDocs).toHaveLength(1)
    // Every binary document's text now comes from its own PDF too (see
    // `downloadOneDocument`'s reuse of `extractPdfText`), not just the
    // summary's — `samplePdf` (the fake portal's canned binary-doc response)
    // is a real, extractable PDF (see `pdf-parse.test.ts`), so this must no
    // longer be null for any of them.
    for (const d of binaryDocs) expect(d.textContent).toBeTruthy()
    expect(htmlDocs[0]!.textContent).toBeTruthy()
    for (const d of binaryDocs) expect(await blobs.exists(d.pdfKey!)).toBe(true)
    // ca did not need refreshing, so it must be unchanged.
    expect(getCaseById(db, 1)!.ca).toBe(VALID_CA)

    // Dados do Processo fields the detail page adds, filled in by the
    // second (post-detail) upsert alongside what the summary PDF already
    // provided.
    expect(getCaseById(db, 1)).toMatchObject({
      jurisdiction: 'TRF5',
      courtAddress:
        'Tribunal Regional Federal - 5ª Região, Cais do Apolo, s/n, Recife, RECIFE - PE - CEP: 50030-908',
      referenceNumber: '0801438-34.2016.4.05.8102',
    })

    const parties = getPartiesByCase(db, 1)
    expect(parties).toHaveLength(3)
    expect(parties.filter((p) => p.polo === 'ativo')).toHaveLength(2)
    expect(parties.filter((p) => p.polo === 'passivo')).toHaveLength(1)

    // From the summary PDF's own log (10 entries — see pdf-parse.test.ts),
    // not the detail page's own table (which states only 5 for this
    // fixture): proof `deepCase` wires movements to the PDF source, not the
    // HTML one.
    const movements = getMovementsByCase(db, 1)
    expect(movements).toHaveLength(10)
    expect(movements[0]).toMatchObject({ position: 0, description: 'Publicado Decisão em 27/08/2026.' })

    // `detailWithDocs` (5 declared) and `realSummaryPdf` (10 actual) are live
    // captures of two different, unrelated cases glued together for this
    // test's document-shape assertions — they were never going to agree on
    // a movements count. That disagreement is exactly what
    // `checkMovementsTruncation` exists to surface rather than swallow;
    // asserting it here turns what would otherwise be an untested side
    // effect of this test's fixture choice into a documented one.
    const movementsFailure = listFailures(db).find((f) => f.kind === 'movements')
    expect(movementsFailure).toBeDefined()
    expect(movementsFailure!.resolvedAt).toBeNull()
  })

  it('falls back to the search bridge when the cached ca is stale, and updates the stored value', async () => {
    upsertCase(db, {
      idProcessoTrf: 1, number: REAL_NUMBER, ca: STALE_CA, className: 'x', classCode: null,
      court: null, panel: null, distributedAt: null, subjects: [], parties: [], summaryPdfKey: null,
      jurisdiction: null, courtAddress: null, referenceNumber: null,
    })

    const seenDetailCas: string[] = []
    const client = fakePortal({
      summaryPdf: () => ({ body: realSummaryPdf }),
      detail: (ca) => {
        seenDetailCas.push(ca)
        return ca === STALE_CA ? { body: detailInvalidCa } : { body: detailHtmlOnly }
      },
      searchSession: () => ({ body: listViewSession }),
      searchAction: () => ({ body: searchXmlFor(1, REAL_NUMBER, BRIDGED_CA) }),
      htmlDoc: () => ({ body: Buffer.from('<html>ato</html>', 'latin1') }),
    })

    const outcome = await deepCase({ client, db, blobs }, { kind: 'id', id: 1 })
    expect(outcome).toMatchObject({ kind: 'done', documentsStored: 2, documentsFailed: 0 })
    expect(seenDetailCas).toEqual([STALE_CA, BRIDGED_CA])
    expect(getCaseById(db, 1)!.ca).toBe(BRIDGED_CA)
  })

  // Found live: for a fresh id with no cached ca, deepCase fetches the
  // summary PDF BEFORE it ever needs the search bridge (ca is null, so
  // fetchDetail is skipped and the bridge runs next) — both on the same
  // caseClient. A JSESSIONID planted by that PDF fetch made the server stop
  // URL-rewriting the session into the search form's action, so the POST
  // that followed failed with ActionNotExecutedError — not a stale submit
  // parameter, a stale cookie. startSession clearing its jar first (see
  // session.ts) is what makes this sequence safe.
  it('does not let a summary PDF fetch poison the search bridge with a stale session cookie', async () => {
    let sessionSawCookie: string | null = null
    const client = fakePortal({
      summaryPdf: () => ({
        body: realSummaryPdf,
        headers: { 'set-cookie': 'JSESSIONID=poisoned-from-report-fetch' },
      }),
      searchSession: (cookieSent) => {
        sessionSawCookie = cookieSent
        return { body: listViewSession }
      },
      searchAction: () => ({ body: searchXmlFor(1, REAL_NUMBER, VALID_CA) }),
      detail: () => ({ body: detailHtmlOnly }),
      htmlDoc: () => ({ body: Buffer.from('<html>ato</html>', 'latin1') }),
    })

    const outcome = await deepCase({ client, db, blobs }, { kind: 'id', id: 1 })

    expect(sessionSawCookie ?? '').not.toContain('poisoned-from-report-fetch')
    expect(outcome).toMatchObject({ kind: 'done', idProcessoTrf: 1, number: REAL_NUMBER })
  })

  it('resolves a case number through the search bridge when it is not yet stored', async () => {
    const client = fakePortal({
      searchSession: () => ({ body: listViewSession }),
      searchAction: () => ({ body: searchXmlFor(1, REAL_NUMBER, VALID_CA) }),
      summaryPdf: () => ({ body: realSummaryPdf }),
      detail: () => ({ body: detailHtmlOnly }),
      htmlDoc: () => ({ body: Buffer.from('<html>ato</html>', 'latin1') }),
    })

    const outcome = await deepCase({ client, db, blobs }, { kind: 'number', number: REAL_NUMBER })
    expect(outcome).toMatchObject({ kind: 'done', idProcessoTrf: 1, number: REAL_NUMBER })
    expect(getCaseById(db, 1)!.ca).toBe(VALID_CA)
  })

  // Verified live: the search bridge intermittently fails with
  // ActionNotExecutedError (no Ajax-Update-Ids header at all) reproducibly
  // even at --concurrency 1, against a case whose search succeeds
  // instantly when run alone right after — a genuine, if rare, portal
  // hiccup rather than a client-side bug. A bounded retry (mirroring
  // report.ts's TRANSIENT_RETRIES) absorbs it instead of failing the case.
  it('retries the search bridge on a transient ActionNotExecutedError and still succeeds', async () => {
    let searchAttempts = 0
    const client = fakePortal({
      searchSession: () => ({ body: listViewSession }),
      searchAction: () => {
        searchAttempts++
        return searchAttempts === 1
          ? { body: Buffer.from('<partial-response></partial-response>', 'latin1') } // no Ajax-Update-Ids at all
          : { body: searchXmlFor(1, REAL_NUMBER, VALID_CA) }
      },
      summaryPdf: () => ({ body: realSummaryPdf }),
      detail: () => ({ body: detailHtmlOnly }),
      htmlDoc: () => ({ body: Buffer.from('<html>ato</html>', 'latin1') }),
    })

    const outcome = await deepCase({ client, db, blobs }, { kind: 'number', number: REAL_NUMBER })
    expect(outcome).toMatchObject({ kind: 'done', idProcessoTrf: 1, number: REAL_NUMBER })
    expect(searchAttempts).toBe(2)
  })

  it('gives up after exhausting search-bridge retries and records a case failure', async () => {
    const client = fakePortal({
      searchSession: () => ({ body: listViewSession }),
      searchAction: () => ({ body: Buffer.from('<partial-response></partial-response>', 'latin1') }),
    })

    const outcome = await deepCase({ client, db, blobs }, { kind: 'number', number: REAL_NUMBER })
    expect(outcome.kind).toBe('failed')
    expect(listFailures(db).map((f) => f.kind)).toContain('deep_case')
  })

  it('resolves a previously recorded case-level failure once the case later succeeds', async () => {
    recordFailure(db, 'deep_case', REAL_NUMBER, 'fetch failed')
    const client = fakePortal({
      searchSession: () => ({ body: listViewSession }),
      searchAction: () => ({ body: searchXmlFor(1, REAL_NUMBER, VALID_CA) }),
      summaryPdf: () => ({ body: realSummaryPdf }),
      detail: () => ({ body: detailHtmlOnlyMatchingMovements }),
      htmlDoc: () => ({ body: Buffer.from('<html>ato</html>', 'latin1') }),
    })

    const outcome = await deepCase({ client, db, blobs }, { kind: 'number', number: REAL_NUMBER })
    expect(outcome.kind).toBe('done')
    expect(listFailures(db, { unresolvedOnly: true })).toHaveLength(0)
  })

  it('resolves a previously recorded document failure once that document later succeeds', async () => {
    upsertCase(db, {
      idProcessoTrf: 1, number: REAL_NUMBER, ca: VALID_CA, className: 'x', classCode: null,
      court: null, panel: null, distributedAt: null, subjects: [], parties: [], summaryPdfKey: null,
      jurisdiction: null, courtAddress: null, referenceNumber: null,
    })
    recordFailure(db, 'document', '12102009', 'transient HTTP 404')
    const client = fakePortal({
      summaryPdf: () => ({ body: realSummaryPdf }),
      detail: () => ({ body: detailHtmlOnlyMatchingMovements }),
      htmlDoc: () => ({ body: Buffer.from('<html>ato</html>', 'latin1') }),
    })

    await deepCase({ client, db, blobs }, { kind: 'id', id: 1 })
    expect(listFailures(db, { unresolvedOnly: true })).toHaveLength(0)
  })

  it('records a case-level failure without throwing when the summary PDF is absent', async () => {
    const client = fakePortal({
      summaryPdf: () => ({ body: errorHtml, url: 'https://x/error.seam' }),
    })
    const outcome = await deepCase({ client, db, blobs }, { kind: 'id', id: 999 })
    expect(outcome.kind).toBe('failed')
    expect(listFailures(db).map((f) => f.kind)).toContain('deep_case')
  })

  it('records one failed document without aborting the rest of the case', async () => {
    upsertCase(db, {
      idProcessoTrf: 1, number: REAL_NUMBER, ca: VALID_CA, className: 'x', classCode: null,
      court: null, panel: null, distributedAt: null, subjects: [], parties: [], summaryPdfKey: null,
      jurisdiction: null, courtAddress: null, referenceNumber: null,
    })
    const client = fakePortal({
      summaryPdf: () => ({ body: realSummaryPdf }),
      detail: () => ({ body: detailWithDocs }),
      binaryDoc: (idBin) => idBin === 12039033
        ? { body: errorHtml, url: 'https://x/error.seam' }
        : { body: samplePdf },
      htmlDoc: () => ({ body: Buffer.from('<html>ato</html>', 'latin1') }),
    })

    const outcome = await deepCase({ client, db, blobs }, { kind: 'id', id: 1 })
    expect(outcome).toMatchObject({ documentsStored: 9, documentsFailed: 1 })
    expect(listFailures(db).find((f) => f.kind === 'document')).toBeDefined()
  })

  // Finding from a live range run: a single unrecognised row (there, a
  // procedural-timeline trigger the parser didn't yet know about) used to
  // throw out of parseDetailPage and abort deepCase entirely, storing zero
  // of the case's documents. Fixed at the parser level (a MalformedDocumentRef
  // instead of a thrown error — see detail.test.ts); this exercises the
  // whole chain end to end, proving the case still completes and every
  // *other* document on the page is still downloaded.
  it('records a malformed document row as a failure without losing the rest of the case', async () => {
    upsertCase(db, {
      idProcessoTrf: 1, number: REAL_NUMBER, ca: VALID_CA, className: 'x', classCode: null,
      court: null, panel: null, distributedAt: null, subjects: [], parties: [], summaryPdfKey: null,
      jurisdiction: null, courtAddress: null, referenceNumber: null,
    })
    const brokenDetail = Buffer.from(
      detailWithDocs.toString('latin1')
        .replace('numeroDocumento=4caf3e2af32f9130b384fc0c2aef62251e2b3823&amp;', ''),
      'latin1',
    )
    const client = fakePortal({
      summaryPdf: () => ({ body: realSummaryPdf }),
      detail: () => ({ body: brokenDetail }),
      binaryDoc: () => ({ body: samplePdf }),
      htmlDoc: () => ({ body: Buffer.from('<html>ato</html>', 'latin1') }),
    })

    const outcome = await deepCase({ client, db, blobs }, { kind: 'id', id: 1 })
    // 8 binary + 1 html succeed; the one broken binary link fails alone.
    expect(outcome).toMatchObject({ kind: 'done', documentsStored: 9, documentsFailed: 1 })
    const failure = listFailures(db).find((f) => f.kind === 'document')
    expect(failure).toBeDefined()
    expect(failure!.error).toContain('idBin=12039033')
  })

  it('skips a document that is already downloaded and makes no request for it', async () => {
    upsertCase(db, {
      idProcessoTrf: 1, number: REAL_NUMBER, ca: VALID_CA, className: 'x', classCode: null,
      court: null, panel: null, distributedAt: null, subjects: [], parties: [], summaryPdfKey: null,
      jurisdiction: null, courtAddress: null, referenceNumber: null,
    })
    const requestLog: string[] = []
    const client = fakePortal({
      summaryPdf: () => ({ body: realSummaryPdf }),
      detail: () => ({ body: detailHtmlOnly }),
      htmlDoc: (_ca, idProcessoDoc) => ({ body: Buffer.from(`<html>${idProcessoDoc}</html>`, 'latin1') }),
    }, requestLog)

    // First run downloads both HTML documents.
    const first = await deepCase({ client, db, blobs }, { kind: 'id', id: 1 })
    expect(first).toMatchObject({ documentsStored: 2, documentsSkipped: 0 })

    requestLog.length = 0
    const second = await deepCase({ client, db, blobs }, { kind: 'id', id: 1 })
    expect(second).toMatchObject({ documentsStored: 0, documentsSkipped: 2 })
    expect(requestLog.some((r) => r.includes('documentoSemLoginHTML'))).toBe(false)
  })
})

describe('deepCase parties/movements truncation', () => {
  it('records no truncation failure when every stated total is actually matched', async () => {
    upsertCase(db, {
      idProcessoTrf: 1, number: REAL_NUMBER, ca: VALID_CA, className: 'x', classCode: null,
      court: null, panel: null, distributedAt: null, subjects: [], parties: [], summaryPdfKey: null,
      jurisdiction: null, courtAddress: null, referenceNumber: null,
    })
    const client = fakePortal({
      summaryPdf: () => ({ body: realSummaryPdf }),
      // `detailWithDocs`' own parties totals (2 ativo / 1 passivo) already
      // match what it renders; only its movements total needs patching to
      // agree with `realSummaryPdf`'s real 10-entry log (see
      // `detailHtmlOnlyMatchingMovements` above for the same trick).
      detail: () => ({
        body: Buffer.from(
          detailWithDocs.toString('latin1').replace('5 resultados encontrados', '10 resultados encontrados'),
          'latin1',
        ),
      }),
      binaryDoc: () => ({ body: samplePdf }),
      htmlDoc: () => ({ body: Buffer.from('<html>ato judicial</html>', 'latin1') }),
    })

    const outcome = await deepCase({ client, db, blobs }, { kind: 'id', id: 1 })
    expect(outcome.kind).toBe('done')
    expect(listFailures(db, { unresolvedOnly: true }).map((f) => f.kind)).not.toContain('parties')
    expect(listFailures(db, { unresolvedOnly: true }).map((f) => f.kind)).not.toContain('movements')
    expect(getPartiesByCase(db, 1)).toHaveLength(3)
    expect(getMovementsByCase(db, 1)).toHaveLength(10)
  })

  // The truncation contract this feature exists for: a page that states
  // more ativo participants than it actually rendered must be caught, not
  // silently stored as if the list were complete — and must NOT fail the
  // case, since the rest of it (documents, the other polo) is still a real,
  // useful result.
  it('records a loud parties failure without failing the case when a polo is truncated', async () => {
    upsertCase(db, {
      idProcessoTrf: 1, number: REAL_NUMBER, ca: VALID_CA, className: 'x', classCode: null,
      court: null, panel: null, distributedAt: null, subjects: [], parties: [], summaryPdfKey: null,
      jurisdiction: null, courtAddress: null, referenceNumber: null,
    })
    const truncatedDetail = Buffer.from(
      detailWithDocs.toString('latin1').replace('2 resultados encontrados', '5 resultados encontrados'),
      'latin1',
    )
    const client = fakePortal({
      summaryPdf: () => ({ body: realSummaryPdf }),
      detail: () => ({ body: truncatedDetail }),
      binaryDoc: () => ({ body: samplePdf }),
      htmlDoc: () => ({ body: Buffer.from('<html>ato judicial</html>', 'latin1') }),
    })

    const outcome = await deepCase({ client, db, blobs }, { kind: 'id', id: 1 })
    // The case as a whole still succeeds — every document is still stored.
    expect(outcome).toMatchObject({ kind: 'done', documentsStored: 10 })

    const failure = listFailures(db, { unresolvedOnly: true }).find((f) => f.kind === 'parties')
    expect(failure).toBeDefined()
    expect(failure!.error).toContain('2 ativo')
    expect(failure!.error).toContain('5')

    // The rows that WERE parsed are still stored — a truncated list beats
    // a discarded one, as long as its truncation isn't silent.
    expect(getPartiesByCase(db, 1)).toHaveLength(3)
  })
})

describe('search bridge concurrency', () => {
  // Found live: deepRange's worker pool shares one HttpClient — and so one
  // cookie jar — across every worker. Two workers hitting the search bridge
  // at once (both resolving a fresh id/ca, neither having one cached yet)
  // can interleave their session bootstrap and POST, so one worker's request
  // goes out carrying a submit param read from the OTHER worker's session
  // page. Reproduced here by running two targets that both need the bridge
  // concurrently against a client whose session/search responses are
  // artificially delayed, and asserting only one bridge sequence is ever
  // actually in flight.
  const OTHER_NUMBER = '0013478-88.2026.4.05.0000'
  const OTHER_CA = 'dd'.repeat(24)

  it('serializes the search bridge instead of racing the shared cookie jar', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const delay = () => new Promise((r) => setTimeout(r, 15))

    const client = fakePortal({
      searchSession: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await delay()
        inFlight--
        return { body: listViewSession }
      },
      searchAction: async (body) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await delay()
        inFlight--
        return body.includes(REAL_NUMBER)
          ? { body: searchXmlFor(1, REAL_NUMBER, VALID_CA) }
          : { body: searchXmlFor(2, OTHER_NUMBER, OTHER_CA) }
      },
      // Only one summary PDF fixture is available; id 2's case is left to
      // fail cleanly at that step (a normal 'absent' outcome) — what this
      // test verifies is that both search-bridge resolutions ran without
      // interleaving and each came back with its own number/id/ca, not a
      // crossed one, not whether id 2's case fully completes.
      summaryPdf: (id) => id === 1 ? { body: realSummaryPdf } : { body: errorHtml, url: 'https://x/error.seam' },
      detail: () => ({ body: detailHtmlOnly }),
      htmlDoc: () => ({ body: Buffer.from('<html>ato</html>', 'latin1') }),
    })

    const [a, b] = await Promise.all([
      deepCase({ client, db, blobs }, { kind: 'number', number: REAL_NUMBER }),
      deepCase({ client, db, blobs }, { kind: 'number', number: OTHER_NUMBER }),
    ])

    expect(maxInFlight).toBe(1)
    expect(a).toMatchObject({ kind: 'done', idProcessoTrf: 1, number: REAL_NUMBER })
    expect(b).toMatchObject({ kind: 'failed', ref: '2' })
  })
})

describe('deepRange', () => {
  it('processes every id in the range and continues past a failed case', async () => {
    // Only id 1 resolves to a PDF (the single available fixture, so a second
    // "successful" id would collide on the same case number); id 2 is a
    // permanent absence, exercising the "case fails, range keeps going" path.
    // id 1's ca is pre-seeded and valid, so no search bridge call is needed.
    upsertCase(db, {
      idProcessoTrf: 1, number: REAL_NUMBER, ca: VALID_CA, className: 'x', classCode: null,
      court: null, panel: null, distributedAt: null, subjects: [], parties: [], summaryPdfKey: null,
      jurisdiction: null, courtAddress: null, referenceNumber: null,
    })
    const client = fakePortal({
      summaryPdf: (id) => id === 1
        ? { body: realSummaryPdf }
        : { body: errorHtml, url: 'https://x/error.seam' },
      detail: () => ({ body: detailHtmlOnly }),
      htmlDoc: () => ({ body: Buffer.from('<html>ato</html>', 'latin1') }),
    })

    const summary = await deepRange({ client, db, blobs }, { fromId: 1, toId: 2, concurrency: 1 })
    expect(summary.casesDone).toBe(1)
    expect(summary.casesFailed).toBe(1)
    expect(summary.documentsStored).toBe(2) // the one successful case's 2 html docs
  })
})

describe('deepCase — narration', () => {
  it('narrates every step of the chain, in the order the chain runs them', async () => {
    upsertCase(db, {
      idProcessoTrf: 1, number: REAL_NUMBER, ca: VALID_CA, className: 'x', classCode: null,
      court: null, panel: null, distributedAt: null, subjects: [], parties: [], summaryPdfKey: null,
      jurisdiction: null, courtAddress: null, referenceNumber: null,
    })
    const client = fakePortal({
      summaryPdf: () => ({ body: realSummaryPdf }),
      detail: () => ({ body: detailWithDocs }),
      binaryDoc: () => ({ body: samplePdf }),
      htmlDoc: () => ({ body: Buffer.from('<html>ato</html>', 'latin1') }),
    })

    const steps: DeepStepEvent[] = []
    await deepCase({ client, db, blobs }, { kind: 'id', id: 1 }, { onStep: (e) => steps.push(e) })

    expect(steps.map((s) => s.kind)).toEqual([
      'summary_pdf', 'summary_pdf_ok', 'detail_key', 'case_file', 'case_file_ok', 'documents',
    ])
    expect(steps).toContainEqual(expect.objectContaining({ kind: 'summary_pdf_ok', ref: '1', number: REAL_NUMBER }))
    expect(steps).toContainEqual({ kind: 'detail_key', ref: '1', source: 'cached' })
    expect(steps).toContainEqual({ kind: 'case_file_ok', ref: '1', documentCount: 10 })
    expect(steps).toContainEqual({ kind: 'documents', ref: '1', total: 10, alreadyOnDisk: 0 })
  })

  it('says it is searching, not reusing, when there is no ca on file yet', async () => {
    const client = fakePortal({
      summaryPdf: () => ({ body: realSummaryPdf }),
      searchSession: () => ({ body: listViewSession }),
      searchAction: () => ({ body: searchXmlFor(1, REAL_NUMBER, VALID_CA) }),
      detail: () => ({ body: detailHtmlOnlyMatchingMovements }),
      htmlDoc: () => ({ body: Buffer.from('<html>ato</html>', 'latin1') }),
    })

    const steps: DeepStepEvent[] = []
    await deepCase({ client, db, blobs }, { kind: 'id', id: 1 }, { onStep: (e) => steps.push(e) })

    expect(steps).toContainEqual({ kind: 'detail_key', ref: '1', source: 'search' })
    expect(steps).not.toContainEqual(expect.objectContaining({ source: 'cached' }))
  })

  it('says a cached ca went stale rather than silently re-deriving it', async () => {
    upsertCase(db, {
      idProcessoTrf: 1, number: REAL_NUMBER, ca: STALE_CA, className: 'x', classCode: null,
      court: null, panel: null, distributedAt: null, subjects: [], parties: [], summaryPdfKey: null,
      jurisdiction: null, courtAddress: null, referenceNumber: null,
    })
    const client = fakePortal({
      summaryPdf: () => ({ body: realSummaryPdf }),
      detail: (ca) => ({ body: ca === STALE_CA ? detailInvalidCa : detailHtmlOnlyMatchingMovements }),
      searchSession: () => ({ body: listViewSession }),
      searchAction: () => ({ body: searchXmlFor(1, REAL_NUMBER, BRIDGED_CA) }),
      htmlDoc: () => ({ body: Buffer.from('<html>ato</html>', 'latin1') }),
    })

    const steps: DeepStepEvent[] = []
    await deepCase({ client, db, blobs }, { kind: 'id', id: 1 }, { onStep: (e) => steps.push(e) })

    expect(steps.map((s) => s.kind)).toEqual([
      'summary_pdf', 'summary_pdf_ok', 'detail_key', 'case_file', 'detail_key', 'case_file', 'case_file_ok', 'documents',
    ])
    expect(steps).toContainEqual({ kind: 'detail_key', ref: '1', source: 'stale' })
  })

  it('reports a search-bridge retry as it happens, with the reason the portal gave', async () => {
    let searchAttempts = 0
    const client = fakePortal({
      searchSession: () => ({ body: listViewSession }),
      searchAction: () => {
        searchAttempts++
        return searchAttempts === 1
          ? { body: Buffer.from('<partial-response></partial-response>', 'latin1') }
          : { body: searchXmlFor(1, REAL_NUMBER, VALID_CA) }
      },
      summaryPdf: () => ({ body: realSummaryPdf }),
      detail: () => ({ body: detailHtmlOnlyMatchingMovements }),
      htmlDoc: () => ({ body: Buffer.from('<html>ato</html>', 'latin1') }),
    })

    const steps: DeepStepEvent[] = []
    await deepCase({ client, db, blobs }, { kind: 'number', number: REAL_NUMBER }, { onStep: (e) => steps.push(e) })

    const retry = steps.find((s) => s.kind === 'detail_key_retry')
    expect(retry).toMatchObject({ kind: 'detail_key_retry', attempt: 1, of: 4 })
    expect((retry as { reason: string }).reason).toMatch(/action/i)
  })

  it('reports a retried summary PDF, rather than going quiet for the extra attempts', async () => {
    let attempts = 0
    const client = fakePortal({
      summaryPdf: () => (++attempts === 1 ? { body: Buffer.from('<html>nope</html>', 'latin1'), status: 404 } : { body: realSummaryPdf }),
      searchSession: () => ({ body: listViewSession }),
      searchAction: () => ({ body: searchXmlFor(1, REAL_NUMBER, VALID_CA) }),
      detail: () => ({ body: detailHtmlOnlyMatchingMovements }),
      htmlDoc: () => ({ body: Buffer.from('<html>ato</html>', 'latin1') }),
    })

    const steps: DeepStepEvent[] = []
    await deepCase({ client, db, blobs }, { kind: 'id', id: 1 }, { onStep: (e) => steps.push(e) })

    expect(steps).toContainEqual({ kind: 'summary_pdf_retry', ref: '1', attempt: 1, of: 4, status: 404 })
  })

  it('counts what is already on disk before the download starts, not after', async () => {
    upsertCase(db, {
      idProcessoTrf: 1, number: REAL_NUMBER, ca: VALID_CA, className: 'x', classCode: null,
      court: null, panel: null, distributedAt: null, subjects: [], parties: [], summaryPdfKey: null,
      jurisdiction: null, courtAddress: null, referenceNumber: null,
    })
    const script = {
      summaryPdf: () => ({ body: realSummaryPdf }),
      detail: () => ({ body: detailWithDocs }),
      binaryDoc: () => ({ body: samplePdf }),
      htmlDoc: () => ({ body: Buffer.from('<html>ato</html>', 'latin1') }),
    }
    await deepCase({ client: fakePortal(script), db, blobs }, { kind: 'id', id: 1 })

    const steps: DeepStepEvent[] = []
    await deepCase({ client: fakePortal(script), db, blobs }, { kind: 'id', id: 1 }, { onStep: (e) => steps.push(e) })

    expect(steps).toContainEqual({ kind: 'documents', ref: '1', total: 10, alreadyOnDisk: 10 })
  })
})
