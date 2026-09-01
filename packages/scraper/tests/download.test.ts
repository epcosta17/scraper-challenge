import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { HttpClient } from '../src/http/client.ts'
import { downloadDocument, filenameFromContentDisposition, extractActText } from '../src/pje/download.ts'
import type { BinaryDocumentRef, HtmlDocumentRef } from '../src/pje/detail.ts'

const samplePdf = readFileSync(fileURLToPath(new URL('./fixtures/sample-document.pdf', import.meta.url)))
const errorHtml = readFileSync(fileURLToPath(new URL('./fixtures/error-seam.html', import.meta.url)))
const despachoPage = readFileSync(fileURLToPath(new URL('./fixtures/document-page-despacho.html', import.meta.url)), 'latin1')
const sentencaPage = readFileSync(fileURLToPath(new URL('./fixtures/document-page-sentenca.html', import.meta.url)), 'latin1')

const binaryRef: BinaryDocumentRef = {
  kind: 'binary',
  id: 12284583,
  idBin: 12039033,
  numeroDocumento: '4caf3e2af32f9130b384fc0c2aef62251e2b3823',
  label: '24/07/2025 20:30:45 - Despacho (Despacho)',
  date: '24/07/2025 20:30:45',
  type: 'Despacho',
}

const htmlRef: HtmlDocumentRef = {
  kind: 'html',
  id: 12284587,
  ca: 'deadbeef'.repeat(14),
  idProcessoDoc: 12284587,
  label: '13/02/2026 14:32:27 - Despacho (Despacho)',
  date: '13/02/2026 14:32:27',
  type: 'Despacho',
}

function clientReturning(body: Buffer, opts: { status?: number; url?: string; headers?: Record<string, string> } = {}) {
  const fetchImpl = (async () => {
    const r = new Response(body, { status: opts.status ?? 200, headers: opts.headers })
    Object.defineProperty(r, 'url', { value: opts.url ?? 'https://x/listView.seam' })
    return r
  }) as unknown as typeof fetch
  return new HttpClient({ fetchImpl, sleep: async () => {}, rps: 0 })
}

describe('filenameFromContentDisposition', () => {
  it('reads a quoted filename', () => {
    expect(filenameFromContentDisposition(new Headers({ 'content-disposition': 'filename="Despacho"' })))
      .toBe('Despacho')
  })

  it('returns null when the header is absent', () => {
    expect(filenameFromContentDisposition(new Headers())).toBeNull()
  })
})

describe('downloadDocument — binary', () => {
  it('downloads the PDF and reads the real filename off Content-Disposition', async () => {
    const client = clientReturning(samplePdf, { headers: { 'content-disposition': 'filename="Despacho"' } })
    const res = await downloadDocument(client, binaryRef)
    expect(res.kind).toBe('pdf')
    if (res.kind === 'pdf') {
      expect(res.pdf.subarray(0, 5).toString()).toBe('%PDF-')
      expect(res.fileName).toBe('Despacho')
    }
  })

  it('falls back to the row label when Content-Disposition is absent', async () => {
    const client = clientReturning(samplePdf)
    const res = await downloadDocument(client, binaryRef)
    expect(res.kind).toBe('pdf')
    if (res.kind === 'pdf') expect(res.fileName).toBe(binaryRef.label)
  })

  it('classifies a recognised error.seam response as absent, reusing fetchReportPdf\'s classifier', async () => {
    const client = clientReturning(errorHtml, { url: 'https://x/error.seam' })
    const res = await downloadDocument(client, binaryRef)
    expect(res.kind).toBe('absent')
  })

  it('classifies a persistent non-PDF, non-error-seam response as transient', async () => {
    const client = clientReturning(Buffer.from('<html>404</html>'), { status: 404 })
    const res = await downloadDocument(client, binaryRef)
    expect(res.kind).toBe('transient')
    if (res.kind === 'transient') expect(res.status).toBe(404)
  })
})

describe('extractActText', () => {
  // Captured live: two real judicial-act pages, a short DESPACHO and a
  // long SENTENÇA, from two different cases. Verified against six such
  // pages across three cases in total (see download.ts's doc comment);
  // these two are committed as fixtures for the two ends of that range.
  it('isolates a short DESPACHO from its surrounding page (49,069 -> well under 1,000 chars)', () => {
    const text = extractActText(despachoPage)
    expect(text.length).toBeLessThan(1000)
    expect(text).toContain('PODER JUDICIÁRIO')
    expect(text).toContain('DESPACHO')
    expect(text).toContain('0800120-05.2024.4.05.8306')
    expect(text).not.toContain('<!DOCTYPE')
    expect(text).not.toContain('<script')
    expect(text).not.toContain('@media print')
  })

  it('isolates a long SENTENÇA from its surrounding page (89,058 -> well under 25,000 chars)', () => {
    const text = extractActText(sentencaPage)
    expect(text.length).toBeLessThan(25000)
    expect(text).toContain('SENTENÇA')
    expect(text).toContain('0005425-26.2026.4.05.8308')
    expect(text).not.toContain('<!DOCTYPE')
    expect(text).not.toContain('<script')
  })

  it('falls back to the body text, scripts and styles still stripped, when .folha is absent', () => {
    const html = '<html><head><style>p{color:red}</style></head>' +
      '<body><script>var x=1;</script><p>ato judicial</p></body></html>'
    expect(extractActText(html)).toBe('ato judicial')
  })
})

describe('downloadDocument — html', () => {
  it('fetches and extracts the judicial act text with the same client the ca was harvested with', async () => {
    const client = clientReturning(Buffer.from(despachoPage, 'latin1'))
    const res = await downloadDocument(client, htmlRef)
    expect(res.kind).toBe('html')
    if (res.kind === 'html') {
      expect(res.text.length).toBeLessThan(despachoPage.length)
      expect(res.text).toContain('DESPACHO')
      expect(res.text).not.toContain('<!DOCTYPE')
    }
  })

  // A case's procedural-movement timeline links to a document this same
  // way but with no idProcessoDoc at all (see detail.test.ts) — verified
  // live that appending any value for it, even a placeholder, breaks the
  // fetch outright. The request URL must omit the param entirely, not send
  // some synthetic stand-in.
  it('omits idProcessoDoc from the request URL when the ref carries none', async () => {
    let requestedUrl = ''
    const fetchImpl = (async (url: string | URL) => {
      requestedUrl = String(url)
      const r = new Response(Buffer.from(despachoPage, 'latin1'), { status: 200 })
      Object.defineProperty(r, 'url', { value: String(url) })
      return r
    }) as unknown as typeof fetch
    const client = new HttpClient({ fetchImpl, sleep: async () => {}, rps: 0 })

    await downloadDocument(client, { ...htmlRef, idProcessoDoc: null })

    expect(requestedUrl).toContain(`ca=${htmlRef.ca}`)
    expect(requestedUrl).not.toContain('idProcessoDoc')
  })
})
