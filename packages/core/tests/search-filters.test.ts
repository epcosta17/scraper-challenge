import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openDatabase, upsertCase, upsertDocument, replacePartiesForCase,
  searchAcervo, searchCases, listCaseClasses, listOabStates,
  SearchQueryError, SearchFilterError,
} from '../src/index.ts'

/**
 * The eight criteria of the portal's own form, answered against the captured
 * acervo instead of against the portal. The fixture is shaped like the real
 * thing: a lawyer is a `parties` row with `role = 'ADVOGADO'` and an `oab` of
 * `UF + number`, everybody else carries a CPF or a CNPJ, and a distribution
 * date is the Portuguese long form the case PDF prints.
 */

const base = {
  ca: null,
  classCode: null,
  panel: null,
  subjects: [],
  parties: [],
  summaryPdfKey: null,
  jurisdiction: 'TRF5',
  courtAddress: null,
}

const caseA = {
  ...base,
  idProcessoTrf: 130200,
  number: '0005425-26.2026.4.05.8308',
  className: 'APELAÇÃO CÍVEL',
  court: 'Gab 10 - Des. RUBENS CANUTO',
  distributedAt: '22 de Agosto de 2026',
  referenceNumber: '0005425-26.2026.4.05.8308',
}

const caseB = {
  ...base,
  idProcessoTrf: 130201,
  number: '0009986-11.2026.4.05.8400',
  className: 'REMESSA NECESSÁRIA CÍVEL',
  court: 'Gab 8 - Des. FERNANDO BRAGA',
  distributedAt: '17 de Agosto de 2026',
  referenceNumber: '0009986-11.2026.4.05.8400',
}

/** No distribution date at all, and a reference number that is *not* its own. */
const caseC = {
  ...base,
  idProcessoTrf: 130202,
  number: '0013478-88.2026.4.05.0000',
  className: 'AGRAVO DE INSTRUMENTO',
  court: 'Gab 23 - Des. RODRIGO TENÓRIO',
  distributedAt: null,
  referenceNumber: '0807485-94.2025.4.05.8300',
}

/** The other stored shape of a date: already numeric, as some pages print it. */
const caseD = {
  ...base,
  idProcessoTrf: 130203,
  number: '0011919-19.2026.4.05.8400',
  className: 'REMESSA NECESSÁRIA CÍVEL',
  court: 'Gab 27 - Desa. ISABELLE MARNE',
  distributedAt: '03/09/2026',
  referenceNumber: null,
}

let dir: string
let db: ReturnType<typeof openDatabase>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pje-filters-'))
  db = openDatabase(join(dir, 'test.db'))
  for (const c of [caseA, caseB, caseC, caseD]) upsertCase(db, c)

  replacePartiesForCase(db, caseA.idProcessoTrf, [
    { polo: 'ativo', name: 'APOLIANO PEREIRA GONCALVES', documentType: 'cpf', documentNumber: '100.620.724-47', oab: '', role: 'APELANTE', situation: 'Ativo' },
    { polo: 'ativo', name: 'JOÃO PAULO DOURADO CARDOSO', documentType: 'cpf', documentNumber: '070.380.935-09', oab: 'PE63982', role: 'ADVOGADO', situation: 'Ativo' },
    { polo: 'passivo', name: 'CONSELHO REGIONAL DE EDUCACAO FISICA DA 12 REGIAO/PERNAMBUCO - CREF12/PE', documentType: 'cnpj', documentNumber: '03.956.986/0001-66', oab: '', role: 'APELADO', situation: 'Ativo' },
  ])
  replacePartiesForCase(db, caseB.idProcessoTrf, [
    { polo: 'ativo', name: 'RUZY KELLY GOMES DA CUNHA', documentType: 'cpf', documentNumber: '838.782.384-87', oab: '', role: 'PARTE AUTORA', situation: 'Ativo' },
    { polo: 'ativo', name: 'ÂNGELO RONCALLI DAMASCENO SOARES', documentType: 'cpf', documentNumber: '011.542.984-00', oab: 'RN5987', role: 'ADVOGADO', situation: 'Ativo' },
    { polo: 'passivo', name: 'INSTITUTO NACIONAL DO SEGURO SOCIAL - INSS', documentType: 'cnpj', documentNumber: '29.979.036/0042-19', oab: '', role: 'PARTE RE', situation: 'Ativo' },
  ])

  upsertDocument(db, {
    idProcessoDocumento: 910001,
    idProcessoTrf: caseA.idProcessoTrf,
    idBin: 1,
    numeroDocumento: null,
    label: '24/07/2026 20:30:45 - Sentença (Sentença)',
    docType: 'Sentença',
    docDate: '24/07/2026 20:30:45',
    pdfKey: null,
    textContent: 'Julgo procedente o pedido e reconheço a prescrição da anuidade cobrada pelo conselho.',
  })
  upsertDocument(db, {
    idProcessoDocumento: 910002,
    idProcessoTrf: caseB.idProcessoTrf,
    idBin: null,
    numeroDocumento: null,
    label: '13/02/2026 14:32:27 - Despacho (Despacho)',
    docType: 'Despacho',
    docDate: '13/02/2026 14:32:27',
    pdfKey: null,
    textContent: 'Remetam-se os autos ao Tribunal para reexame necessário. Intime-se.',
  })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const numbers = (r: { hits: Array<{ number: string }> }): string[] => r.hits.map((h) => h.number)

