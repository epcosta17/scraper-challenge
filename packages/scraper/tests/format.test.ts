import { describe, it, expect } from 'vitest'
import {
  progressLine, summaryLines, cappedWarning,
  deepDocumentProgressLine, deepCaseOutcomeLines, deepRangeSummaryLines,
  deepCaseProgressLine, deepStepLine, crawlPeriodicProgressLine,
  deepRunHeader, crawlRunHeader, searchRunHeader, crawlFailureLine, httpEventLine,
} from '../src/cli/format.ts'
import type { DeepCaseOutcome } from '../src/crawl/deep.ts'

describe('deepStepLine — narrates each step of a case as it starts', () => {
  const TAG = '[1/4 id 130107]'

  it('names the summary PDF fetch before it happens', () => {
    expect(deepStepLine({ kind: 'summary_pdf', ref: '130107' }, TAG))
      .toBe('[1/4 id 130107] fetching the summary PDF')
  })

  it('reports the case the summary PDF turned out to be, with its class', () => {
    expect(deepStepLine(
      { kind: 'summary_pdf_ok', ref: '130107', idProcessoTrf: 130107, number: '0010020-83.2026.4.05.8400', className: 'Apelação Cível' },
      TAG,
    )).toBe('[1/4 id 130107] got 0010020-83.2026.4.05.8400 (Apelação Cível)')
  })

  it('omits the class when the PDF did not carry one', () => {
    expect(deepStepLine(
      { kind: 'summary_pdf_ok', ref: '130107', idProcessoTrf: 130107, number: '0010020-83.2026.4.05.8400', className: null },
      TAG,
    )).toBe('[1/4 id 130107] got 0010020-83.2026.4.05.8400')
  })

  it('says a retried summary PDF is being retried, and why', () => {
    expect(deepStepLine({ kind: 'summary_pdf_retry', ref: '130107', attempt: 2, of: 4, status: 404 }, TAG))
      .toBe('[1/4 id 130107] ! summary PDF came back HTTP 404 - retry 2 of 4')
  })

  it('distinguishes the three ways a detail key gets resolved', () => {
    expect(deepStepLine({ kind: 'detail_key', ref: '130107', source: 'cached' }, TAG))
      .toBe('[1/4 id 130107] resolving the detail key: reusing the cached ca')
    expect(deepStepLine({ kind: 'detail_key', ref: '130107', source: 'search' }, TAG))
      .toBe('[1/4 id 130107] resolving the detail key: searching by case number')
    expect(deepStepLine({ kind: 'detail_key', ref: '130107', source: 'stale' }, TAG))
      .toBe('[1/4 id 130107] resolving the detail key: the cached ca is stale, searching by case number')
  })

  it('surfaces a search-bridge retry with the portal reason that caused it', () => {
    expect(deepStepLine(
      { kind: 'detail_key_retry', ref: '130107', attempt: 2, of: 4, reason: 'the portal did not run the action' },
      TAG,
    )).toBe('[1/4 id 130107] ! search bridge failed: the portal did not run the action - retry 2 of 4')
  })

  it('names the detail-page fetch and then what it found, pluralized', () => {
    expect(deepStepLine({ kind: 'case_file', ref: '130107' }, TAG)).toBe('[1/4 id 130107] reading the case file')
    expect(deepStepLine({ kind: 'case_file_ok', ref: '130107', documentCount: 4 }, TAG))
      .toBe('[1/4 id 130107] the case file lists 4 documents')
    expect(deepStepLine({ kind: 'case_file_ok', ref: '130107', documentCount: 1 }, TAG))
      .toBe('[1/4 id 130107] the case file lists 1 document')
  })

  it('says up front how much of the download is actually going to happen', () => {
    expect(deepStepLine({ kind: 'documents', ref: '130107', total: 4, alreadyOnDisk: 4 }, TAG))
      .toBe('[1/4 id 130107] downloading documents: 4 already on disk, nothing to fetch')
    expect(deepStepLine({ kind: 'documents', ref: '130107', total: 4, alreadyOnDisk: 1 }, TAG))
      .toBe('[1/4 id 130107] downloading documents: 3 of 4 (1 already on disk)')
    expect(deepStepLine({ kind: 'documents', ref: '130107', total: 4, alreadyOnDisk: 0 }, TAG))
      .toBe('[1/4 id 130107] downloading documents: 4 of 4')
    expect(deepStepLine({ kind: 'documents', ref: '130107', total: 0, alreadyOnDisk: 0 }, TAG))
      .toBe('[1/4 id 130107] no documents to download')
  })
})

