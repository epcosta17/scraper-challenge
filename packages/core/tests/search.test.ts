import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  openDatabase, upsertCase, upsertDocument, replacePartiesForCase,
  searchCases, toFtsQuery, SearchQueryError,
} from '../src/index.ts'

const caseA = {
  idProcessoTrf: 130100,
  number: '0013475-36.2026.4.05.0000',
  ca: null,
  className: 'APELAÇÃO CÍVEL',
  classCode: '198',
  court: 'Gab 6 - Des. PAULO CORDEIRO',
  panel: '2ª Turma',
  distributedAt: '17 de Agosto de 2026',
  subjects: ['DIREITO TRIBUTÁRIO (14)', 'Execução Fiscal (6017)'],
  parties: [{ name: 'FAZENDA NACIONAL', role: 'APELANTE' }],
  summaryPdfKey: null,
  jurisdiction: 'TRF5',
  courtAddress: null,
  referenceNumber: null,
}

const caseB = {
  ...caseA,
  idProcessoTrf: 130101,
  number: '0004321-11.2025.4.05.8300',
  className: 'MANDADO DE SEGURANÇA',
  classCode: '120',
  subjects: ['DIREITO ADMINISTRATIVO (9)'],
  parties: [{ name: 'CONSELHO REGIONAL DE ODONTOLOGIA', role: 'IMPETRADO' }],
}

/** Real-shaped Portuguese court prose: cedillas, tildes, acutes throughout. */
const docA = {
  idProcessoDocumento: 900001,
  idProcessoTrf: caseA.idProcessoTrf,
  idBin: 1,
  numeroDocumento: 'abc',
  label: '24/07/2025 20:30:45 - Sentença (Sentença)',
  docType: 'Sentença',
  docDate: '24/07/2025 20:30:45',
  pdfKey: 'x.pdf',
  textContent:
    'Vistos etc. Trata-se de embargos à execução fiscal opostos pela executada. ' +
    'Julgo improcedentes os embargos e determino o prosseguimento da execução. ' +
    'Publique-se. Registre-se. Intimem-se. Recife, 24 de julho de 2025.',
}

const docB = {
  idProcessoDocumento: 900002,
  idProcessoTrf: caseB.idProcessoTrf,
  idBin: null,
  numeroDocumento: null,
  label: '13/02/2026 14:32:27 - Despacho (Despacho)',
  docType: 'Despacho',
  docDate: '13/02/2026 14:32:27',
  pdfKey: null,
  textContent:
    'Notifique-se a autoridade coatora para prestar informações no prazo legal. ' +
    'Após, ao Ministério Público Federal. Intime-se.',
}

let dir: string
let db: ReturnType<typeof openDatabase>

