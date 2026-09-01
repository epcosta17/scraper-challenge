import { HttpClient } from '../http/client.ts'
import { reportPdfUrl } from './urls.ts'

export type ReportResult =
  | { kind: 'pdf'; pdf: Buffer }
  | { kind: 'absent'; finalUrl: string }
  | { kind: 'transient'; status: number; finalUrl: string }

const PDF_MAGIC = '%PDF-'

// The known shape of the portal's own error.seam page (see
// `tests/fixtures/error-seam.html`, captured live). A 200 response is only
// ever classified `absent` when it actually looks like this — anything else
// 200-but-unrecognised (a maintenance page, a bot-manager interstitial, a
// login redirect, or any other portal-wide shape change) falls through to
// the `transient` path instead, so it gets retried and then recorded as a
// failure rather than silently counted as an expected miss. Both signals are
// derived straight from the fixture: the final URL the portal redirects
// absent/sealed requests to, and a diagnostic line the page always prints.
const ERROR_SEAM_URL_RE = /\/error\.seam(?:[;?]|$)/
const ERROR_SEAM_BODY_MARKER = 'Login: Falha ao obter'

function looksLikeErrorSeam(finalUrl: string, body: Buffer): boolean {
  if (ERROR_SEAM_URL_RE.test(finalUrl)) return true
  // Only reached for a non-PDF body, so this is HTML, not a multi-megabyte
  // binary — scanning the whole thing for the marker is cheap.
  return body.toString('latin1').includes(ERROR_SEAM_BODY_MARKER)
}

/**
 * Extra attempts made against a non-absent, non-PDF response before giving
 * up as `transient`. Measured live against the portal: a 404 on this
 * endpoint recovers within a handful of attempts roughly 40-60% of the
 * time (one unhealthy backend node behind the load balancer, not a real
 * miss), so a few retries here converts most of that flakiness into a
 * stored case instead of a lost one.
 */
const TRANSIENT_RETRIES = 3
const TRANSIENT_RETRY_DELAY_MS = 500

/**
 * Fetches a case summary PDF.
 *
 * The portal never signals absence with a clean 404 that means "gone
 * forever" — it produces two different non-PDF shapes and only the status
 * code tells them apart:
 *
 *  - HTTP 200 + HTML that actually looks like the known "error.seam" page
 *    (see `looksLikeErrorSeam`): a genuine miss — the id is unassigned or
 *    the case is sealed. Stable across retries; retrying it would only
 *    waste requests (roughly 15% of a full crawl lands here).
 *  - anything else (observed: HTTP 404 + HTML; also any *unrecognised* 200
 *    body — a maintenance page, a bot-manager interstitial, a login
 *    redirect, or any other portal-wide shape change): a transient failure
 *    — plausibly one unhealthy backend node, or a temporary outage — that
 *    may recover within a few attempts. Only after `TRANSIENT_RETRIES` extra
 *    attempts is this reported as `transient`, so the caller can record it
 *    as a retryable failure rather than either losing the case silently or
 *    misreporting a real outage as a wave of expected absences.
 *
 * Requires no session: the endpoint works cold, without cookies.
 */
export async function fetchReportPdf(client: HttpClient, id: number): Promise<ReportResult> {
  let last: { status: number; finalUrl: string } | undefined

  for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt++) {
    const res = await client.request(reportPdfUrl(id))

    if (res.body.subarray(0, 5).toString('latin1') === PDF_MAGIC) {
      return { kind: 'pdf', pdf: res.body }
    }
    if (res.status === 200 && looksLikeErrorSeam(res.url, res.body)) {
      return { kind: 'absent', finalUrl: res.url }
    }

    last = { status: res.status, finalUrl: res.url }
    if (attempt < TRANSIENT_RETRIES) await client.sleep(TRANSIENT_RETRY_DELAY_MS)
  }

  return { kind: 'transient', status: last!.status, finalUrl: last!.finalUrl }
}
