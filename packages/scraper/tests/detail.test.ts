import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { HttpClient } from '../src/http/client.ts'
import {
  parseDetailPage, fetchDetail, MalformedDocumentLinkError, UnrecognisedDetailPageError,
  type BinaryDocumentRef, type HtmlDocumentRef,
} from '../src/pje/detail.ts'

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))

const detailWithDocs = fixture('detail-with-docs.html').toString('latin1')
const detailHtmlOnly = fixture('detail-html-docs-only.html').toString('latin1')
const detailInvalidCa = fixture('detail-invalid-ca.html').toString('latin1')

function clientReturning(body: string, status = 200, url = 'https://x/listView.seam') {
  const fetchImpl = (async () => {
    const r = new Response(Buffer.from(body, 'latin1'), { status })
    Object.defineProperty(r, 'url', { value: url })
    return r
  }) as unknown as typeof fetch
  return new HttpClient({ fetchImpl, sleep: async () => {}, rps: 0 })
}

describe('parseDetailPage', () => {
  it('parses a case with both binary and HTML documents (0801438-34.2016.4.05.8102)', () => {
    const docs = parseDetailPage(detailWithDocs)
    const binary = docs.filter((d): d is BinaryDocumentRef => d.kind === 'binary')
    const html = docs.filter((d): d is HtmlDocumentRef => d.kind === 'html')
    expect(binary).toHaveLength(9)
    expect(html).toHaveLength(1)
  })

  it('extracts all four required fields for a binary document', () => {
    const docs = parseDetailPage(detailWithDocs)
    const first = docs.find((d): d is BinaryDocumentRef => d.kind === 'binary' && d.id === 12284583)
    expect(first).toMatchObject({
      kind: 'binary',
      id: 12284583,
      idBin: 12039033,
      numeroDocumento: '4caf3e2af32f9130b384fc0c2aef62251e2b3823',
      date: '24/07/2025 20:30:45',
      type: 'Despacho',
    })
    expect(first!.label).toBe('24/07/2025 20:30:45 - Despacho (Despacho)')
  })

  it('decodes accented HTML entities in the label', () => {
    const docs = parseDetailPage(detailWithDocs)
    const decisao = docs.find((d) => d.type === 'Decisão')
    expect(decisao).toBeDefined()
    expect(decisao!.label).toContain('Decisão')
  })

  it('extracts the session-bound ca and id for an HTML document', () => {
    const docs = parseDetailPage(detailWithDocs)
    const html = docs.find((d): d is HtmlDocumentRef => d.kind === 'html')
    expect(html).toMatchObject({ kind: 'html', id: 12284587 })
    expect(html!.ca).toMatch(/^[0-9a-f]{112}$/)
    expect(html!.date).toBe('13/02/2026 14:32:27')
  })

  it('parses a case with only HTML documents and zero binary ones (0005425-26.2026.4.05.8308)', () => {
    const docs = parseDetailPage(detailHtmlOnly)
    expect(docs.filter((d) => d.kind === 'binary')).toHaveLength(0)
    expect(docs.filter((d) => d.kind === 'html')).toHaveLength(2)
  })

  it('throws on a binary link missing a required parameter instead of silently dropping it', () => {
    const broken = detailWithDocs.replace('numeroDocumento=4caf3e2af32f9130b384fc0c2aef62251e2b3823&amp;', '')
    expect(() => parseDetailPage(broken)).toThrow(MalformedDocumentLinkError)
  })
})

describe('fetchDetail', () => {
  it('classifies a real case page (with documents) as valid', async () => {
    const res = await fetchDetail(clientReturning(detailWithDocs), 'ca'.repeat(24))
    expect(res.kind).toBe('valid')
    if (res.kind === 'valid') expect(res.documents).toHaveLength(10)
  })

  it('classifies the HTML-only case page as valid too', async () => {
    const res = await fetchDetail(clientReturning(detailHtmlOnly), 'ca'.repeat(24))
    expect(res.kind).toBe('valid')
    if (res.kind === 'valid') expect(res.documents).toHaveLength(2)
  })

  // Captured live: a `ca` of 48 `a`s produces a 200 response with the same
  // "Detalhe do Processo" title as a real case page, but none of the real
  // content — only this diagnostic. If a stale `ca` were misclassified as
  // valid, the caller would report a real case as having zero documents
  // instead of re-deriving `ca` through the search bridge.
  it('classifies the captured invalid/expired-ca page as invalid', async () => {
    const res = await fetchDetail(clientReturning(detailInvalidCa), 'a'.repeat(48))
    expect(res.kind).toBe('invalid')
  })

  it('throws on a response that looks like neither a real case page nor the known invalid-ca page', async () => {
    await expect(fetchDetail(clientReturning('<html>maintenance</html>', 200), 'x'.repeat(48)))
      .rejects.toThrow(UnrecognisedDetailPageError)
  })
})
