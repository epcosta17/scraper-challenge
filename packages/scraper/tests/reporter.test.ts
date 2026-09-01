import { describe, it, expect } from 'vitest'
import { createReporter } from '../src/cli/reporter.ts'
import type { DeepCaseOutcome } from '../src/crawl/deep.ts'

const DONE: DeepCaseOutcome = {
  kind: 'done', idProcessoTrf: 130107, number: '0010020-83.2026.4.05.8400',
  documentsStored: 4, documentsSkipped: 0, documentsFailed: 0,
}

/** A reporter writing into an array, with a clock the test drives by hand. */
function harness(level: 'quiet' | 'normal' | 'verbose', tagFor?: (ref: string) => string) {
  const lines: string[] = []
  let clock = 1_000_000
  const reporter = createReporter({ level, write: (l) => lines.push(l), tagFor, now: () => clock })
  return { lines, reporter, advance: (ms: number) => { clock += ms } }
}

describe('createReporter — --quiet says nothing at all', () => {
  it('drops every kind of progress, leaving stdout as the only output', () => {
    const h = harness('quiet')
    h.reporter.header('Scraping 4 cases')
    h.reporter.note('starting a session')
    h.reporter.deepStep({ kind: 'summary_pdf', ref: '130107' })
    h.reporter.deepDocument({ idProcessoTrf: 130107, idProcessoDoc: 1, docKind: 'binary', outcome: 'failed' })
    h.reporter.deepCase(DONE)
    h.reporter.crawlProgress({ id: 1, outcome: 'failed', stored: 0, absent: 0, failed: 1, error: 'boom' })
    h.reporter.http({ kind: 'request', method: 'GET', url: 'https://x.test/y', attempt: 1 })
    h.reporter.detail('a request-level aside')

    expect(h.lines).toEqual([])
  })
})

describe('createReporter — the default level narrates intent', () => {
  it('prints the header, the steps and the case outcome, tagged by case', () => {
    const h = harness('normal')
    h.reporter.header('Scraping 1 case (id 130107) -> db x.db, files x')
    h.reporter.deepStep({ kind: 'summary_pdf', ref: '130107' })
    h.reporter.deepCase(DONE)

    expect(h.lines).toEqual([
      'Scraping 1 case (id 130107) -> db x.db, files x',
      '[130107] fetching the summary PDF',
      '[130107] done: 0010020-83.2026.4.05.8400 - 4 documents (4 new)',
    ])
  })

  it('keeps per-document chatter out of the way but never hides a failed document', () => {
    const h = harness('normal')
    h.reporter.deepDocument({ idProcessoTrf: 130107, idProcessoDoc: 11, docKind: 'binary', outcome: 'stored' })
    h.reporter.deepDocument({ idProcessoTrf: 130107, idProcessoDoc: 12, docKind: 'binary', outcome: 'skipped' })
    h.reporter.deepDocument({ idProcessoTrf: 130107, idProcessoDoc: 13, docKind: 'html', outcome: 'failed' })

    expect(h.lines).toEqual(['[130107]   ! document id=13 (html) failed'])
  })

  it('says nothing about individual requests — that is what --verbose is for', () => {
    const h = harness('normal')
    h.reporter.http({ kind: 'request', method: 'GET', url: 'https://x.test/y', attempt: 1 })
    h.reporter.http({ kind: 'retry', url: 'https://x.test/y', reason: 'rate_limited', status: 429, delayMs: 2000, attempt: 1, of: 5 })

    expect(h.lines).toEqual([])
  })

  it('uses the tag the caller supplies, so a parallel run stays attributable', () => {
    const h = harness('normal', (ref) => `[2/4 id ${ref}]`)
    h.reporter.deepStep({ kind: 'case_file', ref: '130108' })

    expect(h.lines).toEqual(['[2/4 id 130108] reading the case file'])
  })
})

describe('createReporter — crawl progress', () => {
  it('beats about every two seconds rather than once per id', () => {
    const h = harness('normal')
    for (let id = 1; id <= 3; id++) {
      h.reporter.crawlProgress({ id, outcome: 'stored', stored: id, absent: 0, failed: 0 })
    }
    expect(h.lines).toEqual([])

    h.advance(2100)
    h.reporter.crawlProgress({ id: 4, outcome: 'stored', stored: 4, absent: 0, failed: 0 })

    expect(h.lines).toEqual(['… 4 ids checked (at id 4)  stored=4 absent=0 failed=0'])
  })

  it('reports a failed id the moment it fails, without waiting for the next beat', () => {
    const h = harness('normal')
    h.reporter.crawlProgress({ id: 7, outcome: 'failed', stored: 0, absent: 0, failed: 1, error: 'Transient HTTP 404' })

    expect(h.lines).toEqual(['! id 7 failed: Transient HTTP 404'])
  })

  it('under --verbose prints one line per id, the failure reason included, and no duplicate', () => {
    const h = harness('verbose')
    h.reporter.crawlProgress({ id: 7, outcome: 'stored', stored: 1, absent: 0, failed: 0, number: '0013475-36.2026.4.05.0000' })
    h.reporter.crawlProgress({ id: 8, outcome: 'failed', stored: 1, absent: 0, failed: 1, error: 'boom' })

    expect(h.lines).toEqual([
      '+ id=7  stored 0013475-36.2026.4.05.0000  (stored=1 absent=0 failed=0)',
      '! id=8  failed: boom  (stored=1 absent=0 failed=1)',
    ])
  })
})

describe('createReporter — detail lines are --verbose-only', () => {
  it('holds a detail line back at the default level and prints it under --verbose', () => {
    const quiet = harness('normal')
    quiet.reporter.detail('↻ id 7: summary PDF came back HTTP 404 - retry 1 of 4')
    expect(quiet.lines).toEqual([])

    const loud = harness('verbose')
    loud.reporter.detail('↻ id 7: summary PDF came back HTTP 404 - retry 1 of 4')
    expect(loud.lines).toEqual(['↻ id 7: summary PDF came back HTTP 404 - retry 1 of 4'])
  })
})

describe('createReporter — --verbose adds the requests underneath the narration', () => {
  it('prints every document, and every request, response and retry', () => {
    const h = harness('verbose')
    h.reporter.deepDocument({ idProcessoTrf: 130107, idProcessoDoc: 11, docKind: 'binary', outcome: 'stored' })
    h.reporter.http({ kind: 'request', method: 'GET', url: 'https://x.test/y', attempt: 1 })
    h.reporter.http({ kind: 'response', method: 'GET', url: 'https://x.test/y', status: 200, bytes: 2048, ms: 412 })
    h.reporter.http({ kind: 'retry', url: 'https://x.test/y', reason: 'rate_limited', status: 429, delayMs: 2000, attempt: 1, of: 5 })

    expect(h.lines).toEqual([
      '[130107]   + document id=11 (binary) stored',
      '  → GET https://x.test/y',
      '  ← 200  2.0 kB in 412 ms',
      '  ↻ rate limited (HTTP 429) - waiting 2.0s before attempt 2 of 5',
    ])
  })
})
