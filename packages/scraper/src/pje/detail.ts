import { createHash } from 'node:crypto'
import * as cheerio from 'cheerio'
import type { PartyInput } from '@pje/core'
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

export interface ProcessFields {
  /** "Jurisdição" — TRF5 for every case observed so far. */
  jurisdiction: string | null
  /** "Endereço" — the deciding court's postal address. */
  courtAddress: string | null
  /** "Processo referência" — a related case number, when the page cites one. */
  referenceNumber: string | null
}

/** Collapses runs of whitespace (including the `&nbsp;` a row's own indentation decodes to) to a single space. */
function collapseWhitespace(text: string): string {
  return text.replace(/[\s ]+/g, ' ').trim()
}

function stripTags(html: string): string {
  return collapseWhitespace(html.replace(/<[^>]+>/g, ' '))
}

// A void element (`<br>`) has no closing tag, but its own name starts with
// the same letter as `<b>` — `<b[^>]*>` alone matches `<br>` too, since
// `[^>]*` is happy to consume the `r`. Requiring `>` or whitespace right
// after `b` is what tells the two tags apart.
const BOLD_SPLIT_RE = /<b(?:\s[^>]*)?>([\s\S]*?)<\/b>/g

/**
 * Walks every `.propertyView` block in the "Dados do Processo" panel (see
 * the module-level note: never anchored on the panel's own generated
 * `j_id*` container id, only on this class, which is stable) and returns
 * every label/value pair it finds, keyed by the label's own text.
 *
 * The panel prints two different shapes of label, both handled here:
 *  - most fields: `<div class="name"><label>Jurisdição</label></div>` next
 *    to a plain `<div class="value">`.
 *  - a few fields share one cell with an empty outer `<label>` and instead
 *    pack one or more `<b>Label</b>` sub-headings directly into the value
 *    (this is how "Endereço" and "Órgão Julgador Colegiado" arrive — see
 *    `detail-with-docs.html`, verified live). Split on `<b>` for those.
 */
function collectProcessFieldMap(html: string): Map<string, string> {
  const $ = cheerio.load(html)
  const fields = new Map<string, string>()

  $('.propertyView').each((_, el) => {
    const valueEl = $(el).find('> .value').first()
    if (valueEl.find('b').length > 0) {
      const valueHtml = valueEl.html() ?? ''
      const parts = valueHtml.split(BOLD_SPLIT_RE)
      // String.split with a capturing global regex interleaves the pieces
      // as [pre, label1, between1, label2, between2, ..., trailing] — odd
      // indices are labels, and the value for label[i] is whatever follows
      // it, at index i+1.
      for (let i = 1; i < parts.length; i += 2) {
        const label = stripTags(parts[i] ?? '')
        const value = stripTags(parts[i + 1] ?? '')
        if (label) fields.set(label, value)
      }
      return
    }
    const label = collapseWhitespace($(el).find('> .name label').first().text())
    if (!label) return
    fields.set(label, collapseWhitespace(valueEl.text()))
  })

  return fields
}

/** Parses the three "Dados do Processo" fields the rest of the pipeline didn't already cover. */
export function parseProcessFields(html: string): ProcessFields {
  const fields = collectProcessFieldMap(html)
  return {
    jurisdiction: fields.get('Jurisdição') ?? null,
    courtAddress: fields.get('Endereço') ?? null,
    referenceNumber: fields.get('Processo referência') ?? null,
  }
}

// "2 resultados encontrados" / "5 resultados encontrados" — the count the
// page itself states for a paginated list. Anchoring only on this text, not
// on the Richfaces.Datascroller markup next to it, keeps the anti-truncation
// check independent of a redeploy renaming the scroller's own generated ids.
const RESULT_COUNT_RE = /^(\d+)\s+resultados/

const ROLE_RE = /\(([^()]+)\)\s*$/
const CNPJ_RE = /\s*-?\s*CNPJ:\s*([\d./-]+)/
const CPF_RE = /\s*-?\s*CPF:\s*([\d.-]+)/
const OAB_RE = /\s*-?\s*OAB\s+([A-Za-z0-9-]+)/

