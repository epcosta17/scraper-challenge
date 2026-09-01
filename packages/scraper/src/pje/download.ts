import { HttpClient, decodeLatin1 } from '../http/client.ts'
import { fetchClassifiedPdf } from './report.ts'
import { documentBinUrl, documentHtmlUrl } from './urls.ts'
import type { DocumentRef } from './detail.ts'

export type DownloadResult =
  | { kind: 'pdf'; pdf: Buffer; fileName: string }
  | { kind: 'html'; html: string }
  | { kind: 'absent'; finalUrl: string }
  | { kind: 'transient'; status: number; finalUrl: string }

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
 * under a different session.
 */
export async function downloadDocument(client: HttpClient, ref: DocumentRef): Promise<DownloadResult> {
  if (ref.kind === 'binary') {
    const result = await fetchClassifiedPdf(client, documentBinUrl(ref))
    if (result.kind !== 'pdf') return result
    const fileName = filenameFromContentDisposition(result.headers) ?? ref.label
    return { kind: 'pdf', pdf: result.pdf, fileName }
  }

  const res = await client.request(documentHtmlUrl(ref.ca, ref.id))
  return { kind: 'html', html: decodeLatin1(res.body) }
}
