import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildSearchPayload, parseSearchResponse, validateFilters,
  SearchValidationError, ActionNotExecutedError,
} from '../src/pje/search.ts'

const fx = (n: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)), 'latin1')

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

  it('sends the no-selection sentinel when no OAB state is given', () => {
    const p = buildSearchPayload(session, {}, today)
    expect(p['fPP:Decoration:estadoComboOAB'])
      .toBe('org.jboss.seam.ui.NoSelectionConverter.noSelectionValue')
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

  it('throws when the action never executed rather than reporting zero results', () => {
    // Ajax-Update-Ids = fPP:j_id248 means only the message panel re-rendered.
    expect(() => parseSearchResponse(fx('search-not-executed.xml')))
      .toThrow(ActionNotExecutedError)
  })
})