describe('searchAcervo — one criterion at a time', () => {
  it('matches a case number exactly, and only that one', () => {
    expect(numbers(searchAcervo(db, { filters: { number: caseB.number } }))).toEqual([caseB.number])
    expect(searchAcervo(db, { filters: { number: '0009986-11' } }).total).toBe(0)
  })

  it('matches a reference number, which is not always the case\'s own number', () => {
    expect(numbers(searchAcervo(db, { filters: { reference: '0807485-94.2025.4.05.8300' } })))
      .toEqual([caseC.number])
  })

  it('matches a judicial class by substring, ignoring case and accents', () => {
    for (const written of ['REMESSA NECESSÁRIA CÍVEL', 'remessa necessaria', 'NECESSARIA']) {
      expect(numbers(searchAcervo(db, { filters: { class: written } })).sort())
        .toEqual([caseB.number, caseD.number].sort())
    }
  })

  it('matches a party by name and never answers with a lawyer', () => {
    expect(numbers(searchAcervo(db, { filters: { party: 'apoliano pereira' } }))).toEqual([caseA.number])
    // JOÃO PAULO is a lawyer on caseA: the party field must not find him.
    expect(searchAcervo(db, { filters: { party: 'joao paulo' } }).total).toBe(0)
  })

  it('matches a lawyer by name, written without its accents', () => {
    expect(numbers(searchAcervo(db, { filters: { lawyer: 'angelo roncalli' } }))).toEqual([caseB.number])
    // RUZY KELLY is a party on caseB, not its lawyer.
    expect(searchAcervo(db, { filters: { lawyer: 'ruzy kelly' } }).total).toBe(0)
  })

  it('matches a CPF or a CNPJ however it is punctuated', () => {
    for (const written of ['838.782.384-87', '83878238487', ' 838.782.384-87 ']) {
      expect(numbers(searchAcervo(db, { filters: { document: written } }))).toEqual([caseB.number])
    }
    expect(numbers(searchAcervo(db, { filters: { document: '29979036004219', documentType: 'cnpj' } })))
      .toEqual([caseB.number])
  })

  it('honours the document type: the same digits under the wrong type match nothing', () => {
    expect(searchAcervo(db, { filters: { document: '838.782.384-87', documentType: 'cnpj' } }).total).toBe(0)
  })

  it('matches an OAB number with or without its state', () => {
    expect(numbers(searchAcervo(db, { filters: { oab: '5987' } }))).toEqual([caseB.number])
    expect(numbers(searchAcervo(db, { filters: { oab: '5987', oabState: 'rn' } }))).toEqual([caseB.number])
    expect(numbers(searchAcervo(db, { filters: { oab: 'PE63982' } }))).toEqual([caseA.number])
    expect(searchAcervo(db, { filters: { oab: '5987', oabState: 'PE' } }).total).toBe(0)
  })

  it('matches a distribution date range across both stored spellings', () => {
    expect(numbers(searchAcervo(db, { filters: { from: '17/08/2026', to: '22/08/2026' } })).sort())
      .toEqual([caseA.number, caseB.number].sort())
    expect(numbers(searchAcervo(db, { filters: { from: '18/08/2026' } })).sort())
      .toEqual([caseA.number, caseD.number].sort())
    expect(numbers(searchAcervo(db, { filters: { to: '17/08/2026' } }))).toEqual([caseB.number])
    // The numeric spelling is understood too.
    expect(numbers(searchAcervo(db, { filters: { from: '01/09/2026' } }))).toEqual([caseD.number])
  })

  it('leaves a case with no distribution date out of every range', () => {
    expect(numbers(searchAcervo(db, { filters: { from: '01/01/1990', to: '31/12/2099' } })))
      .not.toContain(caseC.number)
  })
})

