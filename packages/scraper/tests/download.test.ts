import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { HttpClient } from '../src/http/client.ts'
import { downloadDocument, filenameFromContentDisposition } from '../src/pje/download.ts'
import type { BinaryDocumentRef, HtmlDocumentRef } from '../src/pje/detail.ts'

const samplePdf = readFileSync(fileURLToPath(new URL('./fixtures/sample-document.pdf', import.meta.url)))
const errorHtml = readFileSync(fileURLToPath(new URL('./fixtures/error-seam.html', import.meta.url)))

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

describe('downloadDocument — html', () => {
  it('fetches the judicial act text with the same client the ca was harvested with', async () => {
    const html = '<html><body>ato judicial</body></html>'
    const client = clientReturning(Buffer.from(html, 'latin1'))
    const res = await downloadDocument(client, htmlRef)
    expect(res).toEqual({ kind: 'html', html })
  })
})
