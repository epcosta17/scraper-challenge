import { HttpClient } from '../http/client.ts'
import { reportPdfUrl } from './urls.ts'

export type ReportResult =
  | { kind: 'pdf'; pdf: Buffer }
  | { kind: 'absent'; finalUrl: string }

const PDF_MAGIC = '%PDF-'

/**
 * Fetches a case summary PDF.
 *
 * Absent, secret and out-of-range ids all return HTTP **200** with an HTML
 * error page, so the status code cannot be used to decide success. The only
 * reliable discriminator is the leading magic bytes of the body.
 *
 * Requires no session: the endpoint works cold, without cookies.
 */
export async function fetchReportPdf(client: HttpClient, id: number): Promise<ReportResult> {
  const res = await client.request(reportPdfUrl(id))
  if (res.body.subarray(0, 5).toString('latin1') === PDF_MAGIC) {
    return { kind: 'pdf', pdf: res.body }
  }
  return { kind: 'absent', finalUrl: res.url }
}
