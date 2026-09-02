import { describe, expect, it } from 'vitest'
import { declaredMovements, declaredParties } from '../src/data/sqlite/declared.ts'
import { explainFailure } from '../src/data/sqlite/failure-text.ts'

/**
 * The strings asserted here are the ones `packages/scraper/src/crawl/deep.ts`
 * actually writes — copied from `storeParties` and `checkMovementsTruncation`,
 * not invented — because that wording is the whole interface between the
 * scraper's discovery and this screen's number.
 */
describe('declared totals, read back out of a failure row', () => {
  it('sums the two polos the parties failure states', () => {
    expect(declaredParties(
      'Parsed 1 ativo / 10 passivo parties but the page states 1 / 40 — ' +
      'the Datascroller is hiding a further page, never followed by this scraper.',
    )).toBe(41)
  })

  it('refuses to half-count a polo whose own table was never found', () => {
    expect(declaredParties(
      'Parsed 3 ativo / 0 passivo parties but the page states 3 / ? — ' +
      'the Datascroller is hiding a further page, never followed by this scraper.',
    )).toBeNull()
    expect(declaredParties(
      'Parsed 0 ativo / 2 passivo parties but the page states ? / 2 — ' +
      'the Datascroller is hiding a further page, never followed by this scraper.',
    )).toBeNull()
  })

  it('reads the movements total the detail page stated', () => {
    expect(declaredMovements(
      'Parsed 12 movements from the summary PDF but the detail page states 39 — ' +
      'the "PDF has the complete log" assumption may have broken for this case.',
    )).toBe(39)
  })

  it('answers null for a message it does not recognise', () => {
    expect(declaredParties('429 after 5 attempts')).toBeNull()
    expect(declaredMovements('429 after 5 attempts')).toBeNull()
    // A parties message must not be read as a movements one, or vice versa.
    expect(declaredMovements('Parsed 1 ativo / 10 passivo parties but the page states 1 / 40 —')).toBeNull()
  })
})

describe('the two failures the interface can say in its own words', () => {
  it('turns the parties failure into the numbers under it', () => {
    expect(explainFailure(
      'parties',
      'Parsed 1 ativo / 10 passivo parties but the page states 1 / 40 — ' +
      'the Datascroller is hiding a further page, never followed by this scraper.',
    )).toContain('11 de 41 partes')
  })

  it('turns the movements failure into the numbers under it', () => {
    expect(explainFailure(
      'movements',
      'Parsed 12 movements from the summary PDF but the detail page states 39 — ' +
      'the "PDF has the complete log" assumption may have broken for this case.',
    )).toContain('12 de 39 movimientos')
  })

  it('leaves every other failure in the scraper\'s own exact words', () => {
    expect(explainFailure('document', 'Document 12039033 failed with a transient HTTP 429')).toBeNull()
    expect(explainFailure('deep_case', 'the action did not execute')).toBeNull()
    // A recognised kind whose message does not parse must not be paraphrased.
    expect(explainFailure('parties', 'something else entirely')).toBeNull()
  })
})