/**
 * Splits one participant cell's free text into its component fields.
 * Real examples (see the team's Playwright recon and both fixtures):
 *
 *   "CONSELHO REGIONAL DE ODONTOLOGIA DO CEARA - CNPJ: 07.299.589/0001-10 (APELANTE)"
 *   "ALLEX KONNE DE NOGUEIRA E SOUZA - OAB CE17669-A - CPF: 640.535.983-20 (ADVOGADO)"
 *   "CONSELHO REGIONAL DE EDUCACAO FISICA DA 12 REGIAO/PERNAMBUCO - CREF12/PE - CNPJ: 03.956.986/0001-66 (APELADO)"
 *
 * The role is always the trailing `(...)`. CPF and CNPJ are mutually
 * exclusive (a person or an entity, never both) and, together with OAB, are
 * matched and stripped out independently rather than by position — the last
 * example shows why: "CREF12/PE" is part of the entity's own name, not a
 * field, and a naive split on every `-` would wrongly carve it off. What's
 * left after removing the role and every recognised field is the name.
 */
function parsePartyText(raw: string, polo: PartyInput['polo'], situation: string): PartyInput {
  let text = collapseWhitespace(raw)

  const roleMatch = ROLE_RE.exec(text)
  const role = roleMatch ? roleMatch[1]!.trim() : null
  if (roleMatch) text = text.slice(0, roleMatch.index).trim()

  let documentType: PartyInput['documentType'] = null
  let documentNumber: string | null = null

  const cnpjMatch = CNPJ_RE.exec(text)
  if (cnpjMatch) {
    documentType = 'cnpj'
    documentNumber = cnpjMatch[1]!
    text = text.replace(cnpjMatch[0], '')
  } else {
    const cpfMatch = CPF_RE.exec(text)
    if (cpfMatch) {
      documentType = 'cpf'
      documentNumber = cpfMatch[1]!
      text = text.replace(cpfMatch[0], '')
    }
  }

  let oab: string | null = null
  const oabMatch = OAB_RE.exec(text)
  if (oabMatch) {
    oab = oabMatch[1]!
    text = text.replace(oabMatch[0], '')
  }

  const name = collapseWhitespace(text).replace(/\s*-\s*$/, '').trim()

  return { polo, name, documentType, documentNumber, oab, role, situation: situation || null }
}

/**
 * Parses one polo's participant table (`table[id$="<idSuffix>"]`, never the
 * container's own generated id — see the module-level note) into its rows
 * plus the total the page states for it, so the caller can tell a complete
 * list from one the Richfaces.Datascroller is hiding a further page of
 * (never driven here — see `parseParties`'s own doc comment).
 */
function parsePartyTable($: cheerio.CheerioAPI, polo: PartyInput['polo'], idSuffix: string): { parties: PartyInput[]; total: number | null } {
  const table = $(`table[id$="${idSuffix}"]`).first()
  if (table.length === 0) return { parties: [], total: null }

  const parties: PartyInput[] = []
  table.find('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td')
    // The participant cell also carries a trailing `<ul>` of auxiliary
    // annotations — an empty "Defensoria" marker in both fixtures, but
    // found live (case 0800245-51.2020.4.05.8002) carrying real text too: a
    // "Procuradoria" line naming the representing office ("PROCURADORIA
    // MINISTÉRIO PÚBLICO FEDERAL"). Left in, that text lands after the
    // role's closing paren, breaking `parsePartyText`'s "role is the
    // trailing `(...)`" assumption. None of this is part of the party's own
    // name, so the whole `<ul>` (plus the always-inert `<style>` block) is
    // stripped from a clone first, mirroring `extractActText` in
    // `download.ts`.
    const participantCell = $(cells[0]).clone()
    participantCell.find('script, style, ul').remove()
    const situation = collapseWhitespace($(cells[1]).text())
    parties.push(parsePartyText(participantCell.text(), polo, situation))
  })

  const totalText = table.next('span.pull-right.text-muted').text().trim()
  const totalMatch = RESULT_COUNT_RE.exec(totalText)
  return { parties, total: totalMatch ? Number(totalMatch[1]) : null }
}