describe('deepCaseProgressLine — the line a case ends on', () => {
  it('closes a finished case with its number and document counts', () => {
    const outcome: DeepCaseOutcome = {
      kind: 'done',
      idProcessoTrf: 130105,
      number: '0800120-05.2024.4.05.8306',
      documentsStored: 9,
      documentsSkipped: 0,
      documentsFailed: 0,
    }

    expect(deepCaseProgressLine(outcome, '[1/3 id 130105]'))
      .toBe('[1/3 id 130105] done: 0800120-05.2024.4.05.8306 - 9 documents (9 new)')
  })

  it('counts stored + skipped + failed as the total, and only stored as "new"', () => {
    const outcome: DeepCaseOutcome = {
      kind: 'done',
      idProcessoTrf: 130106,
      number: '0013478-88.2026.4.05.0000',
      documentsStored: 1,
      documentsSkipped: 2,
      documentsFailed: 0,
    }

    expect(deepCaseProgressLine(outcome, '[2/3 id 130106]'))
      .toBe('[2/3 id 130106] done: 0013478-88.2026.4.05.0000 - 3 documents (1 new)')
  })

  it('mentions failed documents when there are any', () => {
    const outcome: DeepCaseOutcome = {
      kind: 'done',
      idProcessoTrf: 130107,
      number: '0005425-26.2026.4.05.8308',
      documentsStored: 1,
      documentsSkipped: 0,
      documentsFailed: 1,
    }

    expect(deepCaseProgressLine(outcome, '[3/3 id 130107]'))
      .toBe('[3/3 id 130107] done: 0005425-26.2026.4.05.8308 - 2 documents (1 new, 1 failed)')
  })

  it('surfaces a failed case where it happened, with the reason', () => {
    const outcome: DeepCaseOutcome = { kind: 'failed', ref: '130108', error: 'No summary PDF for id 130108 (unassigned or sealed).' }

    expect(deepCaseProgressLine(outcome, '[4/5 id 130108]'))
      .toBe('[4/5 id 130108] FAILED: No summary PDF for id 130108 (unassigned or sealed).')
  })
})

describe('run headers — what the run is about to do', () => {
  it('states the case count, the id range, the database and the file directory', () => {
    expect(deepRunHeader({ fromId: 130107, toId: 130110, concurrency: 4, db: '/tmp/i1.db', out: '/tmp/i1' }))
      .toBe('Scraping 4 cases (ids 130107-130110), 4 at a time -> db /tmp/i1.db, files /tmp/i1')
  })

  it('drops the parallelism note when a run is strictly sequential', () => {
    expect(deepRunHeader({ fromId: 130107, toId: 130107, concurrency: 1, db: 'data/pje.db', out: 'data/pdfs' }))
      .toBe('Scraping 1 case (id 130107) -> db data/pje.db, files data/pdfs')
  })

  it('omits the parallelism note for a one-case range, which cannot use it', () => {
    expect(deepRunHeader({ fromId: 130109, toId: 130109, concurrency: 4, db: '/tmp/i2.db', out: '/tmp/i2' }))
      .toBe('Scraping 1 case (id 130109) -> db /tmp/i2.db, files /tmp/i2')
  })

  it('names a single target instead of a range', () => {
    expect(deepRunHeader({ target: '0013201-41.2025.4.05.8202', concurrency: 4, db: '/tmp/i2.db', out: '/tmp/i2' }))
      .toBe('Scraping case 0013201-41.2025.4.05.8202 -> db /tmp/i2.db, files /tmp/i2')
  })

  it('states the crawl range, or how the run will decide where to stop', () => {
    expect(crawlRunHeader({ command: 'crawl', fromId: 130100, toId: 130130, concurrency: 4, rps: 2, db: '/tmp/i3.db', out: '/tmp/i3' }))
      .toBe('Crawling 31 ids (130100-130130), 4 at a time at 2 req/s -> db /tmp/i3.db, files /tmp/i3')
    expect(crawlRunHeader({ command: 'daily', concurrency: 4, rps: 2, db: 'data/pje.db', out: 'data/pdfs' }))
      .toBe('Crawling from the stored watermark until 50 consecutive misses, 4 at a time at 2 req/s -> db data/pje.db, files data/pdfs')
  })

  it('states which filters a search is about to submit', () => {
    expect(searchRunHeader({ number: '0013201-41.2025.4.05.8202' }))
      .toBe('Searching the portal: number=0013201-41.2025.4.05.8202')
    expect(searchRunHeader({ from: '01/08/2026', to: '07/08/2026' }))
      .toBe('Searching the portal: from=01/08/2026, to=07/08/2026')
  })
})

describe('crawlFailureLine — a failed id, reported where it failed', () => {
  it('names the id and the reason', () => {
    expect(crawlFailureLine({ id: 130102, outcome: 'failed', stored: 1, absent: 0, failed: 1, error: 'Transient HTTP 404 from https://pje.trf5.jus.br/x' }))
      .toBe('! id 130102 failed: Transient HTTP 404 from https://pje.trf5.jus.br/x')
  })
})

