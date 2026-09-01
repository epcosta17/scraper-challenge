import { describe, it, expect } from 'vitest'
import { HttpClient } from '../src/http/client.ts'
import { startSession } from '../src/pje/session.ts'
import { search } from '../src/pje/search.ts'
import { fetchReportPdf } from '../src/pje/report.ts'
import { parseCaseRecord } from '../src/pdf/parse.ts'

// Opt-in: these tests hit the live portal. Run with `PJE_LIVE=1 npm test`.
// The default suite must never touch the network, so this whole block is
// skipped unless the gate is explicitly set.
const live = process.env.PJE_LIVE === '1' ? describe : describe.skip

live('live portal', () => {
  // A low rate against a real government server, not the fixture-driven
  // rps:0 used everywhere else in this test suite.
  const client = () => new HttpClient({ rps: 1 })

  it('resolves the known case number to its known internal id', async () => {
    // Regression control. The real search submit parameter is a JSF-generated
    // id (`fPP:j_id244` today) read from the page at runtime — see
    // `parseSessionFromHtml`. If a portal redeploy changes it and the client
    // fails to pick up the new value, `search()` would silently post to the
    // wrong parameter and the portal would report zero results for every
    // query, with no error. Pinning this one known number/id pair turns that
    // into a loud, immediate test failure instead.
    const c = client()
    const session = await startSession(c)
    const outcome = await search(c, session, { number: '0013201-41.2025.4.05.8202' })
    expect(outcome.rows).toHaveLength(1)
    expect(outcome.rows[0]!.idProcessoTrf).toBe(129921)
  })

  it('fetches a summary PDF cold, with no session', async () => {
    // No `startSession` call here on purpose: `reportPDF.seam` is stateless
    // and must work without cookies or a prior page visit.
    const res = await fetchReportPdf(client(), 130100)
    expect(res.kind).toBe('pdf')
    if (res.kind === 'pdf') {
      expect(parseCaseRecord(res.pdf).number).toMatch(/^\d{7}-\d{2}\./)
    }
  })

  it('classifies an out-of-range id as absent, not transient', async () => {
    // `ReportResult` has three variants. 999999999 is far past the observed
    // upper bound of the idProcessoTrf counter, so the portal returns HTTP
    // 200 with the recognised error page, which `fetchReportPdf` classifies
    // as 'absent'. That is a different thing from 'transient' (anything
    // else that survived every retry — a non-200 response, or an HTTP 200
    // with an unrecognised body): an absent id is an expected miss recorded
    // in `probes`, while a transient result is a retryable server failure
    // recorded in `failures`. Asserting `res.kind === 'absent'` alone would
    // let a regression that turns this into 'transient' pass silently (both
    // are "not pdf"), so spell out why that distinction matters when it
    // fails.
    const res = await fetchReportPdf(client(), 999999999)
    expect(
      res.kind,
      res.kind === 'transient'
        ? `expected 'absent' (an expected miss) but got 'transient' ` +
          `(HTTP ${res.status} from ${res.finalUrl}) — a retryable server failure, ` +
          `which is a different outcome and must not be conflated with an absent case`
        : `expected 'absent', got '${res.kind}'`,
    ).toBe('absent')
  })
})
