import { createHash } from 'node:crypto'
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
  /**
   * The document's id within the case's file: the real `idProcessoDoc` when
   * the trigger carried one, otherwise a synthetic id derived from the case
   * number and label (see `syntheticDocId`) — never `null`, so every other
   * part of the pipeline (`isDocumentDownloaded`, `upsertDocument`, progress
   * reporting) can treat every `DocumentRef` uniformly.
   */
  id: number
  /** 112-hex, session-bound and short-lived — see `documentHtmlUrl`. */
  ca: string
  /**
   * The real `idProcessoDoc` query param, when the trigger had one. `null`
   * for a case's procedural-movement timeline, which links to a document
   * this same way but never carries this param (see `parseDetailPage`) —
   * `documentHtmlUrl` must omit the param entirely in that case, not pass a
   * placeholder.
   */
  idProcessoDoc: number | null
  label: string
  date: string | null
  type: string | null
}

/**
 * A document-shaped link/trigger whose structure this parser doesn't
 * recognise — a portal shape change distinct from either known document
 * variant. Carries enough of the raw trigger (`raw`) to diagnose what
 * changed. Never downloaded: the caller records it as a per-document
 * failure and moves on, exactly like a download that failed over the wire —
 * one unparseable row must not cost every other document on the page (see
 * `crawl/deep.ts`).
 */
export interface MalformedDocumentRef {
  kind: 'malformed'
  id: number
  raw: string
  label: string
}

export type DocumentRef = BinaryDocumentRef | HtmlDocumentRef | MalformedDocumentRef

// A real case page always prints the CNJ case number; the expired/invalid-ca
// page never does (see `fetchDetail` below). Declared here, not just near
// `fetchDetail`, because `parseDetailPage` also needs it: the case number is
// half of the synthetic id it derives for a document with no `idProcessoDoc`
// of its own (see `syntheticDocId`).
const CASE_NUMBER_RE = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/

/**
 * Deterministically derives a document id from arbitrary text, for the two
 * shapes that carry no real `idProcessoDoc` to key off: a procedural-
 * movement HTML trigger (case number + label — both stable across re-fetches,
 * unlike that trigger's own ephemeral `ca`) and a malformed link (its raw
 * trigger text, so at least identical failures collapse to one row rather
 * than growing `failures` without bound).
 *
 * Offset well above any real `idProcessoDocumento` observed in the wild
 * (a few million) so a synthetic and a real id can never collide in the
 * `documents` table's primary key. Folding 6 bytes of the digest keeps the
 * result a safe JS/SQLite integer (< 2^53) while remaining effectively
 * collision-free for this dataset's size.
 */
function syntheticDocId(input: string): number {
  const digest = createHash('sha256').update(input).digest()
  return 1_000_000_000_000 + digest.readUIntBE(0, 6)
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

// Captures the session-bound `ca` and, optionally, the real `idProcessoDoc`.
// Found live (case 0013478-88.2026.4.05.0000): a case's own procedural-
// movement timeline links to one of its documents through this exact same
// endpoint and a same-shaped 112-hex `ca`, but never carries `idProcessoDoc`
// at all — that param belongs to the document, not the movement, and
// appending any value for it (even the right document's real id) breaks the
// fetch outright (see `documentHtmlUrl`). Matching it as optional, rather
// than requiring it, is what tells the two apart.
const HTML_TRIGGER_RE = /documentoSemLoginHTML\.seam\?ca=([0-9a-f]{112})(?:&idProcessoDoc=(\d+))?/

/**
 * Parses a case detail page into its document list. Cheerio decodes HTML
 * entities for us (`&ccedil;` -> `ç`), so labels come out correctly
 * accented even though the page itself is ISO-8859-1.
 *
 * A link that looks document-shaped but doesn't match either known variant
 * becomes a `MalformedDocumentRef` rather than being silently dropped or
 * aborting the whole page — see that type's doc comment for why.
 */
export function parseDetailPage(html: string): DocumentRef[] {
  const $ = cheerio.load(html)
  const documents: DocumentRef[] = []
  const caseNumber = CASE_NUMBER_RE.exec(html)?.[0] ?? 'unknown-case'

  $('a[href*="idBin="]').each((_, el) => {
    const href = $(el).attr('href')
    if (!href) return
    const url = new URL(href, HOST)
    const idBin = url.searchParams.get('idBin')
    const numeroDocumento = url.searchParams.get('numeroDocumento')
    const id = url.searchParams.get('idProcessoDocumento')
    const { label, date, type } = parseLabel($(el).text())
    if (!idBin || !numeroDocumento || !id) {
      documents.push({ kind: 'malformed', id: syntheticDocId(href), raw: href, label })
      return
    }
    documents.push({ kind: 'binary', id: Number(id), idBin: Number(idBin), numeroDocumento, label, date, type })
  })

  $('[onclick*="documentoSemLoginHTML.seam"]').each((_, el) => {
    const onclick = $(el).attr('onclick') ?? ''
    const { label, date, type } = parseLabel($(el).text())
    const m = HTML_TRIGGER_RE.exec(onclick)
    if (!m) {
      documents.push({ kind: 'malformed', id: syntheticDocId(onclick), raw: onclick, label })
      return
    }
    const ca = m[1]!
    const idProcessoDoc = m[2] ? Number(m[2]) : null
    const id = idProcessoDoc ?? syntheticDocId(`${caseNumber}|${label}`)
    documents.push({ kind: 'html', id, ca, idProcessoDoc, label, date, type })
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

// The expired/invalid-ca page (see `tests/fixtures/detail-invalid-ca.html`,
// captured live from a 48-hex string of `a`s) never prints a case number,
// and instead prints this line. Checking the positive marker first means a
// portal-wide shape change — neither marker present — surfaces as a loud,
// distinct failure rather than being silently read as "invalid ca" (which
// would otherwise churn the search bridge forever) or "valid" with zero
// documents.
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
