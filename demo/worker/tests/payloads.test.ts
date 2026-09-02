import { describe, it, expect } from 'vitest'
import {
  parseCrawlPayload, parseDeepCasePayload, parseDeepRangePayload,
  JobPayloadError,
} from '../src/payloads.ts'

describe('parseCrawlPayload', () => {
  it('reads an explicit range', () => {
    expect(parseCrawlPayload({ fromId: 130100, toId: 130120 }))
      .toEqual({ fromId: 130100, toId: 130120 })
  })

  it('accepts an empty payload — that is a crawl resuming from the watermark', () => {
    expect(parseCrawlPayload({})).toEqual({})
  })

  it('carries the tuning the engine already understands', () => {
    expect(parseCrawlPayload({ limit: 10, concurrency: 2, stopAfterMisses: 5 }))
      .toEqual({ limit: 10, concurrency: 2, stopAfterMisses: 5 })
  })

  it('rejects a range that runs backwards', () => {
    expect(() => parseCrawlPayload({ fromId: 20, toId: 10 })).toThrow(JobPayloadError)
  })

  it('rejects a key it does not know', () => {
    // A silently ignored `fron` would run as a watermark crawl and look like
    // it worked, which is the whole reason unknown keys are refused.
    expect(() => parseCrawlPayload({ fron: 10, toId: 20 })).toThrow(/fron/)
  })

  it('rejects values that are not whole positive numbers', () => {
    expect(() => parseCrawlPayload({ fromId: 'x' })).toThrow(JobPayloadError)
    expect(() => parseCrawlPayload({ fromId: 1.5 })).toThrow(JobPayloadError)
    expect(() => parseCrawlPayload({ fromId: -1 })).toThrow(JobPayloadError)
    expect(() => parseCrawlPayload({ limit: 0 })).toThrow(JobPayloadError)
  })
})

describe('parseDeepCasePayload', () => {
  it('takes an internal id', () => {
    expect(parseDeepCasePayload({ idProcessoTrf: 130100 })).toEqual({ kind: 'id', id: 130100 })
  })

  it('takes a case number, which the engine resolves through the search bridge', () => {
    expect(parseDeepCasePayload({ number: '0013475-36.2026.4.05.0000' }))
      .toEqual({ kind: 'number', number: '0013475-36.2026.4.05.0000' })
  })

  it('insists on exactly one of the two', () => {
    expect(() => parseDeepCasePayload({})).toThrow(JobPayloadError)
    expect(() => parseDeepCasePayload({ idProcessoTrf: 1, number: '0000000-00.2020.4.05.0000' }))
      .toThrow(/one of/i)
  })

  it('rejects a blank case number', () => {
    expect(() => parseDeepCasePayload({ number: '   ' })).toThrow(JobPayloadError)
  })
})

describe('parseDeepRangePayload', () => {
  it('reads the range and optional concurrency', () => {
    expect(parseDeepRangePayload({ fromId: 5, toId: 9, concurrency: 3 }))
      .toEqual({ fromId: 5, toId: 9, concurrency: 3 })
  })

  it('insists on both ends — a deep range has no watermark to resume from', () => {
    expect(() => parseDeepRangePayload({ fromId: 5 })).toThrow(JobPayloadError)
    expect(() => parseDeepRangePayload({ toId: 9 })).toThrow(JobPayloadError)
  })

  it('rejects a range that runs backwards', () => {
    expect(() => parseDeepRangePayload({ fromId: 9, toId: 5 })).toThrow(JobPayloadError)
  })
})
