import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openDatabase, upsertCase, getCaseByNumber, getCaseById, getMaxCaseId,
  recordProbe, getProbedIds, recordFailure, listFailures, FsBlobStore,
  DuplicateCaseNumberError,
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
})

describe('probes repository', () => {
  it('records misses and counts repeat attempts', () => {
    recordProbe(db, 999, 'not_found')
    recordProbe(db, 999, 'not_found')
    const row = db.prepare('SELECT attempts FROM probes WHERE id_processo_trf = 999')
      .get() as { attempts: number }
    expect(row!.attempts).toBe(2)
  })

  it('returns probed ids as a set for crawl skipping', () => {
    recordProbe(db, 1, 'not_found')
    recordProbe(db, 2, 'secret')
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
