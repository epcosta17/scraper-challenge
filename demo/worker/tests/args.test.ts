import { describe, it, expect } from 'vitest'
import { parseWorkerArgs, ArgsError, helpText } from '../src/cli/args.ts'

describe('parseWorkerArgs', () => {
  it('drains once, from the shared defaults, when given nothing', () => {
    expect(parseWorkerArgs([])).toMatchObject({
      db: 'data/pje.db',
      out: 'data/pdfs',
      watch: false,
      json: false,
      quiet: false,
      verbose: false,
    })
  })

  it('reads the paths, the pacing and the queue knobs', () => {
    const args = parseWorkerArgs([
      '--db', '/tmp/x.db', '--out', '/tmp/pdfs', '--watch', '--poll-interval', '250',
      '--max-jobs', '3', '--concurrency', '8', '--rate', '5', '--lease', '30', '--attempts', '2',
    ])
    expect(args).toMatchObject({
      db: '/tmp/x.db', out: '/tmp/pdfs', watch: true, pollIntervalMs: 250,
      maxJobs: 3, concurrency: 8, rps: 5, leaseMs: 30_000, maxAttempts: 2,
    })
  })

  it('restricts the worker to a list of job types', () => {
    expect(parseWorkerArgs(['--types', 'deep_case,crawl']).types).toEqual(['deep_case', 'crawl'])
  })

  it('tolerates spaces and empty entries in that list', () => {
    expect(parseWorkerArgs(['--types', ' crawl , , deep_range ']).types).toEqual(['crawl', 'deep_range'])
  })

  it('names the types it does know when given one it does not', () => {
    expect(() => parseWorkerArgs(['--types', 'crawl,teleport'])).toThrow(/teleport/)
    expect(() => parseWorkerArgs(['--types', 'crawl,teleport'])).toThrow(/deep_case/)
  })

  it('rejects an empty type list rather than reading it as "every type"', () => {
    expect(() => parseWorkerArgs(['--types', ' , '])).toThrow(ArgsError)
  })

  it('insists a flag that needs a value gets one', () => {
    expect(() => parseWorkerArgs(['--db'])).toThrow(/--db requires a value/)
    expect(() => parseWorkerArgs(['--db', '--watch'])).toThrow(/--db requires a value/)
  })

  it('rejects numbers that would silently disable something', () => {
    expect(() => parseWorkerArgs(['--concurrency', '0'])).toThrow(ArgsError)
    expect(() => parseWorkerArgs(['--max-jobs', '0'])).toThrow(ArgsError)
    expect(() => parseWorkerArgs(['--rate', '-1'])).toThrow(ArgsError)
    expect(() => parseWorkerArgs(['--lease', '1.5'])).toThrow(ArgsError)
  })

  it('rejects an unknown flag instead of ignoring it', () => {
    expect(() => parseWorkerArgs(['--forever'])).toThrow(/Unknown flag "--forever"/)
  })

  it('rejects a positional, which this command has no use for', () => {
    expect(() => parseWorkerArgs(['crawl'])).toThrow(/crawl/)
  })

  it('refuses --quiet and --verbose together', () => {
    expect(() => parseWorkerArgs(['--quiet', '--verbose'])).toThrow(/opposites/)
  })

  it('has help that names every job type it runs', () => {
    for (const type of ['crawl', 'deep_case', 'deep_range', 'refresh_case']) {
      expect(helpText()).toContain(type)
    }
  })
})
