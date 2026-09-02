import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  openDatabase, upsertCase, getCaseByNumber, getCaseById, getMaxCaseId,
  recordProbe, getProbedIds, recordFailure, listFailures, FsBlobStore,
  DuplicateCaseNumberError,
  upsertDocument, isDocumentDownloaded, getDocumentsByCase,
  replacePartiesForCase, getPartiesByCase,
  replaceMovementsForCase, getMovementsByCase,
} from '../src/index.ts'

const sample = {
  idProcessoTrf: 130100,
  number: '0013475-36.2026.4.05.0000',
  ca: 'deadbeef'.repeat(6),
  className: 'AGRAVO DE INSTRUMENTO',
  classCode: '202',
  court: 'Gab 6 - Des. PAULO CORDEIRO',
  panel: '2ª Turma',
  distributedAt: '17 de Agosto de 2026',
  subjects: ['DIREITO CIVIL (899)', 'Obrigações (7681)'],
  parties: [{ name: 'FLAVIO DOS SANTOS DIAS', role: 'AGRAVANTE' }],
  summaryPdfKey: 'pdfs/2026/0013475-36.2026.4.05.0000/summary.pdf',
  jurisdiction: 'TRF5',
  courtAddress: 'Tribunal Regional Federal - 5ª Região, Cais do Apolo, s/n, Recife, RECIFE - PE - CEP: 50030-908',
  referenceNumber: null,
}

