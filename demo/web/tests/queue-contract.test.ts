import { describe, expect, it } from 'vitest'
import { JOB_KINDS, parseTarget, type JobKind } from '../src/data/sqlite/jobs.ts'
import {
  parseCrawlPayload, parseDeepCasePayload, parseDeepRangePayload,
} from '../../worker/src/payloads.ts'

/**
 * The web only ever enqueues; the worker only ever executes. Nothing at
 * runtime sits between them to catch a payload the two sides spell
 * differently — a job written here surfaces as a failed row over there,
 * minutes later, on a screen nobody is watching at the time.
 *
 * These are not two views of one type, either: the worker's parsers reject
 * unknown keys on purpose, so a payload that merely *resembles* what it wants
 * is refused rather than quietly run with a default. That strictness is what
 * makes this test worth having — and it is what caught `id` against
 * `idProcessoTrf` the first time the two halves were put together.
 */
const PARSER: Record<JobKind, (p: Record<string, unknown>) => unknown> = {
  deep_case: parseDeepCasePayload,
  refresh_case: parseDeepCasePayload,
  // A deep range walks ids like a crawl, but fetches each case's documents
  // too, so it needs both ends of the range where a crawl does not.
  deep_range: parseDeepRangePayload,
  crawl: parseCrawlPayload,
}

const TARGETS: Record<JobKind, string[]> = {
  deep_case: ['0800120-05.2024.4.05.8306', '130105'],
  refresh_case: ['0800120-05.2024.4.05.8306', '130105'],
  deep_range: ['130100-130400', 'ids 130100–130400'],
  crawl: ['', '130100-130400'],
}

describe('every job the web can enqueue is one the worker can execute', () => {
  it.each(JOB_KINDS)('%s', (kind) => {
    for (const written of TARGETS[kind]) {
      const enqueued = parseTarget(kind, written)
      expect(enqueued.ok, `the web refused its own target ${JSON.stringify(written)}`).toBe(true)
      if (!enqueued.ok) return
      expect(
        () => PARSER[kind](enqueued.payload),
        `the worker refused ${JSON.stringify(enqueued.payload)}, enqueued for ${kind}`,
      ).not.toThrow()
    }
  })

  it('covers every kind the queue form offers', () => {
    expect(Object.keys(PARSER).sort()).toEqual([...JOB_KINDS].sort())
  })
})