describe('searchAcervo — criteria combined', () => {
  it('ANDs two filters', () => {
    expect(numbers(searchAcervo(db, { filters: { class: 'remessa', from: '01/08/2026', to: '31/08/2026' } })))
      .toEqual([caseB.number])
    expect(searchAcervo(db, { filters: { class: 'apelacao', lawyer: 'angelo roncalli' } }).total).toBe(0)
  })

  it('ANDs a filter with the full-text query', () => {
    expect(numbers(searchAcervo(db, { text: 'prescrição', filters: { class: 'apelacao' } })))
      .toEqual([caseA.number])
    expect(searchAcervo(db, { text: 'prescrição', filters: { class: 'remessa' } }).total).toBe(0)
  })

  it('keeps the ranking and the snippet a text query earns', () => {
    const result = searchAcervo(db, { text: 'prescricao', filters: { party: 'apoliano' } })
    expect(result.hits[0]?.matchedIn).toContain('document')
    expect(result.hits[0]?.snippet?.text).toContain('prescrição')
    expect(result.ftsQuery).toBe('"prescricao"')
  })

  it('reports no match through the text index when only filters ran', () => {
    const result = searchAcervo(db, { filters: { number: caseA.number } })
    expect(result.hits[0]?.matchedIn).toEqual([])
    expect(result.hits[0]?.snippet).toBeNull()
    expect(result.ftsQuery).toBe('')
  })

  it('counts the whole filtered set, not just the page', () => {
    const page = searchAcervo(db, { filters: { class: 'remessa' } }, { limit: 1 })
    expect(page.total).toBe(2)
    expect(page.hits).toHaveLength(1)
    const second = searchAcervo(db, { filters: { class: 'remessa' } }, { limit: 1, offset: 1 })
    expect(second.total).toBe(2)
    expect(numbers(second)).not.toEqual(numbers(page))
  })
})

describe('searchAcervo — what it refuses to answer', () => {
  it('refuses a search with neither text nor a filter rather than returning the acervo', () => {
    expect(() => searchAcervo(db, {})).toThrow(SearchQueryError)
    expect(() => searchAcervo(db, { text: '   ', filters: { party: '  ' } })).toThrow(SearchQueryError)
  })

  it('refuses an OAB state with no OAB number, which the portal ignores in silence', () => {
    expect(() => searchAcervo(db, { filters: { oabState: 'PE' } })).toThrow(SearchFilterError)
  })

  it('refuses a date that is not dd/mm/yyyy', () => {
    expect(() => searchAcervo(db, { filters: { from: '2026-08-17' } })).toThrow(SearchFilterError)
    expect(() => searchAcervo(db, { filters: { to: '31/13/2026' } })).toThrow(SearchFilterError)
  })

  it('refuses a range that ends before it starts', () => {
    expect(() => searchAcervo(db, { filters: { from: '22/08/2026', to: '17/08/2026' } }))
      .toThrow(SearchFilterError)
  })

  it('treats a wildcard typed into a filter as text, not as a pattern', () => {
    expect(searchAcervo(db, { filters: { class: '%' } }).total).toBe(0)
    expect(searchAcervo(db, { filters: { party: '_' } }).total).toBe(0)
  })
})

describe('searchCases still answers exactly as it did', () => {
  it('is the text-only case of the same query', () => {
    expect(numbers(searchCases(db, 'prescricao'))).toEqual([caseA.number])
    expect(() => searchCases(db, '***')).toThrow(SearchQueryError)
  })
})

describe('listCaseClasses', () => {
  it('lists the classes actually present, with their counts, most cases first', () => {
    expect(listCaseClasses(db)).toEqual([
      { className: 'REMESSA NECESSÁRIA CÍVEL', caseCount: 2 },
      { className: 'AGRAVO DE INSTRUMENTO', caseCount: 1 },
      { className: 'APELAÇÃO CÍVEL', caseCount: 1 },
    ])
  })
})

describe('listOabStates', () => {
  it('lists the UFs the stored OAB registrations actually carry', () => {
    expect(listOabStates(db)).toEqual(['PE', 'RN'])
  })
})
