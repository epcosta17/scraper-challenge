import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FsBlobStore,
  openDatabase,
  recordFailure,
  replaceMovementsForCase,
  replacePartiesForCase,
  upsertCase,
  upsertDocument,
  type Db,
  type StoredCase,
} from '@pje/core'
import { createSqliteDataSource } from '../src/data/sqlite/source.ts'
import { isPartial, missing } from '../src/data/types.ts'

/**
 * The data source against a real SQLite file written through the same
 * repositories the scraper writes through — not a stub of them. Everything
 * asserted here is a claim about what the screens will show once `deep` has
 * run, so the seeding below mirrors what a run actually stores, down to the
 * wording of the failure row the Datascroller produces.
 */

let root: string
let dbPath: string
let blobRoot: string
let db: Db

const CASE_FULL = '0800120-05.2024.4.05.8306'
const CASE_TRUNCATED = '0024885-29.2005.4.05.0000'

const storedCase = (id: number, number: string, className: string, court: string): StoredCase => ({
  idProcessoTrf: id,
  number,
  ca: 'ca-token',
  className,
  classCode: '198',
  court,
  panel: '1ª Turma',
  distributedAt: '17 de Agosto de 2026',
  subjects: [],
  parties: [],
  summaryPdfKey: `2024/${number}/summary.pdf`,
  jurisdiction: 'TRF5',
  courtAddress: null,
  referenceNumber: number,
})

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pje-web-'))
  dbPath = join(root, 'data', 'pje.db')
  blobRoot = join(root, 'pdfs')
  db = openDatabase(dbPath)

  upsertCase(db, storedCase(130105, CASE_FULL, 'APELAÇÃO CÍVEL', 'Gab 14 - Des. EDVALDO BATISTA'))
  upsertCase(db, storedCase(28907, CASE_TRUNCATED, 'EMBARGOS À EXECUÇÃO', 'Gab 2 - Desa. ANA BEATRIZ'))

  replaceMovementsForCase(db, 130105, [
    { position: 0, timestamp: '01/09/2026 17:42:40', description: 'Juntada de Petição de ciência' },
    { position: 1, timestamp: '31/08/2026 18:47:51', description: 'Juntada de Certidão' },
  ])
  replaceMovementsForCase(db, 28907, [
    { position: 0, timestamp: '18/09/2025 11:02:00', description: 'Expedição de documentos' },
  ])

  replacePartiesForCase(db, 130105, [
    {
      polo: 'ativo', name: 'CRECIO GERMANO DE SOUSA', documentType: 'cpf',
      documentNumber: '155.753.494-20', oab: null, role: 'PARTE AUTORA', situation: 'Ativo',
    },
    {
      polo: 'passivo', name: 'INSTITUTO NACIONAL DO SEGURO SOCIAL - INSS', documentType: 'cnpj',
      documentNumber: '29.979.036/0042-19', oab: null, role: 'PARTE RE', situation: 'Ativo',
    },
  ])
  replacePartiesForCase(db, 28907, [
    {
      polo: 'ativo', name: 'UNIÃO FEDERAL (FAZENDA NACIONAL)', documentType: 'cnpj',
      documentNumber: '00.394.460/0001-41', oab: null, role: 'EMBARGANTE', situation: 'Ativo',
    },
  ])

  // Verbatim from `storeParties` in `packages/scraper/src/crawl/deep.ts`.
  recordFailure(
    db, 'parties', '28907',
    'Parsed 1 ativo / 10 passivo parties but the page states 1 / 40 — ' +
    'the Datascroller is hiding a further page, never followed by this scraper.',
  )

  const pdfKey = `2024/${CASE_FULL}/documents/09-04-2024_16-54-59-Despacho-12101987.pdf`
  const pdf = Buffer.from('%PDF-1.4 despacho\n')
  upsertDocument(db, {
    idProcessoDocumento: 12101987,
    idProcessoTrf: 130105,
    idBin: 55,
    numeroDocumento: '1',
    label: '09/04/2024 16:54:59 - Despacho (Despacho)',
    docType: 'Despacho',
    docDate: '09/04/2024 16:54:59',
    pdfKey,
    textContent: 'Intime-se a parte autora para, no prazo de quinze dias, manifestar-se.',
  })
  await new FsBlobStore(blobRoot).put(pdfKey, pdf)

  upsertDocument(db, {
    idProcessoDocumento: 12102220,
    idProcessoTrf: 130105,
    idBin: null,
    numeroDocumento: null,
    label: '11/07/2026 20:19:33 - Sentença (Sentença)',
    docType: 'Sentença',
    docDate: '11/07/2026 20:19:33',
    pdfKey: null,
    textContent: 'julgo extinto o feito, nos termos do art. 485, VI, do CPC.',
  })
})

