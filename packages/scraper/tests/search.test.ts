import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildSearchPayload, parseSearchResponse, validateFilters,
  SearchValidationError, ActionNotExecutedError,
  encodeFormComponent, encodeSearchBody,
} from '../src/pje/search.ts'

/**
 * Fixtures are read the way production reads the response they came from.
 *
 * This portal serves its pages in ISO-8859-1 and its AJAX fragments in UTF-8,
 * declaring neither — so `list-view.html` (a page) is Latin-1 and
 * `search-results.xml` (a fragment) is UTF-8, exactly as captured. Reading both
 * the same way is how an encoding bug hides: with only ASCII fields asserted,
 * nothing fails.
 */
const fx = (n: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)),
    n.endsWith('.xml') ? 'utf8' : 'latin1')

const session = { actionUrl: 'https://x/listView.seam;jsessionid=A', submitParam: 'fPP:j_id244' }
const today = new Date('2026-08-31T00:00:00Z')

describe('buildSearchPayload', () => {
  it('always fills both CurrentDate fields with a valid MM/YYYY', () => {
    // Empty CurrentDate makes the RichFaces calendar fail to decode, and JSF
    // then silently DROPS the date filter and returns unrelated results.
    const p = buildSearchPayload(session, {}, today)
    expect(p['fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputCurrentDate']).toBe('08/2026')
    expect(p['fPP:dataAutuacaoDecoration:dataAutuacaoFimInputCurrentDate']).toBe('08/2026')
  })

  it('uses the extracted submit param as both key and value', () => {
    const p = buildSearchPayload(session, {}, today)
    expect(p['fPP:j_id244']).toBe('fPP:j_id244')
    expect(p['fPP:searchProcessos']).toBeUndefined()
  })

  it('sets the AJAX plumbing fields and stateless view state', () => {
    const p = buildSearchPayload(session, {}, today)
    expect(p['AJAXREQUEST']).toBe('_viewRoot')
    expect(p['javax.faces.ViewState']).toBe('j_id1')
    expect(p['fPP']).toBe('fPP')
  })

  it('maps filters onto the real field names', () => {
    const p = buildSearchPayload(session, {
      number: '0013201-41.2025.4.05.8202',
      class: 'AGRAVO DE INSTRUMENTO',
      party: 'DA SILVA',
      from: '25/08/2026',
      to: '25/08/2026',
    }, today)
    expect(p['fPP:numProcesso-inputNumeroProcessoDecoration:numProcesso-inputNumeroProcesso'])
      .toBe('0013201-41.2025.4.05.8202')
    expect(p['fPP:j_id189:classeJudicial']).toBe('AGRAVO DE INSTRUMENTO')
    expect(p['fPP:dnp:nomeParte']).toBe('DA SILVA')
    expect(p['fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputDate']).toBe('25/08/2026')
  })

  it('maps every SearchFilters field onto its real JSF field name', () => {
    // A typo in any one of these field names would pass every other test and
    // then silently change behaviour against the real server.
    const p = buildSearchPayload(session, {
      number: '0013201-41.2025.4.05.8202',
      from: '25/08/2026',
      to: '26/08/2026',
      class: 'AGRAVO DE INSTRUMENTO',
      party: 'DA SILVA',
      lawyer: 'DE SOUZA',
      document: '12345678900',
      documentType: 'cnpj',
      oab: '1234',
      oabState: 'PE',
      reference: '0099887-11.2020.4.05.8202',
    }, today)
    expect(p['fPP:numProcesso-inputNumeroProcessoDecoration:numProcesso-inputNumeroProcesso'])
      .toBe('0013201-41.2025.4.05.8202')
    expect(p['fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputDate']).toBe('25/08/2026')
    expect(p['fPP:dataAutuacaoDecoration:dataAutuacaoFimInputDate']).toBe('26/08/2026')
    expect(p['fPP:j_id189:classeJudicial']).toBe('AGRAVO DE INSTRUMENTO')
    expect(p['fPP:dnp:nomeParte']).toBe('DA SILVA')
    expect(p['fPP:j_id180:nomeAdv']).toBe('DE SOUZA')
    expect(p['fPP:dpDec:documentoParte']).toBe('12345678900')
    expect(p['tipoMascaraDocumento']).toBe('cnpj')
    expect(p['fPP:Decoration:numeroOAB']).toBe('1234')
    expect(p['fPP:Decoration:estadoComboOAB']).toBe('PE')
    expect(p['fPP:j_id162:processoReferenciaInput']).toBe('0099887-11.2020.4.05.8202')
  })

  it('sends the no-selection sentinel when no OAB state is given', () => {
    const p = buildSearchPayload(session, {}, today)
    expect(p['fPP:Decoration:estadoComboOAB'])
      .toBe('org.jboss.seam.ui.NoSelectionConverter.noSelectionValue')
  })

  it('sends the no-selection sentinel when oabState is an explicit empty string', () => {
    const p = buildSearchPayload(session, { oabState: '' }, today)
    expect(p['fPP:Decoration:estadoComboOAB'])
      .toBe('org.jboss.seam.ui.NoSelectionConverter.noSelectionValue')
  })
})