let dir: string
let db: ReturnType<typeof openDatabase>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pje-test-'))
  db = openDatabase(join(dir, 'test.db'))
  return () => { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

describe('openDatabase', () => {
  it('creates a missing parent directory instead of throwing', () => {
    // `data/` is gitignored and does not exist on a fresh clone; the default
    // `--db data/pje.db` must not crash the very first run because of it.
    // Go two levels deep to prove it's not just a one-shot `mkdir`.
    const missing = join(dir, 'nested', 'deeper', 'fresh.db')
    const fresh = openDatabase(missing)
    try {
      // The schema must actually be usable, not just "didn't throw".
      upsertCase(fresh, sample)
      expect(getCaseByNumber(fresh, sample.number)).not.toBeNull()
    } finally {
      fresh.close()
    }
  })

  it('is idempotent on a fresh database — the columns SCHEMA already created are left alone', () => {
    // The `beforeEach` below already ran `openDatabase` (and so
    // `migrateSchema`) once against this exact file; opening it again must
    // not throw (no "duplicate column" from a second ALTER TABLE) and must
    // not disturb existing data.
    upsertCase(db, sample)
    const reopened = openDatabase(join(dir, 'test.db'))
    try {
      expect(getCaseById(reopened, sample.idProcessoTrf)!.jurisdiction).toBe(sample.jurisdiction)
    } finally {
      reopened.close()
    }
  })

  it('adds the three new cases columns to a database created before this migration existed, keeping its data', () => {
    // Recreates exactly the schema this project shipped with before
    // jurisdiction/court_address/reference_number existed — no migration
    // helper, built straight from `better-sqlite3` so this test doesn't
    // depend on `migrateSchema` to construct its own precondition.
    const legacyPath = join(dir, 'legacy.db')
    const legacy = new Database(legacyPath)
    legacy.exec(`
      CREATE TABLE cases (
        id_processo_trf INTEGER PRIMARY KEY,
        number          TEXT NOT NULL UNIQUE,
        ca              TEXT,
        class_code      TEXT,
        class_name      TEXT,
        court           TEXT,
        panel           TEXT,
        distributed_at  TEXT,
        subjects_json   TEXT NOT NULL DEFAULT '[]',
        parties_json    TEXT NOT NULL DEFAULT '[]',
        summary_pdf_key TEXT,
        first_seen_at   TEXT NOT NULL,
        last_scraped_at TEXT NOT NULL
      );
    `)
    legacy.prepare(`
      INSERT INTO cases (id_processo_trf, number, class_name, subjects_json, parties_json, first_seen_at, last_scraped_at)
      VALUES (1, '0000000-00.2020.4.05.0000', 'OLD CLASS', '[]', '[]', datetime('now'), datetime('now'))
    `).run()
    legacy.close()

    // The real entry point — this is what a restart against an old database
    // actually calls.
    const migrated = openDatabase(legacyPath)
    try {
      const row = migrated.prepare('SELECT * FROM cases WHERE id_processo_trf = 1').get() as Record<string, unknown>
      expect(row.class_name).toBe('OLD CLASS') // pre-existing data untouched
      expect(row.jurisdiction ?? null).toBeNull() // new column present, backfilled null
      expect(row.court_address ?? null).toBeNull()
      expect(row.reference_number ?? null).toBeNull()

      // The new columns are not just present but usable end to end.
      upsertCase(migrated, { ...sample, idProcessoTrf: 1, jurisdiction: 'TRF5' })
      expect(getCaseById(migrated, 1)!.jurisdiction).toBe('TRF5')

      // Idempotent: migrating an already-migrated database again (a second
      // restart) must not throw ("duplicate column name").
      expect(() => openDatabase(legacyPath).close()).not.toThrow()
    } finally {
      migrated.close()
    }
  })
})

describe('cases repository', () => {
  it('round-trips a case including JSON columns', () => {
    upsertCase(db, sample)
    const got = getCaseByNumber(db, sample.number)
    expect(got).not.toBeNull()
    expect(got!.idProcessoTrf).toBe(130100)
    expect(got!.subjects).toEqual(sample.subjects)
    expect(got!.parties[0]!.role).toBe('AGRAVANTE')
  })

  it('is idempotent — upserting twice keeps one row', () => {
    upsertCase(db, sample)
    upsertCase(db, { ...sample, court: 'Updated court' })
    expect(getCaseById(db, 130100)!.court).toBe('Updated court')
    expect((db.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number }).n).toBe(1)
  })

  it('reports 0 as the max id on an empty database', () => {
    expect(getMaxCaseId(db)).toBe(0)
  })

  it('reports the highest stored id as the resume watermark', () => {
    upsertCase(db, sample)
    upsertCase(db, { ...sample, idProcessoTrf: 130205, number: '0000001-11.2026.4.05.0000' })
    expect(getMaxCaseId(db)).toBe(130205)
  })

  it('rejects a different id_processo_trf carrying an already-used case number with a typed error', () => {
    upsertCase(db, sample)
    let caught: unknown
    try {
      upsertCase(db, { ...sample, idProcessoTrf: 999999 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(DuplicateCaseNumberError)
    const err = caught as DuplicateCaseNumberError
    expect(err.number).toBe(sample.number)
    expect(err.idProcessoTrf).toBe(999999)
  })

  it('keeps stored parties when a re-upsert carries an empty parties array', () => {
    upsertCase(db, sample)
    upsertCase(db, { ...sample, parties: [] })
    expect(getCaseById(db, sample.idProcessoTrf)!.parties).toEqual(sample.parties)
  })

  it('overwrites parties when a re-upsert carries a different non-empty parties array', () => {
    upsertCase(db, sample)
    const newParties = [{ name: 'NEW PARTY', role: 'AGRAVADO' }]
    upsertCase(db, { ...sample, parties: newParties })
    expect(getCaseById(db, sample.idProcessoTrf)!.parties).toEqual(newParties)
  })

  it('keeps stored subjects when a re-upsert carries an empty subjects array', () => {
    upsertCase(db, sample)
    upsertCase(db, { ...sample, subjects: [] })
    expect(getCaseById(db, sample.idProcessoTrf)!.subjects).toEqual(sample.subjects)
  })

  it('overwrites subjects when a re-upsert carries a different non-empty subjects array', () => {
    upsertCase(db, sample)
    const newSubjects = ['DIREITO PENAL (100)']
    upsertCase(db, { ...sample, subjects: newSubjects })
    expect(getCaseById(db, sample.idProcessoTrf)!.subjects).toEqual(newSubjects)
  })

  it('round-trips jurisdiction, courtAddress and referenceNumber', () => {
    upsertCase(db, sample)
    const got = getCaseById(db, sample.idProcessoTrf)!
    expect(got.jurisdiction).toBe('TRF5')
    expect(got.courtAddress).toBe(sample.courtAddress)
    expect(got.referenceNumber).toBeNull()
  })

  // `deep.ts` upserts a case once right after the summary PDF (before it
  // has fetched the detail page, so these three fields are still unknown)
  // and again once the detail page is in hand. The first call must not
  // blank out what a *previous run* already captured.
  it('keeps a previously stored jurisdiction/courtAddress/referenceNumber when a re-upsert carries null for them', () => {
    upsertCase(db, sample)
    upsertCase(db, { ...sample, jurisdiction: null, courtAddress: null, referenceNumber: null })
    const got = getCaseById(db, sample.idProcessoTrf)!
    expect(got.jurisdiction).toBe('TRF5')
    expect(got.courtAddress).toBe(sample.courtAddress)
  })

  it('overwrites jurisdiction/courtAddress/referenceNumber when a re-upsert carries new non-null values', () => {
    upsertCase(db, sample)
    upsertCase(db, { ...sample, referenceNumber: '0801438-34.2016.4.05.8102' })
    expect(getCaseById(db, sample.idProcessoTrf)!.referenceNumber).toBe('0801438-34.2016.4.05.8102')
  })
})

describe('parties repository', () => {
  beforeEach(() => {
    upsertCase(db, sample)
  })

  const ativoParty = {
    polo: 'ativo' as const,
    name: 'CONSELHO REGIONAL DE ODONTOLOGIA DO CEARA',
    documentType: 'cnpj' as const,
    documentNumber: '07.299.589/0001-10',
    oab: null,
    role: 'APELANTE',
    situation: 'Ativo',
  }
  const passivoParty = {
    polo: 'passivo' as const,
    name: 'BENJAMIM SAMPAIO FILHO',
    documentType: 'cpf' as const,
    documentNumber: '102.897.124-91',
    oab: null,
    role: 'APELADO',
    situation: 'Ativo',
  }

  it('round-trips parties across both polos', () => {
    replacePartiesForCase(db, sample.idProcessoTrf, [ativoParty, passivoParty])
    const got = getPartiesByCase(db, sample.idProcessoTrf)
    expect(got).toHaveLength(2)
    expect(got).toContainEqual({ idProcessoTrf: sample.idProcessoTrf, ...ativoParty })
    expect(got).toContainEqual({ idProcessoTrf: sample.idProcessoTrf, ...passivoParty })
  })

  it('replaces the whole list on a re-run instead of duplicating or merging it', () => {
    replacePartiesForCase(db, sample.idProcessoTrf, [ativoParty, passivoParty])
    replacePartiesForCase(db, sample.idProcessoTrf, [ativoParty]) // passivo dropped this run
    const got = getPartiesByCase(db, sample.idProcessoTrf)
    expect(got).toHaveLength(1)
    expect(got[0]!.polo).toBe('ativo')
  })

  it('keeps two identically-named parties as two rows, not one — no natural key to collapse them on', () => {
    const relisted = { ...ativoParty, role: 'ADVOGADO' }
    replacePartiesForCase(db, sample.idProcessoTrf, [ativoParty, relisted])
    expect(getPartiesByCase(db, sample.idProcessoTrf)).toHaveLength(2)
  })

  it('only lists parties belonging to the requested case', () => {
    upsertCase(db, { ...sample, idProcessoTrf: 999999, number: '0000002-22.2026.4.05.0000' })
    replacePartiesForCase(db, sample.idProcessoTrf, [ativoParty])
    replacePartiesForCase(db, 999999, [passivoParty])
    expect(getPartiesByCase(db, sample.idProcessoTrf)).toHaveLength(1)
  })
})

describe('movements repository', () => {
  beforeEach(() => {
    upsertCase(db, sample)
  })

  const movements = [
    { position: 0, timestamp: '31/08/2026 14:29:45', description: 'Conclusos para julgamento' },
    { position: 1, timestamp: '25/08/2026 09:49:53', description: 'Distribuído por sorteio' },
  ]

  it('round-trips movements in the page\'s own order', () => {
    replaceMovementsForCase(db, sample.idProcessoTrf, movements)
    const got = getMovementsByCase(db, sample.idProcessoTrf)
    expect(got).toEqual(movements.map((m) => ({ idProcessoTrf: sample.idProcessoTrf, ...m })))
  })

  it('replaces the whole log on a re-run instead of duplicating it', () => {
    replaceMovementsForCase(db, sample.idProcessoTrf, movements)
    replaceMovementsForCase(db, sample.idProcessoTrf, [movements[0]!])
    expect(getMovementsByCase(db, sample.idProcessoTrf)).toHaveLength(1)
  })

  it('preserves a repeated identical description as two separate rows, ordered by position', () => {
    const repeated = [
      { position: 0, timestamp: '11/06/2026 00:02:19', description: 'Recebidos os autos' },
      { position: 1, timestamp: '11/06/2026 00:02:18', description: 'Recebidos os autos' },
    ]
    replaceMovementsForCase(db, sample.idProcessoTrf, repeated)
    expect(getMovementsByCase(db, sample.idProcessoTrf).map((m) => m.position)).toEqual([0, 1])
  })

  it('only lists movements belonging to the requested case', () => {
    upsertCase(db, { ...sample, idProcessoTrf: 999999, number: '0000002-22.2026.4.05.0000' })
    replaceMovementsForCase(db, sample.idProcessoTrf, movements)
    replaceMovementsForCase(db, 999999, [movements[0]!])
    expect(getMovementsByCase(db, sample.idProcessoTrf)).toHaveLength(2)
  })
})

describe('documents repository', () => {
  const binaryDoc = {
    idProcessoDocumento: 12284583,
    idProcessoTrf: 130100,
    idBin: 12039033,
    numeroDocumento: '4caf3e2af32f9130b384fc0c2aef62251e2b3823',
    label: '24/07/2025 20:30:45 - Despacho (Despacho)',
    docType: 'Despacho',
    docDate: '24/07/2025 20:30:45',
    pdfKey: '2016/0801438-34.2016.4.05.8102/documents/2025-07-24-Despacho.pdf',
    textContent: null,
  }

  const htmlDoc = {
    idProcessoDocumento: 12284587,
    idProcessoTrf: 130100,
    idBin: null,
    numeroDocumento: null,
    label: '13/02/2026 14:32:27 - Despacho (Despacho)',
    docType: 'Despacho',
    docDate: '13/02/2026 14:32:27',
    pdfKey: null,
    textContent: '<html>the judicial act</html>',
  }

  beforeEach(() => {
    upsertCase(db, sample)
  })

  it('round-trips a binary document, unmarked as downloaded until upserted', () => {
    expect(isDocumentDownloaded(db, binaryDoc.idProcessoDocumento)).toBe(false)
    upsertDocument(db, binaryDoc)
    expect(isDocumentDownloaded(db, binaryDoc.idProcessoDocumento)).toBe(true)
    const [got] = getDocumentsByCase(db, sample.idProcessoTrf)
    expect(got).toMatchObject({ idBin: binaryDoc.idBin, pdfKey: binaryDoc.pdfKey, textContent: null })
    expect(got!.downloadedAt).not.toBeNull()
  })

  it('round-trips an HTML document with text content instead of a blob key', () => {
    upsertDocument(db, htmlDoc)
    const [got] = getDocumentsByCase(db, sample.idProcessoTrf)
    expect(got).toMatchObject({ idBin: null, pdfKey: null, textContent: htmlDoc.textContent })
  })

  it('lists only documents belonging to the requested case', () => {
    upsertCase(db, { ...sample, idProcessoTrf: 999999, number: '0000002-22.2026.4.05.0000' })
    upsertDocument(db, binaryDoc)
    upsertDocument(db, { ...htmlDoc, idProcessoTrf: 999999, idProcessoDocumento: 1 })
    expect(getDocumentsByCase(db, sample.idProcessoTrf)).toHaveLength(1)
  })

  it('is idempotent — upserting the same document id twice keeps one row', () => {
    upsertDocument(db, binaryDoc)
    upsertDocument(db, binaryDoc)
    expect(getDocumentsByCase(db, sample.idProcessoTrf)).toHaveLength(1)
  })
})

describe('probes repository', () => {
  it('records misses and counts repeat attempts', () => {
    recordProbe(db, 999, 'not_found')
    recordProbe(db, 999, 'not_found')
    const row = db.prepare('SELECT attempts FROM probes WHERE id_processo_trf = 999')
      .get() as { attempts: number }
    expect(row!.attempts).toBe(2)
  })

  it('returns probed ids as a set', () => {
    recordProbe(db, 1, 'not_found')
    recordProbe(db, 2, 'not_found')
    expect(getProbedIds(db)).toEqual(new Set([1, 2]))
  })
})

describe('failures repository', () => {
  it('records a failure and lists it as unresolved', () => {
    recordFailure(db, 'summary_pdf', '130100', 'RateLimitedError')
    const rows = listFailures(db, { unresolvedOnly: true })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.ref).toBe('130100')
    expect(rows[0]!.attempts).toBe(1)
  })

  it('increments attempts when the same reference fails again', () => {
    recordFailure(db, 'summary_pdf', '130100', 'first')
    recordFailure(db, 'summary_pdf', '130100', 'second')
    const rows = listFailures(db, { unresolvedOnly: true })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.attempts).toBe(2)
  })
})

describe('FsBlobStore', () => {
  it('stores and reads a blob by key, creating directories', async () => {
    const store = new FsBlobStore(dir)
    await store.put('a/b/c.pdf', Buffer.from('%PDF-1.4'))
    expect(await store.exists('a/b/c.pdf')).toBe(true)
    expect((await store.get('a/b/c.pdf')).toString()).toBe('%PDF-1.4')
  })

  it('reports a missing key as absent', async () => {
    expect(await new FsBlobStore(dir).exists('nope.pdf')).toBe(false)
  })

  it('still allows an ordinary nested key', async () => {
    const store = new FsBlobStore(dir)
    const key = '2026/0013475-36.2026.4.05.0000/summary.pdf'
    await store.put(key, Buffer.from('%PDF-1.4'))
    expect(await store.exists(key)).toBe(true)
  })

  it('rejects a key of plain ../escape.txt', async () => {
    const store = new FsBlobStore(dir)
    await expect(store.put('../escape.txt', Buffer.from('x'))).rejects.toThrow()
  })

  it('rejects an absolute-path key', async () => {
    const store = new FsBlobStore(dir)
    await expect(store.put('/etc/passwot', Buffer.from('x'))).rejects.toThrow()
  })

  it('rejects a key that escapes into a sibling directory sharing the root name as a prefix', async () => {
    // dir is something like /tmp/pje-test-XXXXXX; a sibling dir whose name
    // merely starts with that same string must not be reachable.
    const store = new FsBlobStore(dir)
    const key = `../${dir.split('/').pop()}-evil/secret.txt`
    await expect(store.put(key, Buffer.from('x'))).rejects.toThrow()
  })
})

describe('a failure remembers which case it belongs to', () => {
  /**
   * Without this a document failure can be read but not retried. Its `ref` is
   * the document's own id, and for an unrecognised link that is a synthetic
   * hash of the href — it names nothing anybody can act on. The case was known
   * at the moment of recording; keeping it is the difference between a list of
   * complaints and a list of jobs to re-run.
   */
  it('stores the case beside the failure', () => {
    recordFailure(db, 'document', '999', 'unrecognised link', 130105)
    const [row] = listFailures(db, { unresolvedOnly: true })
    expect(row!.idProcessoTrf).toBe(130105)
  })

  it('leaves it null for a failure that is about no case in particular', () => {
    recordFailure(db, 'summary_pdf', '42', 'no case number in the PDF text')
    const [row] = listFailures(db, { unresolvedOnly: true })
    expect(row!.idProcessoTrf).toBeNull()
  })

  it('keeps the case a later retry no longer knows', () => {
    // A second attempt that fails for a reason with no case attached must not
    // erase what the first one did know.
    recordFailure(db, 'document', '999', 'unrecognised link', 130105)
    recordFailure(db, 'document', '999', 'timed out')
    const [row] = listFailures(db, { unresolvedOnly: true })
    expect(row!.idProcessoTrf).toBe(130105)
    expect(row!.attempts).toBe(2)
  })
})
