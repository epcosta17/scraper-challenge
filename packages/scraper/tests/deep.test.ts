import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase, FsBlobStore, upsertCase, getCaseById, getDocumentsByCase, listFailures, recordFailure } from '@pje/core'
import { HttpClient } from '../src/http/client.ts'
import { deepCase, deepRange, sanitizeFilename, documentPdfKeyFor } from '../src/crawl/deep.ts'
import type { BinaryDocumentRef } from '../src/pje/detail.ts'

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))

const realSummaryPdf = fixture('case-130100.pdf') // parses to '0013475-36.2026.4.05.0000'
const REAL_NUMBER = '0013475-36.2026.4.05.0000'
const detailWithDocs = fixture('detail-with-docs.html') // 9 binary + 1 html doc
const detailHtmlOnly = fixture('detail-html-docs-only.html') // 0 binary + 2 html doc
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

interface Spec { body: Buffer; status?: number; url?: string }
type MaybePromise<T> = T | Promise<T>
interface PortalScript {
  summaryPdf?: (id: number) => MaybePromise<Spec>
  detail?: (ca: string) => MaybePromise<Spec>
  searchSession?: () => MaybePromise<Spec>
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
        : await script.searchSession!()
    } else {
      throw new Error(`Unhandled URL in test fake: ${String(url)}`)
    }

    const r = new Response(spec.body, { status: spec.status ?? 200 })
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
    const htmlDocs = docs.filter((d) => d.textContent !== null)
    expect(binaryDocs).toHaveLength(9)
    expect(htmlDocs).toHaveLength(1)
    for (const d of binaryDocs) expect(await blobs.exists(d.pdfKey!)).toBe(true)
    // ca did not need refreshing, so it must be unchanged.
    expect(getCaseById(db, 1)!.ca).toBe(VALID_CA)
  })

  it('falls back to the search bridge when the cached ca is stale, and updates the stored value', async () => {
    upsertCase(db, {
      idProcessoTrf: 1, number: REAL_NUMBER, ca: STALE_CA, className: 'x', classCode: null,
      court: null, panel: null, distributedAt: null, subjects: [], parties: [], summaryPdfKey: null,
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

  it('resolves a previously recorded case-level failure once the case later succeeds', async () => {
    recordFailure(db, 'deep_case', REAL_NUMBER, 'fetch failed')
    const client = fakePortal({
      searchSession: () => ({ body: listViewSession }),
      searchAction: () => ({ body: searchXmlFor(1, REAL_NUMBER, VALID_CA) }),
      summaryPdf: () => ({ body: realSummaryPdf }),
      detail: () => ({ body: detailHtmlOnly }),
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
    })
    recordFailure(db, 'document', '12102009', 'transient HTTP 404')
    const client = fakePortal({
      summaryPdf: () => ({ body: realSummaryPdf }),
      detail: () => ({ body: detailHtmlOnly }),
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

  it('skips a document that is already downloaded and makes no request for it', async () => {
    upsertCase(db, {
      idProcessoTrf: 1, number: REAL_NUMBER, ca: VALID_CA, className: 'x', classCode: null,
      court: null, panel: null, distributedAt: null, subjects: [], parties: [], summaryPdfKey: null,
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
