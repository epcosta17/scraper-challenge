import { describe, it, expect } from 'vitest'
import { backoffDelay, retryAfterMs, DEFAULT_BACKOFF } from '../src/http/backoff.ts'

describe('backoffDelay', () => {
  it('grows exponentially from the base delay', () => {
    const noJitter = () => 0.5 // maps to zero jitter offset
    expect(backoffDelay(0, {}, noJitter)).toBe(1000)
    expect(backoffDelay(1, {}, noJitter)).toBe(2000)
    expect(backoffDelay(2, {}, noJitter)).toBe(4000)
    expect(backoffDelay(3, {}, noJitter)).toBe(8000)
  })

  it('caps the delay', () => {
    const noJitter = () => 0.5
    expect(backoffDelay(20, {}, noJitter)).toBe(DEFAULT_BACKOFF.capMs)
  })

  it('applies jitter within the configured band', () => {
    expect(backoffDelay(1, {}, () => 0)).toBe(1500)   // -25%
    expect(backoffDelay(1, {}, () => 1)).toBe(2500)   // +25%
  })

  it('never returns a negative delay', () => {
    expect(backoffDelay(0, { baseMs: 10 }, () => 0)).toBeGreaterThanOrEqual(0)
  })

  it('never exceeds the cap once jitter is applied', () => {
    expect(backoffDelay(20, {}, () => 1)).toBeLessThanOrEqual(DEFAULT_BACKOFF.capMs)
    expect(backoffDelay(20, {}, () => 1)).toBe(DEFAULT_BACKOFF.capMs)
    expect(backoffDelay(20, {}, () => 0)).toBe(45_000)  // cap minus 25%
  })
})

describe('retryAfterMs', () => {
  it('parses delay-seconds form', () => {
    expect(retryAfterMs('120')).toBe(120_000)
  })

  it('parses HTTP-date form', () => {
    const now = new Date('2026-08-31T12:00:00Z')
    expect(retryAfterMs('Mon, 31 Aug 2026 12:00:30 GMT', now)).toBe(30_000)
  })

  it('returns null for missing or unparseable headers', () => {
    expect(retryAfterMs(null)).toBeNull()
    expect(retryAfterMs('soon')).toBeNull()
  })

  it('clamps past dates to zero rather than going negative', () => {
    const now = new Date('2026-08-31T12:00:00Z')
    expect(retryAfterMs('Mon, 31 Aug 2026 11:59:00 GMT', now)).toBe(0)
  })
})