describe('encodeFormComponent', () => {
  it('percent-encodes Latin-1 bytes, not UTF-8, for an accented name', () => {
    // URLSearchParams.toString() always encodes as UTF-8 regardless of the
    // declared Content-Type charset. The server decodes our declared
    // ISO-8859-1 bytes as Latin-1, so a UTF-8 body turns into mojibake and
    // silently returns fewer/wrong rows — no error, just a truncated result.
    expect(encodeFormComponent('JOSÉ SILVA')).toBe('JOS%C9+SILVA')
  })

  it('leaves plain ASCII unchanged apart from turning spaces into +', () => {
    expect(encodeFormComponent('DA SILVA')).toBe('DA+SILVA')
    expect(encodeFormComponent('AGRAVO-1')).toBe('AGRAVO-1')
  })
})

describe('encodeSearchBody', () => {
  it('encodes an accented payload value as Latin-1 (%C9), never UTF-8 (%C3%89)', () => {
    const body = encodeSearchBody({ 'fPP:dnp:nomeParte': 'JOSÉ SILVA' })
    expect(body).toContain('%C9')
    expect(body).not.toContain('%C3%89')
  })
})

describe('validateFilters', () => {
  it('rejects a single-token party name before any network call', () => {
    // The server answers "É necessário informar ao menos dois nomes" and returns 0 rows.
    expect(() => validateFilters({ party: 'SILVA' })).toThrow(SearchValidationError)
    expect(() => validateFilters({ party: 'DA SILVA' })).not.toThrow()
  })

  it('rejects a single-token lawyer name', () => {
    expect(() => validateFilters({ lawyer: 'SILVA' })).toThrow(SearchValidationError)
  })

  it('rejects an OAB state without an OAB number, which the server ignores silently', () => {
    expect(() => validateFilters({ oabState: 'PE' })).toThrow(SearchValidationError)
    expect(() => validateFilters({ oabState: 'PE', oab: '1234' })).not.toThrow()
  })

  it('treats an explicit empty oabState the same as absent', () => {
    expect(() => validateFilters({ oabState: '' })).not.toThrow()
  })

  it('rejects malformed dates', () => {
    expect(() => validateFilters({ from: '2026-08-25' })).toThrow(SearchValidationError)
    expect(() => validateFilters({ from: '25/08/2026' })).not.toThrow()
  })
})

