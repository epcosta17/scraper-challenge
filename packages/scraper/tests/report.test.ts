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
})