describe('crawlPeriodicProgressLine — default (non-verbose) periodic line for crawl', () => {
  it('shows position, counts and the current id', () => {
    expect(crawlPeriodicProgressLine({ checked: 200, id: 130299, stored: 170, absent: 28, failed: 2 })).toBe(
      '… 200 ids checked (at id 130299)  stored=170 absent=28 failed=2',
    )
  })

  it('names the case the current id turned out to be, when it was a hit', () => {
    expect(crawlPeriodicProgressLine({ checked: 8, id: 130107, stored: 8, absent: 0, failed: 0, number: '0010020-83.2026.4.05.8400' })).toBe(
      '… 8 ids checked (at id 130107, 0010020-83.2026.4.05.8400)  stored=8 absent=0 failed=0',
    )
  })

  it('counts one id as one id', () => {
    expect(crawlPeriodicProgressLine({ checked: 1, id: 5, stored: 1, absent: 0, failed: 0 })).toBe(
      '… 1 id checked (at id 5)  stored=1 absent=0 failed=0',
    )
  })
})

describe('progressLine — the per-id line --verbose keeps', () => {
  it('names the case a stored id turned out to be', () => {
    expect(progressLine({ id: 5, outcome: 'stored', stored: 1, absent: 0, failed: 0, number: '0013475-36.2026.4.05.0000' })).toBe(
      '+ id=5  stored 0013475-36.2026.4.05.0000  (stored=1 absent=0 failed=0)',
    )
  })

  it('still works for an id with no case number to name', () => {
    expect(progressLine({ id: 6, outcome: 'absent', stored: 1, absent: 1, failed: 0 })).toBe(
      '. id=6  absent  (stored=1 absent=1 failed=0)',
    )
  })

  it('carries the reason on a failure', () => {
    expect(progressLine({ id: 7, outcome: 'failed', stored: 1, absent: 1, failed: 1, error: 'boom' })).toBe(
      '! id=7  failed: boom  (stored=1 absent=1 failed=1)',
    )
  })
})

// Result output (stdout) — unchanged by the narration work above.
describe('result formatters stay unchanged', () => {
  it('summaryLines', () => {
    expect(summaryLines({ stored: 1, absent: 2, failed: 3, lastId: 9 })).toContain('Stored:  1')
  })

  it('deepDocumentProgressLine', () => {
    expect(deepDocumentProgressLine({ idProcessoTrf: 1, idProcessoDoc: 12102067, docKind: 'binary', outcome: 'stored' }, '[1/1 id 1]')).toBe(
      '[1/1 id 1]   + document id=12102067 (binary) stored',
    )
  })

  it('deepCaseOutcomeLines', () => {
    expect(deepCaseOutcomeLines({ kind: 'failed', ref: 'x', error: 'boom' })).toBe('Case x failed: boom')
  })

  it('deepRangeSummaryLines', () => {
    expect(deepRangeSummaryLines({ casesDone: 1, casesFailed: 0, documentsStored: 1, documentsSkipped: 0, documentsFailed: 0 }))
      .toContain('Cases done:        1')
  })

  it('cappedWarning', () => {
    expect(cappedWarning()).toContain('30 results')
  })
})

describe('httpEventLine — the request-level detail --verbose adds', () => {
  it('names the request before it goes out, flagging a retried attempt', () => {
    expect(httpEventLine({ kind: 'request', method: 'GET', url: 'https://x.test/y', attempt: 1 }))
      .toBe('  → GET https://x.test/y')
    expect(httpEventLine({ kind: 'request', method: 'POST', url: 'https://x.test/y', attempt: 3 }))
      .toBe('  → POST https://x.test/y (attempt 3)')
  })

  it('reports the response with its size and how long it took', () => {
    expect(httpEventLine({ kind: 'response', method: 'GET', url: 'https://x.test/y', status: 200, bytes: 2048, ms: 412 }))
      .toBe('  ← 200  2.0 kB in 412 ms')
    expect(httpEventLine({ kind: 'response', method: 'GET', url: 'https://x.test/y', status: 404, bytes: 512, ms: 12 }))
      .toBe('  ← 404  512 B in 12 ms')
  })

  it('says what a retry is waiting for and how long', () => {
    expect(httpEventLine({ kind: 'retry', url: 'https://x.test/y', reason: 'rate_limited', status: 429, delayMs: 2000, attempt: 1, of: 5 }))
      .toBe('  ↻ rate limited (HTTP 429) - waiting 2.0s before attempt 2 of 5')
    expect(httpEventLine({ kind: 'retry', url: 'https://x.test/y', reason: 'server_error', status: 503, delayMs: 900, attempt: 2, of: 5 }))
      .toBe('  ↻ server error (HTTP 503) - waiting 900ms before attempt 3 of 5')
    expect(httpEventLine({ kind: 'retry', url: 'https://x.test/y', reason: 'transport', status: null, delayMs: 1000, attempt: 1, of: 5 }))
      .toBe('  ↻ transport error - waiting 1.0s before attempt 2 of 5')
  })
})
