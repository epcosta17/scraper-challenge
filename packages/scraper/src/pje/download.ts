import * as cheerio from 'cheerio'
import { HttpClient, decodeLatin1 } from '../http/client.ts'
import { fetchClassifiedPdf } from './report.ts'
import { documentBinUrl, documentHtmlUrl } from './urls.ts'
import type { BinaryDocumentRef, HtmlDocumentRef } from './detail.ts'

export type DownloadResult =
  | { kind: 'pdf'; pdf: Buffer; fileName: string }
  | { kind: 'html'; text: string }
  | { kind: 'absent'; finalUrl: string }
  | { kind: 'transient'; status: number; finalUrl: string }

// The printable-page container on a judicial-act page (see
// `tests/fixtures/document-page-*.html`, captured live) — verified against
// six real documents across three different cases. Its class name reads as
// Portuguese for "sheet/page", which lines up with what it wraps: exactly
// the act's own letterhead, body and signature block, none of the
// surrounding chrome (doctype, head, stylesheets, scripts, navigation).
const ACT_CONTAINER_SELECTOR = '.folha'

/**
 * Extracts the judicial act's own text from the whole page
 * `documentoSemLoginHTML.seam` serves. A naive whole-page text dump stores
 * tens of kilobytes of boilerplate per document — measured live, 49-89 KB
 * pages down to well under 1-24 KB of actual act text — which would poison
 * anything indexing this column for search or feeding it to an LLM later.
 *
 * Falls back to the whole `<body>` text (scripts/styles still stripped) if
 * the expected container isn't found, rather than throwing or returning
 * nothing: a shape change should degrade to "too much text", never to a
 * lost document.
 */
export function extractActText(html: string): string {
  const $ = cheerio.load(html)
  const container = $(ACT_CONTAINER_SELECTOR)
  const scope = container.length > 0 ? container : $('body')
  const clone = scope.clone()
  clone.find('script, style').remove()
  return clone.text().replace(/[ \t]+/g, ' ').replace(/\n[ \t]*\n+/g, '\n').trim()
}

const FILENAME_RE = /filename\s*=\s*"?([^";]+)"?/i

/** Reads the real filename off `Content-Disposition: filename="Despacho"`. */
export function filenameFromContentDisposition(headers: Headers): string | null {
  const raw = headers.get('content-disposition')
  if (!raw) return null
  return FILENAME_RE.exec(raw)?.[1]?.trim() || null
}

/**
 * Downloads one document, binary or HTML.
 *
 * Binary: classified exactly as `fetchReportPdf` classifies the summary
 * PDF — success by the `%PDF-` magic bytes, a recognised error.seam
 * response as `absent`, anything else as a `transient` failure worth
 * retrying — by calling the same `fetchClassifiedPdf` rather than
 * duplicating that logic. The real filename comes from the response's own
 * `Content-Disposition`; the row's label is the fallback when that header
 * is absent.
 *
 * HTML: fetched with the same client (and so the same cookie jar) that
 * fetched the detail page `ref.ca` was harvested from — it is a
 * session-bound token, unlike the case's own `ca`, and will not resolve
 * under a different session. The returned text is the extracted act, not
 * the raw page — see `extractActText`. `ref.idProcessoDoc` is passed through
 * as-is, `null` included: see `documentHtmlUrl` for why a placeholder there
 * would break the fetch instead of merely being ignored.
 *
 * Takes only the two real variants — a `MalformedDocumentRef` (see
 * `detail.ts`) is never fetched at all; the caller (`crawl/deep.ts`) records
 * it as a failure without calling this function.
 */
export async function downloadDocument(
  client: HttpClient, ref: BinaryDocumentRef | HtmlDocumentRef,
): Promise<DownloadResult> {
  if (ref.kind === 'binary') {
    const result = await fetchClassifiedPdf(client, documentBinUrl(ref))
    if (result.kind !== 'pdf') return result
    const fileName = filenameFromContentDisposition(result.headers) ?? ref.label
    return { kind: 'pdf', pdf: result.pdf, fileName }
  }

  const res = await client.request(documentHtmlUrl(ref.ca, ref.idProcessoDoc))
  return { kind: 'html', text: extractActText(decodeLatin1(res.body)) }
}