describe('parseSearchResponse', () => {
  it('extracts idProcessoTrf, number and ca for each row', () => {
    const out = parseSearchResponse(fx('search-results.xml'))
    expect(out.rows.length).toBeGreaterThan(0)
    const row = out.rows[0]!
    expect(row.idProcessoTrf).toBeGreaterThan(0)
    expect(row.number).toMatch(/^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/)
    expect(row.ca).toMatch(/^[0-9a-f]{48}$/)
  })

  it('flags a capped result set instead of pretending it saw everything', () => {
    const out = parseSearchResponse(fx('search-results.xml'))
    expect(out.capped).toBe(true)
    expect(out.rows).toHaveLength(30)
  })

  it('accepts the shorter ca the portal gives an older case', () => {
    // Captured live: a search that reaches cases from 1999, 2005 and 2010
    // comes back with a 32-hex ca for those rows and 48-hex for the recent
    // ones. Both resolve a real detail page — verified against the portal —
    // so a parser that demands 48 rejects the whole response and loses the
    // 27 rows that were fine along with the 3 it could not read.
    const xml = fx('search-results.xml').replace(
      /listView\.seam\?ca=([0-9a-f]{48})/,
      'listView.seam?ca=425a4dad7bac2fd9ab141b7f5f93844c',
    )
    const out = parseSearchResponse(xml)
    expect(out.rows).toHaveLength(30)
    expect(out.rows.map((r) => r.ca)).toContain('425a4dad7bac2fd9ab141b7f5f93844c')
  })

  it('throws when the action never executed rather than reporting zero results', () => {
    // Ajax-Update-Ids = fPP:j_id248 means only the message panel re-rendered.
    expect(() => parseSearchResponse(fx('search-not-executed.xml')))
      .toThrow(ActionNotExecutedError)
  })

  it('throws when Ajax-Update-Ids is missing entirely, not just carrying the wrong id', () => {
    // An error page, expired session, or any non-standard AJAX response has
    // no Ajax-Update-Ids meta tag at all. Treating "header absent" as
    // "search ran, zero rows" would be the same silent-empty-result lie
    // reached through a different door.
    const xmlWithoutHeader = '<partial-response><changes></changes></partial-response>'
    expect(() => parseSearchResponse(xmlWithoutHeader)).toThrow(ActionNotExecutedError)
  })

  it('throws instead of silently dropping a row missing its number or ca', () => {
    // The action ran (the header is correct and a row marker is present),
    // but the row's content doesn't match the number/ca patterns this parser
    // expects — the response shape changed underneath it. Silently skipping
    // the row would hand the caller a result set that looks complete but
    // isn't, with no signal anything went wrong.
    const xml = [
      '<meta name="Ajax-Update-Ids" content="fPP:processosGridPanel"/>',
      '<span id="fPP:processosTable:123:foo">malformed row, no number or ca here</span>',
    ].join('\n')
    expect(() => parseSearchResponse(xml)).toThrow(ActionNotExecutedError)
  })
})

describe('what a result row carries beyond its identifiers', () => {
  /**
   * The portal's list shows the class, the subject, the parties and the last
   * movement in every row, and the parser read only the number and the `ca` —
   * discarding data that arrives in a response already paid for. The brief
   * asked for every field available on a document; these are the free ones.
   */
  const rows = parseSearchResponse(fx('search-results.xml')).rows

  it('reads the class, subject, parties and last movement', () => {
    expect(rows[0]).toMatchObject({
      number: '0000148-15.2005.4.05.8001',
      className: 'APELAÇÃO CÍVEL',
      subject: 'Penhora / Depósito/ Avaliação',
      lastMovement: {
        description: 'Conclusos para julgamento',
        timestamp: '28/08/2026 15:04:16',
      },
    })
    expect(rows[0]!.parties).toContain('FAZENDA NACIONAL')
  })

  it('keeps the accents, which is what the encoding fix was about', () => {
    // This response is a UTF-8 AJAX fragment, not a Latin-1 page. Decoded the
    // old way, this subject reads "Prescrição e Decadência".
    expect(rows.map((r) => r.subject)).toContain('Prescrição e Decadência')
  })

  it('fills these in for every row, not only the first', () => {
    // A parser that works on row one and quietly gives up on the rest is the
    // failure this asserts against.
    expect(rows.filter((r) => r.className !== undefined)).toHaveLength(rows.length)
    expect(rows.filter((r) => r.lastMovement !== undefined)).toHaveLength(rows.length)
  })

  it('still returns the identifiers a row exists for', () => {
    // The new fields are a bonus; losing a `ca` to gain a subject would be a
    // bad trade, since the `ca` is what opens the case file.
    expect(rows).toHaveLength(30)
    expect(rows.every((r) => r.ca.length === 48 || r.ca.length === 32)).toBe(true)
  })
})
