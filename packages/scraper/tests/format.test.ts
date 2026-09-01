import { describe, it, expect } from 'vitest'
import {
  progressLine, summaryLines, cappedWarning,
  deepDocumentProgressLine, deepCaseOutcomeLines, deepRangeSummaryLines,
  deepCaseProgressLine, deepStepLine, crawlPeriodicProgressLine,
} from '../src/cli/format.ts'
import type { DeepCaseOutcome } from '../src/crawl/deep.ts'

describe('deepCaseProgressLine — default (non-verbose) per-case line for a deep range', () => {
  it('formats a finished case with its running position and document counts', () => {
    const outcome: DeepCaseOutcome = {
      kind: 'done',
      idProcessoTrf: 130105,
      number: '0800120-05.2024.4.05.8306',
      documentsStored: 9,
      documentsSkipped: 0,
      documentsFailed: 0,
    }

    expect(deepCaseProgressLine(1, 3, outcome)).toBe(
      '[1/3] 0800120-05.2024.4.05.8306  9 documents (9 new)',
    )
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

    expect(deepCaseProgressLine(2, 3, outcome)).toBe(
      '[2/3] 0013478-88.2026.4.05.0000  3 documents (1 new)',
    )
  })

  it('mentions failed documents when there are any, without them elsewhere', () => {
    const outcome: DeepCaseOutcome = {
      kind: 'done',
      idProcessoTrf: 130107,
      number: '0005425-26.2026.4.05.8308',
      documentsStored: 1,
      documentsSkipped: 0,
      documentsFailed: 1,
    }

    expect(deepCaseProgressLine(3, 3, outcome)).toBe(
      '[3/3] 0005425-26.2026.4.05.8308  2 documents (1 new, 1 failed)',
    )
  })

  it('surfaces a failed case in the same running position, not only in the final summary', () => {
    const outcome: DeepCaseOutcome = { kind: 'failed', ref: '130108', error: 'No summary PDF for id 130108 (unassigned or sealed).' }

    expect(deepCaseProgressLine(4, 5, outcome)).toBe(
      '[4/5] 130108 FAILED: No summary PDF for id 130108 (unassigned or sealed).',
    )
  })
})

describe('deepStepLine — verbose step-by-step trace within a case', () => {
  it('names the case as processing starts, keyed off whatever target is known', () => {
    expect(deepStepLine({ kind: 'case_start', ref: '130105' })).toBe('130105')
  })

  it('names the summary PDF step', () => {
    expect(deepStepLine({ kind: 'summary_pdf' })).toBe('  → summary PDF')
  })

  it('names the search-bridge step', () => {
    expect(deepStepLine({ kind: 'search_bridge' })).toBe('  → resolving ca (search bridge)')
  })

  it('names the detail-page step with the document count it found, pluralized', () => {
    expect(deepStepLine({ kind: 'detail_page', documentCount: 9 })).toBe('  → detail page: 9 documents')
    expect(deepStepLine({ kind: 'detail_page', documentCount: 1 })).toBe('  → detail page: 1 document')
    expect(deepStepLine({ kind: 'detail_page', documentCount: 0 })).toBe('  → detail page: 0 documents')
  })
})

describe('crawlPeriodicProgressLine — default (non-verbose) periodic line for crawl', () => {
  it('shows position, counts and the current id', () => {
    expect(crawlPeriodicProgressLine({ checked: 200, id: 130299, stored: 170, absent: 28, failed: 2 })).toBe(
      '… 200 ids checked (at id 130299)  stored=170 absent=28 failed=2',
    )
  })
})

// Existing formatting behaviour, pinned so the new work above can't regress it.
describe('existing formatters stay unchanged', () => {
  it('progressLine', () => {
    expect(progressLine({ id: 5, outcome: 'stored', stored: 1, absent: 0, failed: 0 })).toBe(
      '+ id=5  stored=1 absent=0 failed=0',
    )
  })

  it('summaryLines', () => {
    expect(summaryLines({ stored: 1, absent: 2, failed: 3, lastId: 9 })).toContain('Stored:  1')
  })

  it('deepDocumentProgressLine', () => {
    expect(deepDocumentProgressLine({ idProcessoTrf: 1, idProcessoDoc: 12102067, docKind: 'binary', outcome: 'stored' })).toBe(
      '  + document id=12102067 (binary) stored',
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
