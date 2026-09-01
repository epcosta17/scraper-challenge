import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, upsertCase, upsertDocument } from '@pje/core'
import { parseArgs, validateCommandUsage, helpText, ArgsError } from '../src/cli/args.ts'
import { main } from '../src/cli/run.ts'

describe('parseArgs — find', () => {
  it('takes the query as a positional argument', () => {
    const a = parseArgs(['find', 'sentença'])
    expect(a.command).toBe('find')
    expect(a.positional).toEqual(['sentença'])
  })

  it('accepts --limit and --offset for paging', () => {
    const a = parseArgs(['find', 'x', '--limit', '5', '--offset', '10'])
    expect(a.limit).toBe(5)
    expect(a.offset).toBe(10)
  })

  it('accepts --offset 0, which is a real offset and not a missing one', () => {
    expect(parseArgs(['find', 'x', '--offset', '0']).offset).toBe(0)
  })

  it('rejects a negative or fractional --offset', () => {
    expect(() => parseArgs(['find', 'x', '--offset', '-1'])).toThrow(ArgsError)
    expect(() => parseArgs(['find', 'x', '--offset', '1.5'])).toThrow(ArgsError)
  })
})

describe('validateCommandUsage — find', () => {
  it('accepts exactly one query', () => {
    expect(() => validateCommandUsage(parseArgs(['find', 'sentença']))).not.toThrow()
  })

  it('rejects a missing query rather than listing the whole acervo', () => {
    expect(() => validateCommandUsage(parseArgs(['find']))).toThrow(ArgsError)
  })

  it('rejects several loose words, pointing at quoting', () => {
    // `scraper find execução fiscal` is two positionals, and silently
    // searching for only the first would be a quiet wrong answer.
    try {
      validateCommandUsage(parseArgs(['find', 'execução', 'fiscal']))
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ArgsError)
      expect((err as ArgsError).message).toMatch(/quote/i)
    }
  })

  it('rejects --dry-run, which has nothing to plan', () => {
    expect(() => validateCommandUsage(parseArgs(['find', 'x', '--dry-run']))).toThrow(ArgsError)
  })
})

describe('helpText — find', () => {
  it('documents the command and its paging flags', () => {
    expect(helpText()).toContain('find')
    expect(helpText()).toContain('--offset')
  })
})

describe('main — find', () => {
  let dir: string
  let dbPath: string
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  const sample = {
    idProcessoTrf: 130100,
    number: '0013475-36.2026.4.05.0000',
    ca: null,
    className: 'APELAÇÃO CÍVEL',
    classCode: '198',
    court: 'Gab 6 - Des. PAULO CORDEIRO',
    panel: '2ª Turma',
    distributedAt: '17 de Agosto de 2026',
    subjects: ['Execução Fiscal (6017)'],
    parties: [{ name: 'FAZENDA NACIONAL', role: 'APELANTE' }],
    summaryPdfKey: null,
    jurisdiction: 'TRF5',
    courtAddress: null,
    referenceNumber: null,
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pje-cli-find-'))
    dbPath = join(dir, 'find.db')
    const db = openDatabase(dbPath)
    upsertCase(db, sample)
    upsertDocument(db, {
      idProcessoDocumento: 900001,
      idProcessoTrf: sample.idProcessoTrf,
      idBin: null,
      numeroDocumento: null,
      label: '24/07/2025 20:30:45 - Sentença (Sentença)',
      docType: 'Sentença',
      docDate: '24/07/2025 20:30:45',
      pdfKey: null,
      textContent: 'Julgo improcedentes os embargos e determino o prosseguimento da execução fiscal.',
    })
    db.close()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy?.mockRestore()
    errorSpy?.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  const stdout = (): string => logSpy.mock.calls.map((c) => String(c[0])).join('\n')

  it('finds a case by a word in its document text and shows a snippet', async () => {
    const code = await main(['find', 'embargos', '--db', dbPath])
    expect(code).toBe(0)
    const out = stdout()
    expect(out).toContain(sample.number)
    expect(out).toContain('[embargos]')
  })

  it('finds an accented word typed without its accents', async () => {
    expect(await main(['find', 'execucao', '--db', dbPath])).toBe(0)
    expect(stdout()).toContain(sample.number)
  })

  it('prints machine-readable results under --json, and nothing else on stdout', async () => {
    const code = await main(['find', 'embargos', '--db', dbPath, '--json'])
    expect(code).toBe(0)
    expect(logSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(String(logSpy.mock.calls[0]![0])) as {
      total: number
      hits: Array<{ idProcessoTrf: number; snippet: { text: string } | null }>
    }
    expect(parsed.total).toBe(1)
    expect(parsed.hits[0]!.idProcessoTrf).toBe(sample.idProcessoTrf)
    expect(parsed.hits[0]!.snippet!.text).toContain('[embargos]')
  })

  it('reports no matches without failing', async () => {
    const code = await main(['find', 'zzzzunobtainium', '--db', dbPath])
    expect(code).toBe(0)
    expect(stdout()).toMatch(/0 (results|matching)/i)
  })

  it('rejects a query with nothing searchable in it, with the usage exit code', async () => {
    const code = await main(['find', '***', '--db', dbPath])
    expect(code).toBe(2)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('error:'))
  })

  it('never goes near the network', async () => {
    const fetchImpl = vi.fn((async () => { throw new Error('no network') }) as unknown as typeof fetch)
    await main(['find', 'embargos', '--db', dbPath], { fetchImpl })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
