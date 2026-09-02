import { describe, expect, it } from 'vitest'
import { createPortalSearch } from '../src/data/portal.ts'

/**
 * The search screen talks to the court, so the thing worth testing without a
 * court is how it behaves when the answer is not results.
 *
 * A search that returned nothing and a search that never ran render the same
 * empty page unless the page is told which happened. Reporting an unreachable
 * portal as "0 results" would be the same silent lie the scraper refuses
 * everywhere else — it would say a case does not exist because a VPN was down.
 */
describe('what the portal search does when it cannot search', () => {
  const portal = createPortalSearch()

  it('refuses a one-word party before spending a request on it', async () => {
    const outcome = await portal.run({ party: 'silva' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('invalid')
    // Said about the field on screen, not about a CLI flag that is not there.
    expect(outcome.error).not.toMatch(/--party/)
    expect(outcome.error).toMatch(/dos palabras/)
  })

  it('refuses an OAB state with no number — the portal ignores it in silence', async () => {
    const outcome = await portal.run({ oabState: 'RN' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('invalid')
    expect(outcome.error).toMatch(/en silencio/)
  })

  it('refuses a date that is not dd/mm/yyyy', async () => {
    const outcome = await portal.run({ from: '2026-08-17' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('invalid')
    expect(outcome.error).toMatch(/dd\/mm\/aaaa/)
  })

  it('keeps a rule it has no translation for, rather than losing it', async () => {
    // `validateFilters` may grow a rule this module has not been taught. An
    // English sentence a person can act on beats a generic one they cannot.
    const outcome = await portal.run({ lawyer: 'angelo' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.length).toBeGreaterThan(0)
  })
})