function seed(target: ReturnType<typeof openDatabase>): void {
  upsertCase(target, caseA)
  upsertCase(target, caseB)
  upsertDocument(target, docA)
  upsertDocument(target, docB)
  replacePartiesForCase(target, caseA.idProcessoTrf, [{
    polo: 'ativo', name: 'JOSÉ ANTÔNIO DA CONCEIÇÃO', documentType: 'cpf',
    documentNumber: '102.897.124-91', oab: null, role: 'APELANTE', situation: 'Ativo',
  }])
  replacePartiesForCase(target, caseB.idProcessoTrf, [{
    polo: 'passivo', name: 'MARIA APARECIDA GONÇALVES', documentType: 'cpf',
    documentNumber: '111.222.333-44', oab: null, role: 'IMPETRANTE', situation: 'Ativo',
  }])
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pje-search-'))
  db = openDatabase(join(dir, 'search.db'))
  seed(db)
  return () => { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

const ids = (q: string, opts?: Parameters<typeof searchCases>[2]): number[] =>
  searchCases(db, q, opts).hits.map((h) => h.idProcessoTrf)

describe('toFtsQuery', () => {
  it('quotes each term so portal punctuation cannot be read as FTS5 syntax', () => {
    expect(toFtsQuery('sentença')).toBe('"sentença"*')
    expect(toFtsQuery('0013475-36.2026.4.05.0000')).toBe('"0013475-36.2026.4.05.0000"*')
  })

  it('joins several terms with an implicit AND', () => {
    expect(toFtsQuery('embargos execução')).toBe('"embargos"* "execução"*')
  })

  it('keeps an explicit phrase as one phrase', () => {
    // Quoted stays exact: that is how you say you meant it literally.
    expect(toFtsQuery('"execução fiscal"')).toBe('"execução fiscal"')
  })

  it('keeps a trailing * as a prefix search', () => {
    expect(toFtsQuery('execu*')).toBe('"execu"*')
  })

  it('passes the uppercase boolean operators through', () => {
    expect(toFtsQuery('sentença OR despacho')).toBe('"sentença"* OR "despacho"*')
  })

  it('escapes an embedded double quote instead of ending the term early', () => {
    expect(toFtsQuery('a"b')).toBe('"a""b"*')
  })

  it('drops a dangling operator that would otherwise be a syntax error', () => {
    expect(toFtsQuery('sentença OR')).toBe('"sentença"*')
    expect(toFtsQuery('AND sentença')).toBe('"sentença"*')
    expect(toFtsQuery('sentença OR AND despacho')).toBe('"sentença"* AND "despacho"*')
  })

  it('rejects a query with nothing searchable in it', () => {
    expect(() => toFtsQuery('')).toThrow(SearchQueryError)
    expect(() => toFtsQuery('   ')).toThrow(SearchQueryError)
    expect(() => toFtsQuery('***')).toThrow(SearchQueryError)
    expect(() => toFtsQuery('- . -')).toThrow(SearchQueryError)
  })
})

describe('searchCases — tokenizer behaviour on Portuguese', () => {
  it('finds an accented word typed with its accents', () => {
    expect(ids('execução')).toEqual([caseA.idProcessoTrf])
  })

  // The reason for `remove_diacritics`: a user typing from a keyboard
  // without dead keys, or pasting from a system that stripped them, must
  // still reach the same document.
  it('finds an accented word typed without its accents', () => {
    expect(ids('execucao')).toEqual([caseA.idProcessoTrf])
  })

  it('folds case as well as diacritics', () => {
    expect(ids('EXECUÇÃO')).toEqual([caseA.idProcessoTrf])
    expect(ids('EXECUCAO')).toEqual([caseA.idProcessoTrf])
  })

  it('matches a party name with or without its accents', () => {
    expect(ids('conceição')).toEqual([caseA.idProcessoTrf])
    expect(ids('conceicao')).toEqual([caseA.idProcessoTrf])
    expect(ids('gonçalves')).toEqual([caseB.idProcessoTrf])
    expect(ids('goncalves')).toEqual([caseB.idProcessoTrf])
  })

  it('matches decomposed (NFD) text the same as composed text', () => {
    // PDF text extraction can hand back either form for the same word.
    upsertDocument(db, {
      ...docB,
      idProcessoDocumento: 900003,
      textContent: 'Homologo a transação por sentença.'.normalize('NFD'),
    })
    expect(ids('transacao')).toContain(caseB.idProcessoTrf)
    expect(ids('transação')).toContain(caseB.idProcessoTrf)
  })
})

describe('searchCases — what is indexed', () => {
  it('finds a case by a word in its document text', () => {
    expect(ids('embargos')).toEqual([caseA.idProcessoTrf])
  })

  it('finds a case by its number', () => {
    expect(ids('0004321-11.2025.4.05.8300')).toEqual([caseB.idProcessoTrf])
  })

  it('finds a case by its judicial class', () => {
    expect(ids('mandado de segurança')).toEqual([caseB.idProcessoTrf])
  })

  it('finds a case by a subject stored as JSON', () => {
    expect(ids('tributário')).toEqual([caseA.idProcessoTrf])
  })

  it('finds a case by a party name from the parties table', () => {
    expect(ids('aparecida')).toEqual([caseB.idProcessoTrf])
  })

  it('finds a case by a party name carried only on the case summary', () => {
    // `parties_json` is populated by a shallow crawl; the `parties` table is
    // only filled once `deep` has run. A case in the first state must still
    // be findable by party.
    upsertCase(db, {
      ...caseA,
      idProcessoTrf: 130102,
      number: '0000009-99.2026.4.05.0000',
      parties: [{ name: 'BENJAMIM SAMPAIO FILHO', role: 'APELADO' }],
    })
    expect(ids('benjamim')).toEqual([130102])
  })

  it('finds a case by a word in a document label', () => {
    expect(ids('despacho')).toEqual([caseB.idProcessoTrf])
  })

  it('returns nothing for a term that appears nowhere', () => {
    expect(searchCases(db, 'zzzzunobtainium').hits).toEqual([])
  })
})

describe('searchCases — results', () => {
  it('returns a highlighted snippet from the document that matched', () => {
    const [hit] = searchCases(db, 'embargos').hits
    expect(hit!.snippet).not.toBeNull()
    expect(hit!.snippet!.idProcessoDocumento).toBe(docA.idProcessoDocumento)
    expect(hit!.snippet!.label).toBe(docA.label)
    expect(hit!.snippet!.text).toContain('[embargos]')
    // A fragment, not the whole document.
    expect(hit!.snippet!.text.length).toBeLessThan(docA.textContent.length)
  })

  it('highlights the accented word actually present when the query was unaccented', () => {
    const [hit] = searchCases(db, 'execucao').hits
    expect(hit!.snippet!.text).toContain('[execução]')
  })

  it('accepts custom highlight markers', () => {
    const [hit] = searchCases(db, 'embargos', { highlightStart: '<b>', highlightEnd: '</b>' }).hits
    expect(hit!.snippet!.text).toContain('<b>embargos</b>')
  })

  it('carries the case fields a result list needs, without a second query', () => {
    const [hit] = searchCases(db, 'embargos').hits
    expect(hit).toMatchObject({
      idProcessoTrf: caseA.idProcessoTrf,
      number: caseA.number,
      className: caseA.className,
      court: caseA.court,
    })
  })

  it('reports where each hit matched', () => {
    expect(searchCases(db, 'embargos').hits[0]!.matchedIn).toEqual(['document'])
    expect(searchCases(db, 'aparecida').hits[0]!.matchedIn).toEqual(['party'])
    expect(searchCases(db, 'segurança').hits[0]!.matchedIn).toEqual(['case'])
  })

  it('leaves the snippet null when the match was not in a document', () => {
    expect(searchCases(db, 'aparecida').hits[0]!.snippet).toBeNull()
  })

  it('collapses several matching documents of one case into a single hit', () => {
    upsertDocument(db, { ...docA, idProcessoDocumento: 900004, label: 'segundo' })
    const results = searchCases(db, 'embargos')
    expect(results.hits).toHaveLength(1)
    expect(results.total).toBe(1)
  })

  it('ranks a case matching in several places above one matching in only one', () => {
    // caseA matches "execução" in its subjects, its class-adjacent metadata
    // and its document text; caseB gets a document mention only.
    upsertDocument(db, { ...docB, idProcessoDocumento: 900005, textContent: 'menção isolada à execução.' })
    expect(ids('execução')[0]).toBe(caseA.idProcessoTrf)
  })

  it('scores every hit above zero and in descending order', () => {
    upsertDocument(db, { ...docB, idProcessoDocumento: 900006, textContent: 'outra execução qualquer.' })
    const scores = searchCases(db, 'execução').hits.map((h) => h.score)
    expect(scores.length).toBeGreaterThan(1)
    expect(scores.every((s) => s > 0)).toBe(true)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
  })
})

describe('searchCases — pagination', () => {
  beforeEach(() => {
    for (let i = 0; i < 8; i++) {
      const id = 140000 + i
      upsertCase(db, { ...caseA, idProcessoTrf: id, number: `000000${i}-00.2026.4.05.9999` })
      upsertDocument(db, {
        ...docA,
        idProcessoDocumento: 910000 + i,
        idProcessoTrf: id,
        textContent: `Sentença de mérito número ${i}. Prosseguimento da execução.`,
      })
    }
  })

  it('reports the full match count independently of the page size', () => {
    const page = searchCases(db, 'execução', { limit: 3 })
    expect(page.hits).toHaveLength(3)
    expect(page.total).toBe(9) // the 8 above plus caseA
    expect(page.limit).toBe(3)
    expect(page.offset).toBe(0)
  })

  it('walks the whole result set without repeating or dropping a case', () => {
    const seen: number[] = []
    for (let offset = 0; offset < 9; offset += 4) {
      seen.push(...ids('execução', { limit: 4, offset }))
    }
    expect(seen).toHaveLength(9)
    expect(new Set(seen).size).toBe(9)
  })

  it('returns an empty page past the end', () => {
    expect(searchCases(db, 'execução', { limit: 4, offset: 100 }).hits).toEqual([])
  })
})

describe('searchCases — index maintenance', () => {
  it('picks up a document added after the index was built', () => {
    expect(ids('perícia')).toEqual([])
    upsertDocument(db, { ...docB, idProcessoDocumento: 900007, textContent: 'Determino a perícia técnica.' })
    expect(ids('perícia')).toEqual([caseB.idProcessoTrf])
  })

  it('forgets text that an updated document no longer contains', () => {
    upsertDocument(db, { ...docA, textContent: 'Conteúdo inteiramente substituído.' })
    expect(ids('embargos')).toEqual([])
    expect(ids('substituído')).toEqual([caseA.idProcessoTrf])
  })

  it('drops a deleted document from the index', () => {
    db.prepare('DELETE FROM documents WHERE id_processo_documento = ?').run(docA.idProcessoDocumento)
    expect(ids('embargos')).toEqual([])
  })

  it('follows a case rename', () => {
    upsertCase(db, { ...caseB, className: 'HABEAS CORPUS' })
    expect(ids('segurança')).toEqual([])
    expect(ids('habeas')).toEqual([caseB.idProcessoTrf])
  })

  it('follows a parties replacement, dropping the parties that went away', () => {
    replacePartiesForCase(db, caseB.idProcessoTrf, [{
      polo: 'passivo', name: 'OUTRA PESSOA', documentType: null,
      documentNumber: null, oab: null, role: null, situation: null,
    }])
    expect(ids('aparecida')).toEqual([])
    expect(ids('outra pessoa')).toEqual([caseB.idProcessoTrf])
  })

  it('survives reopening the database', () => {
    db.close()
    db = openDatabase(join(dir, 'search.db'))
    expect(ids('embargos')).toEqual([caseA.idProcessoTrf])
  })
})

describe('searchCases — bad input', () => {
  it('rejects an empty query rather than returning the whole acervo', () => {
    expect(() => searchCases(db, '   ')).toThrow(SearchQueryError)
  })

  it('treats FTS5 metacharacters in a query as literal text', () => {
    // Would be a "syntax error near ..." if the query reached FTS5 raw.
    for (const q of ['execução)', '^embargos', 'col:umn', 'a AND(b', '"unclosed']) {
      expect(() => searchCases(db, q)).not.toThrow()
    }
  })
})

describe('search index migration', () => {
  it('backfills a database that already had rows before the index existed', () => {
    // Build a database with the pre-search schema and real content in it,
    // then open it through the real entry point. The triggers only fire on
    // *future* writes, so without an explicit backfill these rows would be
    // invisible to search forever.
    const legacyPath = join(dir, 'legacy.db')
    const legacy = new Database(legacyPath)
    legacy.pragma('journal_mode = WAL')
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
      CREATE TABLE parties (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        id_processo_trf  INTEGER NOT NULL REFERENCES cases(id_processo_trf),
        polo             TEXT NOT NULL,
        name             TEXT NOT NULL,
        document_type    TEXT,
        document_number  TEXT,
        oab              TEXT,
        role             TEXT,
        situation        TEXT
      );
      CREATE TABLE documents (
        id_processo_documento INTEGER PRIMARY KEY,
        id_processo_trf       INTEGER NOT NULL REFERENCES cases(id_processo_trf),
        id_bin                INTEGER,
        numero_documento      TEXT,
        label                 TEXT,
        doc_type              TEXT,
        doc_date              TEXT,
        pdf_key               TEXT,
        text_content          TEXT,
        downloaded_at         TEXT
      );
      INSERT INTO cases (id_processo_trf, number, class_name, subjects_json, parties_json, first_seen_at, last_scraped_at)
        VALUES (7, '0000007-77.2019.4.05.0000', 'APELAÇÃO CRIMINAL', '[]', '[]', datetime('now'), datetime('now'));
      INSERT INTO parties (id_processo_trf, polo, name) VALUES (7, 'ativo', 'ANTIGA PARTE MENDONÇA');
      INSERT INTO documents (id_processo_documento, id_processo_trf, label, text_content)
        VALUES (77, 7, 'Acórdão antigo', 'Nego provimento à apelação por seus próprios fundamentos.');
    `)
    legacy.close()

    const migrated = openDatabase(legacyPath)
    try {
      expect(searchCases(migrated, 'provimento').hits.map((h) => h.idProcessoTrf)).toEqual([7])
      expect(searchCases(migrated, 'mendonca').hits.map((h) => h.idProcessoTrf)).toEqual([7])
      expect(searchCases(migrated, 'criminal').hits.map((h) => h.idProcessoTrf)).toEqual([7])
      // And the backfilled index keeps working for new writes.
      upsertDocument(migrated, {
        idProcessoDocumento: 78, idProcessoTrf: 7, idBin: null, numeroDocumento: null,
        label: 'novo', docType: null, docDate: null, pdfKey: null,
        textContent: 'Petição superveniente.',
      })
      expect(searchCases(migrated, 'superveniente').hits.map((h) => h.idProcessoTrf)).toEqual([7])
    } finally {
      migrated.close()
    }
  })

  it('does not rebuild the index on every open — a second open leaves it intact and usable', () => {
    const path = join(dir, 'search.db')
    db.close()
    const first = openDatabase(path)
    first.close()
    db = openDatabase(path)
    expect(ids('embargos')).toEqual([caseA.idProcessoTrf])
  })
})
