import * as cheerio from 'cheerio'
import { HttpClient, decodeLatin1 } from '../http/client.ts'
import { fetchClassifiedPdf } from './report.ts'
import { encodeSearchBody } from './search.ts'
import { HOST, documentBinUrl, documentHtmlUrl } from './urls.ts'
import type { BinaryDocumentRef, HtmlDocumentRef } from './detail.ts'

/**
 * What became of a judicial act's own PDF (see `downloadActPdf`).
 *
 * `'none'` and `'failed'` are deliberately two different things: a page
 * that offers no download at all is a legitimate shape and nobody's fault,
 * while a download that was offered and then didn't produce a PDF is a
 * failure worth recording. Neither one may cost the act's text.
 */
export type ActPdfResult =
  | { kind: 'pdf'; pdf: Buffer }
  | { kind: 'none' }
  | { kind: 'failed'; reason: string }

export type DownloadResult =
  | { kind: 'pdf'; pdf: Buffer; fileName: string }
  | { kind: 'html'; text: string; pdf: ActPdfResult }
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
 * Everything the POST that downloads a judicial act as a PDF needs, read
 * off the act page itself (see `parseActPdfForm`).
 */
export interface ActPdfForm {
  /**
   * The JSF-generated form id — `j_id42` on both fixtures, but generated
   * per page and never to be hardcoded; the same discipline `session.ts`
   * applies to the search form's submit parameter. Goes into the body
   * twice over: once as JSF's own `<formId>=<formId>` marker, and once as
   * the prefix of `submitParam`.
   */
  formId: string
  /** The form's own action, resolved absolute against `HOST`. */
  actionUrl: string
  /** The command key the trigger spells out, `<formId>:downloadPDF`. */
  submitParam: string
  /** `javax.faces.ViewState` — `j_id4` on one fixture, `j_id3` on the other. */
  viewState: string
  /**
   * The act's own 112-hex token, out of the trigger. Neither the case's
   * 48-hex `ca` nor the (also different) one in the act page's URL will do
   * here; like both of those it is session-bound, so this POST has to run
   * on the same client, and the same cookie jar, that fetched the page.
   */
  ca: string
  /** The act's binary id — captured nowhere else in this scraper. */
  idProcDocBin: string
}