afterAll(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

const source = () => createSqliteDataSource({ databasePath: dbPath, blobRoot })

describe('an acervo that is there', () => {
  it('reports itself ready, and where it lives', async () => {
    await expect(source().status()).resolves.toEqual({ kind: 'ready', databasePath: dbPath, blobRoot })
  })

  it('counts the acervo for the footer of the list', async () => {
    const stats = await source().archiveStats()
    expect(stats.caseCount).toBe(2)
    expect(stats.documentCount).toBe(2)
    expect(stats.lastSyncLabel).not.toBe('nunca')
  })

  it('lists a page of cases with the newest movement of each', async () => {
    const page = await source().listCases(1, 10)
    expect(page.total).toBe(2)
    expect(page.pageCount).toBe(1)
    expect(page.items.map((c) => c.number).sort()).toEqual([CASE_TRUNCATED, CASE_FULL].sort())

    const full = page.items.find((c) => c.number === CASE_FULL)!
    expect(full.organ).toBe('Gab 14 - Des. EDVALDO BATISTA')
    // Position 0 is the portal's own newest-first ordering, and the seconds
    // the design does not print are gone.
    expect(full.lastMovement).toEqual({
      timestamp: '01/09/2026 17:42',
      description: 'Juntada de Petição de ciência',
    })
  })

  it('carries the declared party total into the listing, not just the detail', async () => {
    const page = await source().listCases(1, 10)
    const truncated = page.items.find((c) => c.number === CASE_TRUNCATED)!
    expect(truncated.parties).toEqual({ captured: 1, declared: 41 })
    expect(isPartial(truncated.parties)).toBe(true)
  })

  it('clamps a page number past the end rather than answering emptily', async () => {
    const page = await source().listCases(99, 1)
    expect(page.page).toBe(2)
    expect(page.items).toHaveLength(1)
  })
})

describe('one case', () => {
  it('answers null for a number that is not in the acervo', async () => {
    await expect(source().getCase('0000000-00.0000.0.00.0000')).resolves.toBeNull()
  })

  it('shows the capture as complete when nothing was left behind', async () => {
    const detail = (await source().getCase(CASE_FULL))!
    expect(detail.className).toBe('APELAÇÃO CÍVEL')
    expect(detail.distributedAt).toBe('17/08/2026')
    expect(detail.parties).toHaveLength(2)
    expect(detail.movements).toHaveLength(2)
    expect(isPartial(detail.capture.parties)).toBe(false)
    expect(isPartial(detail.capture.movements)).toBe(false)
    expect(detail.capture.failures).toEqual([])
    expect(detail.capture.lastCaptureAt).toMatch(/^hoy, \d{2}:\d{2}$/)
  })

  it('shows what the portal declared against what was read, and why', async () => {
    const detail = (await source().getCase(CASE_TRUNCATED))!
    expect(detail.capture.parties).toEqual({ captured: 1, declared: 41 })
    expect(isPartial(detail.capture.parties)).toBe(true)
    expect(missing(detail.capture.parties)).toBe(40)
    // The scraper's own account of the gap reaches the screen, unedited.
    expect(detail.capture.failures).toHaveLength(1)
    expect(detail.capture.failures[0]!.kind).toBe('parties')
    // Said in the interface's language, with the scraper's own words kept beside it.
    expect(detail.capture.failures[0]!.error).toContain('11 de 41 partes')
    expect(detail.capture.failures[0]!.raw).toContain('Datascroller')
  })

  it('describes each document by its act and size, and never invents a total it was not told', async () => {
    const detail = (await source().getCase(CASE_FULL))!
    const pdf = detail.documents.find((d) => d.format === 'PDF')!
    expect(pdf.label).toBe('Despacho')
    expect(pdf.docDate).toBe('09/04/2024')
    expect(pdf.sizeBytes).toBe(18)

    const html = detail.documents.find((d) => d.format === 'HTML')!
    expect(html.label).toBe('Sentença')
    expect(detail.documentsBytes).toBe(18 + Buffer.byteLength(
      'julgo extinto o feito, nos termos do art. 485, VI, do CPC.', 'utf8'))
    // Nothing stores how many documents the case file listed, so the count is
    // reported without a declared total rather than with an invented one.
    expect(detail.capture.documents).toEqual({ captured: 2, declared: null })
    expect(detail.capture.requestCount).toBeNull()
  })
})

describe('full-text search', () => {
  it('finds a case through the text of one of its documents, with the fragment', async () => {
    const result = await source().search('extinto', 1, 10)
    expect(result.error).toBeNull()
    expect(result.total).toBe(1)
    const hit = result.hits[0]!
    expect(hit.number).toBe(CASE_FULL)
    expect(hit.matchedIn).toContain('document')
    expect(hit.snippet).not.toBeNull()
    expect(hit.snippet!.label).toBe('11/07/2026 20:19:33 - Sentença (Sentença)')
    expect(hit.snippet!.segments.some((s) => s.hit && s.text.toLowerCase() === 'extinto')).toBe(true)
    expect(hit.snippet!.segments.map((s) => s.text).join('')).toContain('julgo')
  })

  it('folds the accents a person typing on a Brazilian portal will not type', async () => {
    await expect(source().search('sentenca', 1, 10)).resolves.toMatchObject({ total: 1 })
  })

  it('finds a case through a party name', async () => {
    const result = await source().search('"UNIÃO FEDERAL"', 1, 10)
    expect(result.hits.map((h) => h.number)).toEqual([CASE_TRUNCATED])
    expect(result.hits[0]!.matchedIn).toContain('party')
  })

  it('takes a pasted case number, punctuation and all', async () => {
    const result = await source().search(CASE_FULL, 1, 10)
    expect(result.hits[0]!.number).toBe(CASE_FULL)
  })

  it('says a query has nothing searchable in it instead of failing', async () => {
    const result = await source().search('***', 1, 10)
    expect(result.error).not.toBeNull()
    expect(result.hits).toEqual([])
  })

  it('answers an empty box with nothing at all, and no error', async () => {
    const result = await source().search('   ', 1, 10)
    expect(result.hits).toEqual([])
    expect(result.error).toBeNull()
  })
})

describe('the chat, which is the same index asked in prose', () => {
  it('opens with what it is, before anything is asked', async () => {
    const conversation = await source().conversation(null)
    expect(conversation.scope).toContain('2 expedientes')
    expect(conversation.messages).toHaveLength(1)
    expect(conversation.messages[0]!.paragraphs.join(' ')).toContain('modelo de lenguaje')
  })

  it('answers with counts it made and fragments it found', async () => {
    const conversation = await source().conversation('extinto')
    expect(conversation.sourceCount).toBe(1)
    expect(conversation.messages[0]!.role).toBe('user')
    const answer = conversation.messages[1]!
    expect(answer.paragraphs[0]).toContain('1 expediente coincide')
    expect(answer.citations).toEqual(['0800120-05.2024'])
    expect(conversation.sources[0]!.fragment).toContain('julgo')
  })

  it('says plainly when nothing in the acervo matches', async () => {
    const conversation = await source().conversation('desapropriação')
    expect(conversation.sourceCount).toBe(0)
    expect(conversation.messages[1]!.paragraphs[0]).toContain('Ningún expediente')
  })
})

describe('the queue', () => {
  it('enqueues a job and shows it, queued, with no invented progress', async () => {
    const outcome = await source().enqueue('deep_case', CASE_FULL)
    expect(outcome.ok).toBe(true)

    const overview = await source().captureOverview()
    expect(overview.queuedJobs).toBe(1)
    expect(overview.runningJobs).toBe(0)
    const job = overview.jobs[0]!
    expect(job.kind).toBe('deep_case')
    expect(job.target).toBe(CASE_FULL)
    expect(job.state).toBe('queued')
    expect(job.attempts).toBe(0)
    expect(job.startedAt).toBeNull()
    expect(job.error).toBeNull()
  })

  it('refuses a target the worker could not act on, and enqueues nothing', async () => {
    const before = (await source().captureOverview()).jobs.length
    const outcome = await source().enqueue('deep_range', 'no es un rango')
    expect(outcome).toEqual({ ok: false, error: expect.stringContaining('rango') })
    expect((await source().captureOverview()).jobs).toHaveLength(before)
  })

  it('lists the unresolved failures as the scraper filed them', async () => {
    const overview = await source().captureOverview()
    expect(overview.openFailures).toBe(1)
    expect(overview.failures[0]).toMatchObject({ kind: 'parties', ref: '28907', attempts: 1 })
  })
})

describe('serving a document', () => {
  it('reads a PDF out of the blob store under a descriptive name', async () => {
    const file = (await source().openDocument(12101987))!
    expect(file.contentType).toBe('application/pdf')
    expect(file.filename).toBe(`${CASE_FULL} - Despacho - 09-04-2024.pdf`)
    expect(Buffer.from(file.body as Uint8Array).toString('utf8')).toContain('%PDF-')
  })

  it('serves an HTML document as the extracted act it actually is', async () => {
    const file = (await source().openDocument(12102220))!
    expect(file.contentType).toBe('text/plain; charset=utf-8')
    expect(file.filename).toBe(`${CASE_FULL} - Sentença - 11-07-2026.txt`)
    expect(file.body).toContain('julgo extinto')
  })

  it('has nothing for an id that is not a document', async () => {
    await expect(source().openDocument(999)).resolves.toBeNull()
    await expect(source().openDocument(Number.NaN)).resolves.toBeNull()
  })
})

describe('an acervo that is not there', () => {
  it('says the database is missing instead of creating an empty one', async () => {
    const path = join(root, 'nowhere', 'pje.db')
    const missingSource = createSqliteDataSource({ databasePath: path, blobRoot })
    await expect(missingSource.status()).resolves.toMatchObject({ kind: 'missing', databasePath: path })
    // Asking again must not have brought a database into being.
    await expect(missingSource.status()).resolves.toMatchObject({ kind: 'missing' })
  })

  it('answers every screen emptily rather than throwing', async () => {
    const dead = createSqliteDataSource({ databasePath: join(root, 'nowhere', 'pje.db'), blobRoot })
    await expect(dead.archiveStats()).resolves.toEqual({
      caseCount: 0, documentCount: 0, coveragePct: 0, lastSyncLabel: 'nunca',
    })
    await expect(dead.listCases(1, 6)).resolves.toMatchObject({ items: [], total: 0 })
    await expect(dead.getCase(CASE_FULL)).resolves.toBeNull()
    await expect(dead.search('extinto', 1, 10)).resolves.toMatchObject({ hits: [], total: 0 })
    await expect(dead.captureOverview()).resolves.toMatchObject({ jobs: [], failures: [] })
    await expect(dead.openDocument(12101987)).resolves.toBeNull()
  })

  it('will not enqueue into a database that does not exist', async () => {
    const dead = createSqliteDataSource({ databasePath: join(root, 'nowhere', 'pje.db'), blobRoot })
    const outcome = await dead.enqueue('deep_case', CASE_FULL)
    expect(outcome).toEqual({ ok: false, error: expect.stringContaining('No hay ninguna base') })
  })

  it('tells an empty database apart from a missing one', async () => {
    const emptyPath = join(root, 'empty', 'pje.db')
    openDatabase(emptyPath).close()
    const empty = createSqliteDataSource({ databasePath: emptyPath, blobRoot })
    await expect(empty.status()).resolves.toMatchObject({ kind: 'empty' })
  })
})
