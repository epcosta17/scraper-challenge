import { describe, it, expect } from 'vitest'
import { parseArgs, ArgsError, helpText, validateCommandUsage } from '../src/cli/args.ts'

describe('parseArgs', () => {
  it('parses the command and search filters', () => {
    const a = parseArgs(['search', '--class', 'AGRAVO DE INSTRUMENTO', '--from', '25/08/2026'])
    expect(a.command).toBe('search')
    expect(a.filters.class).toBe('AGRAVO DE INSTRUMENTO')
    expect(a.filters.from).toBe('25/08/2026')
  })

  it('keeps crawl id bounds separate from search date bounds', () => {
    const a = parseArgs(['crawl', '--from-id', '1', '--to-id', '500'])
    expect(a.fromId).toBe(1)
    expect(a.toId).toBe(500)
    expect(a.filters.from).toBeUndefined()
  })

  it('applies documented defaults', () => {
    const a = parseArgs(['crawl'])
    expect(a.concurrency).toBe(4)
    expect(a.rps).toBe(2)
    expect(a.db).toBe('data/pje.db')
    expect(a.out).toBe('data/pdfs')
  })

  it('parses boolean flags', () => {
    const a = parseArgs(['search', '--json', '--verbose', '--dry-run', '--partition'])
    expect(a.json).toBe(true)
    expect(a.verbose).toBe(true)
    expect(a.dryRun).toBe(true)
    expect(a.partition).toBe(true)
  })

  it('collects positional arguments for case and deep', () => {
    expect(parseArgs(['case', '0013201-41.2025.4.05.8202']).positional)
      .toEqual(['0013201-41.2025.4.05.8202'])
  })

  it('rejects an unknown command', () => {
    expect(() => parseArgs(['frobnicate'])).toThrow(ArgsError)
  })

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['crawl', '--nope', '1'])).toThrow(ArgsError)
  })

  it('rejects a non-numeric value where a number is required', () => {
    expect(() => parseArgs(['crawl', '--concurrency', 'many'])).toThrow(ArgsError)
  })

  it('rejects a flag that is missing its value', () => {
    expect(() => parseArgs(['search', '--class'])).toThrow(ArgsError)
  })

  it('rejects a zero or negative --rate, which would silently disable rate limiting', () => {
    expect(() => parseArgs(['crawl', '--rate', '0'])).toThrow(ArgsError)
    expect(() => parseArgs(['crawl', '--rate', '-1'])).toThrow(ArgsError)
  })

  it('accepts a fractional --rate', () => {
    expect(parseArgs(['crawl', '--rate', '0.5']).rps).toBe(0.5)
  })

  it('rejects a non-positive --limit, which would make the crawl a silent no-op', () => {
    expect(() => parseArgs(['crawl', '--limit', '0'])).toThrow(ArgsError)
    expect(() => parseArgs(['crawl', '--limit', '-5'])).toThrow(ArgsError)
  })

  it('rejects a non-positive --concurrency instead of silently clamping it', () => {
    expect(() => parseArgs(['crawl', '--concurrency', '0'])).toThrow(ArgsError)
    expect(() => parseArgs(['crawl', '--concurrency', '-1'])).toThrow(ArgsError)
  })

  it('rejects a non-integer --from-id before it reaches a URL', () => {
    expect(() => parseArgs(['crawl', '--from-id', '1.5'])).toThrow(ArgsError)
  })

  it('rejects a non-positive --to-id', () => {
    expect(() => parseArgs(['crawl', '--to-id', '0'])).toThrow(ArgsError)
  })

  it('rejects a non-integer --to-id', () => {
    expect(() => parseArgs(['crawl', '--to-id', '2.2'])).toThrow(ArgsError)
  })
})

describe('helpText', () => {
  it('documents every command', () => {
    const h = helpText()
    for (const cmd of ['search', 'crawl', 'case', 'deep', 'daily']) expect(h).toContain(cmd)
  })

  it('documents the id/date flag distinction', () => {
    expect(helpText()).toContain('--from-id')
    expect(helpText()).toContain('--from')
  })
})

describe('validateCommandUsage', () => {
  it('rejects --partition: the strategy is not implemented in this phase', () => {
    const a = parseArgs(['search', '--partition'])
    expect(() => validateCommandUsage(a)).toThrow(ArgsError)
    try {
      validateCommandUsage(a)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ArgsError)
      expect((err as ArgsError).message).toMatch(/not (yet )?(implemented|available)/i)
      expect((err as ArgsError).message).toMatch(/crawl/)
    }
  })

  it('does not reject search when --partition is absent', () => {
    const a = parseArgs(['search', '--class', 'X'])
    expect(() => validateCommandUsage(a)).not.toThrow()
  })

  it('rejects daily with --from-id', () => {
    const a = parseArgs(['daily', '--from-id', '5'])
    expect(() => validateCommandUsage(a)).toThrow(ArgsError)
  })

  it('rejects daily with --to-id', () => {
    const a = parseArgs(['daily', '--to-id', '500'])
    expect(() => validateCommandUsage(a)).toThrow(ArgsError)
  })

  it('accepts daily with no id bounds', () => {
    const a = parseArgs(['daily'])
    expect(() => validateCommandUsage(a)).not.toThrow()
  })

  it('accepts crawl with explicit id bounds', () => {
    const a = parseArgs(['crawl', '--from-id', '1', '--to-id', '500'])
    expect(() => validateCommandUsage(a)).not.toThrow()
  })

  it('rejects a positional argument on search, pointing at --number', () => {
    // The most natural thing an assessor will type — `scraper search
    // 0013201-41.2025.4.05.8202` — must not silently run an unfiltered
    // search and present 30 arbitrary rows as the answer.
    const a = parseArgs(['search', '0013201-41.2025.4.05.8202'])
    expect(() => validateCommandUsage(a)).toThrow(ArgsError)
    try {
      validateCommandUsage(a)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ArgsError)
      expect((err as ArgsError).message).toMatch(/--number/)
    }
  })

  it('rejects a positional argument on crawl', () => {
    const a = parseArgs(['crawl', '130100'])
    expect(() => validateCommandUsage(a)).toThrow(ArgsError)
  })

  it('rejects a positional argument on daily', () => {
    const a = parseArgs(['daily', 'x'])
    expect(() => validateCommandUsage(a)).toThrow(ArgsError)
  })
})
