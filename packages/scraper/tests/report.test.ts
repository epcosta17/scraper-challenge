import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { HttpClient } from '../src/http/client.ts'
import { fetchReportPdf } from '../src/pje/report.ts'

const errorHtml = readFileSync(fileURLToPath(new URL('./fixtures/error-seam.html', import.meta.url)))

function clientReturning(body: Buffer, url: string, status = 200) {
  const fetchImpl = (async () => {
    const r = new Response(body, { status })
    Object.defineProperty(r, 'url', { value: url })
    return r
  }) as unknown as typeof fetch
  return new HttpClient({ fetchImpl, sleep: async () => {}, rps: 0 })
}

/** Returns each `responses` entry in turn, then repeats the last one forever. */
function clientCyclingThrough(responses: Array<{ body: Buffer; status: number; url: string }>) {
  let i = 0
  const fetchImpl = (async () => {
    const spec = responses[Math.min(i, responses.length - 1)]!
    i++
    const r = new Response(spec.body, { status: spec.status })
    Object.defineProperty(r, 'url', { value: spec.url })
    return r
  }) as unknown as typeof fetch
  return new HttpClient({ fetchImpl, sleep: async () => {}, rps: 0 })
}

describe('fetchReportPdf', () => {
  it('returns the PDF when the body carries the %PDF- magic', async () => {
    const pdf = Buffer.from('%PDF-1.4 fake body')
    const res = await fetchReportPdf(clientReturning(pdf, 'https://x/document.seam'), 130100)
    expect(res.kind).toBe('pdf')
    if (res.kind === 'pdf') expect(res.pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('classifies an HTML body as absent even though the status is 200', async () => {
    const res = await fetchReportPdf(clientReturning(errorHtml, 'https://x/error.seam'), 999999999)
    expect(res.kind).toBe('absent')
  })

  it('does not treat a 200 status as success on its own', async () => {
    const html = Buffer.from('<html>not a pdf</html>')
    const res = await fetchReportPdf(clientReturning(html, 'https://x/error.seam'), 1)
    expect(res.kind).toBe('absent')
  })

  // Live measurement against the portal: id 130101 returned 404+HTML on
  // most attempts and a PDF on a few, alternating, because one backend
  // node behind the load balancer was unhealthy — not because the case
  // doesn't exist (it had been crawled and stored successfully an hour
  // earlier). A 200+HTML response is a stable, permanent "absent"; a
  // non-200 non-PDF response is a *transient* failure that must be
  // retried instead of being filed as an expected miss.
  it('classifies a persistent non-200, non-PDF response as transient and preserves the status', async () => {
    const html = Buffer.from('<html>404 page</html>')
    const client = clientReturning(html, 'https://x/error.seam', 404)
    const res = await fetchReportPdf(client, 130101)
    expect(res.kind).toBe('transient')
    if (res.kind === 'transient') {
      expect(res.status).toBe(404)
      expect(res.finalUrl).toBe('https://x/error.seam')
    }
  })

  it('retries a transient 404 and returns the PDF once the server recovers', async () => {
    const html = Buffer.from('<html>404 page</html>')
    const pdf = Buffer.from('%PDF-1.4 fake body')
    const client = clientCyclingThrough([
      { body: html, status: 404, url: 'https://x/error.seam' },
      { body: pdf, status: 200, url: 'https://x/document.seam' },
    ])
    const res = await fetchReportPdf(client, 130101)
    expect(res.kind).toBe('pdf')
    if (res.kind === 'pdf') expect(res.pdf.subarray(0, 5).toString()).toBe('%PDF-')
    // Proves the second response was actually consulted, i.e. the retry ran.
    expect(client.attempts).toBe(2)
  })

  it('bounds the retry so an id that is permanently 404 does not retry forever', async () => {
    const html = Buffer.from('<html>404 page</html>')
    const client = clientReturning(html, 'https://x/error.seam', 404)
    const res = await fetchReportPdf(client, 130101)
    expect(res.kind).toBe('transient')
    // One initial attempt plus a small, fixed number of retries — not an
    // unbounded loop against an id that will never recover.
    expect(client.attempts).toBeGreaterThan(1)
    expect(client.attempts).toBeLessThanOrEqual(4)
  })

  // A portal-wide shape change (a maintenance page, a bot-manager
  // interstitial, a login redirect) can also come back as HTTP 200 + HTML.
  // Classifying every 200-non-PDF response as `absent` would make every id
  // look like a confirmed miss and silently stop the crawl after 50 of them
  // — the exact silent-wrong-answer this codebase exists to prevent. Only a
  // response that actually looks like the known error.seam page — by its
  // final URL or a marker in its body, both derived from the real fixture —
  // may be classified `absent`; anything else 200-but-unrecognised must be
  // `transient` so it gets retried and then recorded as a failure.
  it('classifies the real error.seam fixture as absent by its body marker, even at an unrelated URL', async () => {
    const client = clientReturning(errorHtml, 'https://x/some-other-path', 200)
    const res = await fetchReportPdf(client, 999999999)
    expect(res.kind).toBe('absent')
  })

  it('classifies an unrecognised 200 HTML body as transient rather than a silent absence', async () => {
    const html = Buffer.from('<html>maintenance</html>')
    const client = clientReturning(html, 'https://x/portal-home', 200)
    const res = await fetchReportPdf(client, 42)
    expect(res.kind).toBe('transient')
    if (res.kind === 'transient') {
      expect(res.status).toBe(200)
      expect(res.finalUrl).toBe('https://x/portal-home')
    }
  })
})
