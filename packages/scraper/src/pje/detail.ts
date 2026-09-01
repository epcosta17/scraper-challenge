import * as cheerio from 'cheerio'
import { HttpClient, decodeLatin1 } from '../http/client.ts'
import { HOST, detailUrl } from './urls.ts'

export interface BinaryDocumentRef {
  kind: 'binary'
  /** The document's id within the case's file. */
  id: number
  idBin: number
  numeroDocumento: string
  label: string
  date: string | null
  type: string | null
}

export interface HtmlDocumentRef {
  kind: 'html'
  id: number
  /** 112-hex, session-bound — only valid with the client that fetched the detail page. */
  ca: string
  label: string
  date: string | null
  type: string | null
}

export type DocumentRef = BinaryDocumentRef | HtmlDocumentRef

export class MalformedDocumentLinkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MalformedDocumentLinkError'
  }
}

const LABEL_RE = /(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})\s*-\s*.+?\s*\(([^()]+)\)\s*$/

/**
 * Every document row's visible text follows `<date> - <description> (<type>)`,
 * e.g. `24/07/2025 20:30:45 - Despacho (Despacho)`. The HTML-document variant
 * prefixes it with button boilerplate ("Visualizar documentos") that carries
 * no date of its own, so anchoring on the date pattern rather than trimming
 * a fixed prefix survives that difference.
 *
 * A row whose text doesn't match this shape still gets a document — the
 * label/date/type are metadata for display and the output filename, not
 * required to build the download URL — so this degrades to a null
 * date/type rather than throwing, unlike a malformed link (see below).
 */
function parseLabel(rawText: string): { label: string; date: string | null; type: string | null } {
  const text = rawText.replace(/\s+/g, ' ').trim()
  const m = LABEL_RE.exec(text)
  if (!m) return { label: text, date: null, type: null }
  const date = m[1]!
  const label = text.slice(text.indexOf(date))
  return { label, date, type: m[2]!.trim() }
}

/**
 * Parses a case detail page into its document list. Cheerio decodes HTML
 * entities for us (`&ccedil;` -> `ç`), so labels come out correctly
 * accented even though the page itself is ISO-8859-1.
 *
 * A link matching the binary/HTML shape but missing a param this parser
 * relies on to build a working download URL is a portal shape change, not
 * an absent document — it throws rather than silently dropping the row
 * (same philosophy as the dropped-row check in `search.ts`).
 */
export function parseDetailPage(html: string): DocumentRef[] {
  const $ = cheerio.load(html)
  const documents: DocumentRef[] = []

  $('a[href*="idBin="]').each((_, el) => {
    const href = $(el).attr('href')
    if (!href) return
    const url = new URL(href, HOST)
    const idBin = url.searchParams.get('idBin')
    const numeroDocumento = url.searchParams.get('numeroDocumento')
    const id = url.searchParams.get('idProcessoDocumento')
    if (!idBin || !numeroDocumento || !id) {
      throw new MalformedDocumentLinkError(
        `Binary document link is missing idBin/numeroDocumento/idProcessoDocumento: ${href}`,
      )
    }
    const { label, date, type } = parseLabel($(el).text())
    documents.push({ kind: 'binary', id: Number(id), idBin: Number(idBin), numeroDocumento, label, date, type })
  })

  $('[onclick*="documentoSemLoginHTML.seam"]').each((_, el) => {
    const onclick = $(el).attr('onclick') ?? ''
    // Captured live (see `tests/fixtures/detail-with-movement-popups.html`):
    // the case timeline's own "view movement" popups (id like
    // `processoEvento:N:...`) reuse this exact same endpoint and `ca`, but
    // never carry `idProcessoDoc` — they open a procedural movement, not a
    // document. Only an element that actually carries `idProcessoDoc` is a
    // document trigger at all; one missing it entirely is silently skipped
    // rather than treated as a malformed document link.
    if (!onclick.includes('idProcessoDoc=')) return
    const m = /documentoSemLoginHTML\.seam\?ca=([0-9a-f]+)&idProcessoDoc=(\d+)/.exec(onclick)
    if (!m) {
      throw new MalformedDocumentLinkError(`HTML document trigger is missing ca/idProcessoDoc: ${onclick}`)
    }
    const { label, date, type } = parseLabel($(el).text())
    documents.push({ kind: 'html', id: Number(m[2]), ca: m[1]!, label, date, type })
  })

  return documents
}

export type DetailResult =
  | { kind: 'valid'; documents: DocumentRef[] }
  | { kind: 'invalid' }

export class UnrecognisedDetailPageError extends Error {
  constructor(status: number, finalUrl: string) {
    super(
      `Detail page at ${finalUrl} (HTTP ${status}) looks like neither a real case page nor the ` +
      'known expired/invalid-ca page — the portal shape may have changed.',
    )
    this.name = 'UnrecognisedDetailPageError'
  }
}

// A real case page always prints the CNJ case number; the expired/invalid-ca
// page (see `tests/fixtures/detail-invalid-ca.html`, captured live from a
// 48-hex string of `a`s) never does, and instead prints this line. Checking
// the positive marker first means a portal-wide shape change — neither
// marker present — surfaces as a loud, distinct failure rather than being
// silently read as "invalid ca" (which would otherwise churn the search
// bridge forever) or "valid" with zero documents.
const CASE_NUMBER_RE = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/
const ACCESS_DENIED_MARKER = 'Acesso negado!'

/**
 * Fetches a case detail page by its (48-hex) `ca` and classifies it.
 *
 * `ca` is a cache, not a fact (see the module-level notes in `crawl/deep.ts`):
 * it expires after some hours, and an expired one renders a structurally
 * different page rather than erroring out at the HTTP level (still 200).
 * The caller is expected to re-derive `ca` through the search bridge and
 * retry once when `kind` comes back `'invalid'`.
 */
export async function fetchDetail(client: HttpClient, ca: string): Promise<DetailResult> {
  const res = await client.request(detailUrl(ca))
  const html = decodeLatin1(res.body)

  if (CASE_NUMBER_RE.test(html)) {
    return { kind: 'valid', documents: parseDetailPage(html) }
  }
  if (html.includes(ACCESS_DENIED_MARKER)) {
    return { kind: 'invalid' }
  }
  throw new UnrecognisedDetailPageError(res.status, res.url)
}