/**
 * Parses both "Polo ativo" and "Polo Passivo" participant lists.
 *
 * **Both lists are paginated** (a `Richfaces.Datascroller`, never driven by
 * this scraper — that's a separate problem) and each is followed by the
 * page's own "N resultados encontrados" count. `ativoTotal`/`passivoTotal`
 * carry that stated count back to the caller (`null` only if the polo's
 * table itself is missing) so it can compare against how many rows were
 * actually parsed and treat a mismatch as truncation — silently storing a
 * partial list for, say, a fifty-litigant class action would be worse than
 * not noticing the pagination at all. See `crawl/deep.ts` for what happens
 * with that comparison.
 */
export function parseParties(html: string): { parties: PartyInput[]; ativoTotal: number | null; passivoTotal: number | null } {
  const $ = cheerio.load(html)
  const ativo = parsePartyTable($, 'ativo', 'processoPartesPoloAtivoResumidoList')
  const passivo = parsePartyTable($, 'passivo', 'processoPartesPoloPassivoResumidoList')
  return { parties: [...ativo.parties, ...passivo.parties], ativoTotal: ativo.total, passivoTotal: passivo.total }
}

/**
 * Reads only the *stated* total for "Movimentações do Processo"
 * (`table[id$="processoEvento"]`'s own "N resultados encontrados" —
 * an exact id-suffix match, so it can't accidentally pick up the panel's
 * own `...processoEventoPanel` or a per-cell form whose id merely contains
 * that substring) — never the rows themselves.
 *
 * Found live (case 0800245-51.2020.4.05.8002): this table renders only its
 * first page — 15 rows against a stated 39. It CAN be paged, but not by a
 * Datascroller like Polo Ativo/Passivo use. Its control is a RichFaces
 * `rich:inputNumberSlider` in a `<form>` of its own, placed right after the
 * "N resultados encontrados" span. That form's inline script declares
 * everything needed to drive it:
 *
 *     new Richfaces.Slider("<sliderId>", {'minValue':'1','maxValue':'3', ...})
 *
 * `maxValue` is the page count, and the slider's id doubles as the name of
 * the page parameter. Recorded here because it took real digging to find
 * and it is the mechanism anyone paging these tables will need.
 *
 * We take the rows from the case's summary PDF anyway (see `pdf/parse.ts`'s
 * `parseMovements`) — not because the HTML is unreachable, but because the
 * PDF carries the whole log in one shot, at no extra request since every
 * case downloads it regardless, and therefore works in `crawl` across the
 * entire corpus. Paging the HTML would cost extra POSTs per case and only
 * ever work in `deep`, the sole command that loads this page.
 *
 * This total exists purely so `crawl/deep.ts` can cross-check the PDF's own
 * count against it and notice, loudly, the day that "the PDF is complete"
 * assumption stops holding for some case.
 */
export function parseMovementsTotal(html: string): number | null {
  const $ = cheerio.load(html)
  const table = $('table[id$="processoEvento"]').first()
  if (table.length === 0) return null
  const totalText = table.next('span.pull-right.text-muted').text().trim()
  const totalMatch = RESULT_COUNT_RE.exec(totalText)
  return totalMatch ? Number(totalMatch[1]) : null
}

export type DetailResult =
  | {
      kind: 'valid'
      documents: DocumentRef[]
      processFields: ProcessFields
      parties: PartyInput[]
      partiesAtivoTotal: number | null
      partiesPassivoTotal: number | null
      /** The page's own stated movements count — see `parseMovementsTotal`; the rows themselves come from the PDF. */
      movementsTotal: number | null
    }
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
    const { parties, ativoTotal, passivoTotal } = parseParties(html)
    return {
      kind: 'valid',
      documents: parseDetailPage(html),
      processFields: parseProcessFields(html),
      parties,
      partiesAtivoTotal: ativoTotal,
      partiesPassivoTotal: passivoTotal,
      movementsTotal: parseMovementsTotal(html),
    }
  }
  if (html.includes(ACCESS_DENIED_MARKER)) {
    return { kind: 'invalid' }
  }
  throw new UnrecognisedDetailPageError(res.status, res.url)
}