// The act page's download form and, inside it, the hidden ViewState and the
// `jsfcljs(...)` trigger the "Gerar PDF" anchor fires. Read with regular
// expressions rather than a DOM walk for the same reason `session.ts` does:
// the interesting half is JavaScript inside an attribute, not markup.
const ACT_FORM_TAG_RE = /<form\b[^>]*\baction="[^"]*documentoSemLoginHTML\.seam[^"]*"[^>]*>/i
const FORM_ID_RE = /\bid="([^"]+)"/
const FORM_ACTION_RE = /\baction="([^"]+)"/
const VIEW_STATE_RE = /name="javax\.faces\.ViewState"[^>]*\bvalue="([^"]*)"/
const DOWNLOAD_TRIGGER_RE =
  /\{\s*'([^']+):downloadPDF'\s*:\s*'[^']*'\s*,\s*'ca'\s*:\s*'([0-9a-f]+)'\s*,\s*'idProcDocBin'\s*:\s*'(\d+)'/

/**
 * Parses the "Gerar PDF" form out of a judicial-act page.
 *
 * Returns `null` — cleanly, not by throwing — when the page carries no such
 * form: an act served without a download offer is a legitimate shape, and
 * the caller must still keep the act's text (see `downloadDocument`). Every
 * field is taken from the page on every request: all four are per-page
 * values, and three of them (`viewState`, `ca`, `idProcDocBin`) genuinely
 * differ between the two committed fixtures.
 */
export function parseActPdfForm(html: string): ActPdfForm | null {
  const tag = ACT_FORM_TAG_RE.exec(html)
  if (!tag) return null

  const formId = FORM_ID_RE.exec(tag[0])?.[1]
  const action = FORM_ACTION_RE.exec(tag[0])?.[1]
  // Scoped to what follows the opening tag, so a page that ever grows a
  // second form can't have this one's ViewState read out of that one.
  const insideForm = html.slice(tag.index + tag[0].length)
  const viewState = VIEW_STATE_RE.exec(insideForm)?.[1]
  const trigger = DOWNLOAD_TRIGGER_RE.exec(insideForm)
  if (!formId || !action || !viewState || !trigger) return null

  return {
    formId,
    actionUrl: action.startsWith('http') ? action : HOST + action,
    submitParam: `${trigger[1]}:downloadPDF`,
    viewState,
    ca: trigger[2]!,
    idProcDocBin: trigger[3]!,
  }
}

/**
 * Downloads a judicial act as a PDF, by submitting the very form its own
 * page carries (see `parseActPdfForm`).
 *
 * Runs on the same client — and so the same cookie jar — that fetched
 * `html` from `actUrl`: the `ca` in that form is session-bound exactly like
 * the one in the act's URL, and the server rejects it from anywhere else.
 * That is also why the act page's own URL goes back as the `Referer`.
 *
 * Success is the `%PDF-` magic bytes and nothing else — the classification
 * is `fetchClassifiedPdf`'s, the same one behind every other PDF in this
 * scraper, rather than a second opinion written here. Anything short of a
 * PDF comes back as `'failed'` with a reason for the failures table, never
 * as a thrown error: the caller still has the act's text to store.
 */
export async function downloadActPdf(
  client: HttpClient, actUrl: string, html: string,
): Promise<ActPdfResult> {
  const form = parseActPdfForm(html)
  if (!form) return { kind: 'none' }

  // JSF wants the form's own id echoed back as a field of its own, on top
  // of the command key that says which button was pressed.
  const body = encodeSearchBody({
    [form.formId]: form.formId,
    'javax.faces.ViewState': form.viewState,
    [form.submitParam]: form.submitParam,
    'ca': form.ca,
    'idProcDocBin': form.idProcDocBin,
  })

  const result = await fetchClassifiedPdf(client, form.actionUrl, {
    init: {
      method: 'POST',
      body,
      // Same charset the search POST declares, and for the same reason —
      // see `encodeFormComponent` in `search.ts`.
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=ISO-8859-1',
        'Referer': actUrl,
      },
    },
  })

  if (result.kind === 'pdf') return { kind: 'pdf', pdf: result.pdf }
  return {
    kind: 'failed',
    reason: result.kind === 'absent'
      ? `the act's PDF download came back as a recognised error page: ${result.finalUrl}`
      : `the act's PDF download came back as a non-PDF HTTP ${result.status} from ${result.finalUrl}`,
  }
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
 * the raw page — see `extractActText` — and it comes back with the act's
 * own PDF beside it (see `downloadActPdf`), which costs one further request
 * per act. Only the text is guaranteed: an act whose PDF is not on offer,
 * or does not download, still returns its text with the PDF's absence
 * described rather than thrown. `ref.idProcessoDoc` is always a real
 * id by the time it reaches here — a trigger with none is a timeline
 * reference, not a document, and never becomes an `HtmlDocumentRef` at all
 * (see `parseDetailPage`) — but `documentHtmlUrl` still accepts (and
 * correctly omits) a `null` one, since that endpoint contract is worth
 * keeping documented and tested on its own.
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

  const url = documentHtmlUrl(ref.ca, ref.idProcessoDoc)
  const res = await client.request(url)
  const html = decodeLatin1(res.body)
  // One extra request per act, deliberately: the act's text feeds the
  // full-text index and its PDF is what a reader actually wants to open,
  // and the page this GET already paid for is the only place the form
  // behind that PDF exists.
  return { kind: 'html', text: extractActText(html), pdf: await downloadActPdf(client, url, html) }
}
