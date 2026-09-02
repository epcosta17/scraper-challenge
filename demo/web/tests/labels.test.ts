import { describe, expect, it } from 'vitest'
import {
  agoLabel,
  captureLabel,
  clockLabel,
  courtDate,
  courtTimestamp,
  parseStoredTime,
  startOfTodayStored,
} from '../src/data/sqlite/labels.ts'

describe('stored timestamps', () => {
  it('reads what datetime(\'now\') writes as UTC, not as local time', () => {
    // The bug this guards: `new Date('2026-09-02 00:38:01')` is parsed as
    // local time, which shifts every "hace N min" by the machine's offset.
    expect(parseStoredTime('2026-09-02 00:38:01')?.toISOString())
      .toBe('2026-09-02T00:38:01.000Z')
  })

  it('has no time for a null or blank column', () => {
    expect(parseStoredTime(null)).toBeNull()
    expect(parseStoredTime('   ')).toBeNull()
  })

  it('starts today at local midnight, in the format the columns hold', () => {
    const value = startOfTodayStored(new Date(2026, 8, 2, 14, 30))
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(parseStoredTime(value)?.getHours()).toBe(0)
  })
})

describe('clockLabel', () => {
  it('prints a stored UTC time on the clock of whoever reads it', () => {
    const at = new Date(2026, 8, 1, 23, 48, 28)
    expect(clockLabel(at.toISOString().slice(0, 19).replace('T', ' '))).toBe('23:48:28')
    expect(clockLabel(null)).toBe('—')
  })
})

describe('agoLabel', () => {
  const now = new Date('2026-09-02T12:00:00Z')
  const ago = (ms: number): string =>
    agoLabel(new Date(now.getTime() - ms).toISOString().slice(0, 19).replace('T', ' '), now)

  it('steps through seconds, minutes, hours and days', () => {
    expect(ago(3_000)).toBe('hace 3 s')
    expect(ago(4 * 60_000)).toBe('hace 4 min')
    expect(ago(2 * 3_600_000)).toBe('hace 2 h')
    expect(ago(3 * 86_400_000)).toBe('hace 3 d')
  })

  it('says so when nothing has ever been captured', () => {
    expect(agoLabel(null, now)).toBe('nunca')
  })
})

describe('captureLabel', () => {
  it('names today and yesterday, and dates anything older', () => {
    const now = new Date(2026, 8, 2, 18, 0)
    // A local wall-clock time, in the UTC format the column holds, so the
    // assertions read the same in any timezone.
    const stored = (y: number, m: number, d: number, h: number, min: number): string =>
      new Date(y, m, d, h, min).toISOString().slice(0, 19).replace('T', ' ')

    expect(captureLabel(stored(2026, 8, 2, 14, 22), now)).toBe('hoy, 14:22')
    expect(captureLabel(stored(2026, 8, 1, 3, 11), now)).toBe('ayer, 03:11')
    expect(captureLabel(stored(2026, 7, 12, 9, 55), now)).toBe('12/08/2026, 09:55')
    expect(captureLabel(null, now)).toBe('—')
  })
})

describe('court dates, which are the tribunal\'s own text', () => {
  it('turns the portal\'s long Portuguese date into the design\'s short one', () => {
    expect(courtDate('22 de Agosto de 2026')).toBe('22/08/2026')
    expect(courtDate('1 de março de 2005')).toBe('01/03/2005')
  })

  it('keeps a date that already reads as one, dropping any clock after it', () => {
    expect(courtDate('09/04/2024 16:54:59')).toBe('09/04/2024')
    expect(courtDate('17/08/2026')).toBe('17/08/2026')
  })

  it('passes through anything it cannot parse rather than showing a dash', () => {
    expect(courtDate('sem data')).toBe('sem data')
    expect(courtDate(null)).toBeNull()
    expect(courtDate('  ')).toBeNull()
  })

  it('trims the seconds off a movement timestamp', () => {
    expect(courtTimestamp('01/09/2026 17:42:40')).toBe('01/09/2026 17:42')
    expect(courtTimestamp('01/09/2026 17:42')).toBe('01/09/2026 17:42')
    expect(courtTimestamp(null)).toBeNull()
  })
})
