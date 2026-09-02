import { describe, expect, it } from 'vitest'
import { describeTarget, isJobKind, parseTarget } from '../src/data/sqlite/jobs.ts'
import { HIGHLIGHT_END, HIGHLIGHT_START, toSegments } from '../src/data/sqlite/snippet.ts'

describe('what a typed target becomes in the payload', () => {
  it('takes a case number or an internal id for a single-case job', () => {
    expect(parseTarget('deep_case', '0800120-05.2024.4.05.8306'))
      .toEqual({ ok: true, payload: { number: '0800120-05.2024.4.05.8306' } })
    expect(parseTarget('refresh_case', ' 130105 '))
      .toEqual({ ok: true, payload: { idProcessoTrf: 130105 } })
  })

  it('refuses a range where the worker expects one case', () => {
    const parsed = parseTarget('deep_case', '130100-130400')
    expect(parsed.ok).toBe(false)
  })

  it('takes a range for a deep range, however it was written', () => {
    for (const written of ['130100-130400', '130100–130400', '130100..130400', 'ids 130100–130400']) {
      expect(parseTarget('deep_range', written))
        .toEqual({ ok: true, payload: { fromId: 130100, toId: 130400 } })
    }
  })

  it('will not enqueue a deep range with no range, or one that runs backwards', () => {
    expect(parseTarget('deep_range', '').ok).toBe(false)
    expect(parseTarget('deep_range', '130400-130100').ok).toBe(false)
  })

  it('lets a crawl run from the watermark with no target at all', () => {
    expect(parseTarget('crawl', '')).toEqual({ ok: true, payload: {} })
    expect(parseTarget('crawl', '130100-130400'))
      .toEqual({ ok: true, payload: { fromId: 130100, toId: 130400 } })
  })

  it('reads a payload back as the line the queue shows', () => {
    expect(describeTarget({ number: '0800120-05.2024.4.05.8306' })).toBe('0800120-05.2024.4.05.8306')
    expect(describeTarget({ idProcessoTrf: 130105 })).toBe('id 130105')
    expect(describeTarget({ fromId: 130100, toId: 130400 })).toBe('ids 130100–130400')
    expect(describeTarget({})).toBe('desde la marca de agua')
    // A payload some other enqueuer wrote still describes itself.
    expect(describeTarget({ uf: 'PE' })).toBe('{"uf":"PE"}')
  })

  it('only offers the job types this form is meant to create', () => {
    expect(isJobKind('deep_case')).toBe(true)
    expect(isJobKind('crawl')).toBe(true)
    // Superseded by `crawl`, which is the same work with and without a range.
    // The worker still runs rows that say this, so the queue must be able to
    // show one — but nothing here should be creating any more of them.
    expect(isJobKind('discover')).toBe(false)
    expect(isJobKind('backfill')).toBe(false)
    expect(isJobKind('vaciar_todo')).toBe(false)
  })
})

describe('snippet segments', () => {
  const START = HIGHLIGHT_START
  const END = HIGHLIGHT_END

  it('splits the fragment into matched and unmatched runs', () => {
    expect(toSegments(`…julgo ${START}extinto${END} o feito…`)).toEqual([
      { text: '…julgo ', hit: false },
      { text: 'extinto', hit: true },
      { text: ' o feito…', hit: false },
    ])
  })

  it('keeps a fragment that carries no marker at all', () => {
    expect(toSegments('sem marcação')).toEqual([{ text: 'sem marcação', hit: false }])
  })

  it('does not lose the text of an unclosed marker', () => {
    expect(toSegments(`antes ${START}roto`).map((s) => s.text).join('')).toContain('roto')
  })
})
