import * as cheerio from 'cheerio'
import { HttpClient } from '../http/client.ts'
import type { PjeSession } from './session.ts'

export interface SearchFilters {
  number?: string
  from?: string
  to?: string
  class?: string
  party?: string
  lawyer?: string
  document?: string
  documentType?: 'cpf' | 'cnpj'
  oab?: string
  oabState?: string
  reference?: string
}

export class SearchValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SearchValidationError'
  }
}

export class ActionNotExecutedError extends Error {
  constructor(reason: string = 'only the message panel re-rendered') {
    super(
      `The search action did not execute (${reason}). ` +
      'This usually means the submit parameter is stale — re-read it from the page.',
    )
    this.name = 'ActionNotExecutedError'
  }
}

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/

/** Fails fast on inputs the server would silently ignore or reject. */
export function validateFilters(f: SearchFilters): void {
  const twoTokens = (v: string) => v.trim().split(/\s+/).filter(Boolean).length >= 2

  if (f.party !== undefined && !twoTokens(f.party)) {
    throw new SearchValidationError(
      '--party requires at least two names; the server rejects a single token.',
    )
  }
  if (f.lawyer !== undefined && !twoTokens(f.lawyer)) {
    throw new SearchValidationError(
      '--lawyer requires at least two names; the server rejects a single token.',
    )
  }
  if (f.oabState && !f.oab) {
    throw new SearchValidationError(
      '--oab-state has no effect without --oab; the server ignores it silently.',
    )
  }
  for (const [flag, value] of [['--from', f.from], ['--to', f.to]] as const) {
    if (value !== undefined && !DATE_RE.test(value)) {
      throw new SearchValidationError(`${flag} must be dd/mm/yyyy, got "${value}".`)
    }
  }
}

const monthYear = (d: Date): string =>
  `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`

/**
 * Builds the full form payload.
 *
 * Both `*InputCurrentDate` fields must always carry a valid MM/YYYY. If they
 * are empty the RichFaces calendar fails to decode and JSF drops the date
 * filter entirely, returning unrelated results with no error.
 */
export function buildSearchPayload(
  session: PjeSession,
  f: SearchFilters,
  today: Date = new Date(),
): Record<string, string> {
  const cur = monthYear(today)
  const payload: Record<string, string> = {
    'AJAXREQUEST': '_viewRoot',
    'fPP:numProcesso-inputNumeroProcessoDecoration:numProcesso-inputNumeroProcesso': f.number ?? '',
    'fPP:dnp:nomeParte': f.party ?? '',
    'fPP:dpDec:documentoParte': f.document ?? '',
    'tipoMascaraDocumento': f.documentType ?? 'cpf',
    'fPP:j_id180:nomeAdv': f.lawyer ?? '',
    'fPP:Decoration:numeroOAB': f.oab ?? '',
    // `||`, not `??`: an explicit empty string means "no state selected"
    // exactly like an absent field, and must carry the same sentinel — the
    // server ignores anything else silently.
    'fPP:Decoration:estadoComboOAB':
      f.oabState || 'org.jboss.seam.ui.NoSelectionConverter.noSelectionValue',
    'fPP:j_id189:classeJudicial': f.class ?? '',
    'fPP:j_id162:processoReferenciaInput': f.reference ?? '',
    'mascaraProcessoReferenciaRadio': 'on',
    'fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputDate': f.from ?? '',
    'fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputCurrentDate': cur,
    'fPP:dataAutuacaoDecoration:dataAutuacaoFimInputDate': f.to ?? '',
    'fPP:dataAutuacaoDecoration:dataAutuacaoFimInputCurrentDate': cur,
    'fPP': 'fPP',
    'autoScroll': '',
    'javax.faces.ViewState': 'j_id1',
    'AJAX:EVENTS_COUNT': '1',
  }
  payload[session.submitParam] = session.submitParam
  return payload
}

const ROW_RE = /id="fPP:processosTable:(\d+):/g
const NUMBER_RE = /(\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4})/
/**
 * The `ca` token on a result row.
 *
 * Two lengths, both real. Recent cases carry 48 hex; cases from the 1990s and
 * 2000s carry 32, and both resolve a detail page — verified live against
 * cases from 1999, 2005 and 2010. Pinning this at 48, as it was, meant a
 * search that happened to reach an old case failed *entirely*: the three
 * unreadable rows tripped the shape-change guard below and took the
 * twenty-seven good ones with them, so `--party` was effectively broken for
 * any name with history.
 *
 * Left as an alternation rather than a range: these are the two shapes the
 * portal is known to emit, and a token of some third length is exactly the
 * surprise the guard below exists to report.
 */
const CA_RE = /listView\.seam\?ca=((?:[0-9a-f]{48}|[0-9a-f]{32}))(?![0-9a-f])/

export interface SearchRow {
  idProcessoTrf: number
  number: string
  ca: string
  /**
   * What the result row already carries, beyond the identifiers.
   *
   * The portal's own list shows the class, the subject, the parties and the
   * last movement in every row. Reading only the number and the `ca` threw all
   * of that away — and it is free: it arrives in a response already paid for,
   * with no second request.
   *
   * Every field is optional because the row belongs to the portal, not to us:
   * a case with no movements yet has no last movement, and a column that moves
   * should cost one field, not the row.
   */
  className?: string
  subject?: string
  parties?: string
  lastMovement?: { description: string; timestamp?: string }
}

/** `Conclusos para julgamento (28/08/2026 15:04:16)` */
const MOVEMENT_RE = /^(.*?)\s*\((\d{2}\/\d{2}\/\d{4}[^)]*)\)\s*$/

const tidy = (raw: string): string => raw.replace(/\s+/g, ' ').trim()

/**
 * The cells of one result row: the details link, the case, the last movement.
 *
 * Read with cheerio for the same reason as the detail page — it decodes the
 * entities, so `&ccedil;` arrives as `ç` — and defensively throughout: a field
 * that does not match is left undefined rather than throwing, because the
 * identifiers are what the row is *for*, and a reordered column should not
 * stop a search from working.
 */
function parseRowCells(chunk: string): Omit<SearchRow, 'idProcessoTrf' | 'number' | 'ca'> {
  const out: Omit<SearchRow, 'idProcessoTrf' | 'number' | 'ca'> = {}
  // Wrapped before parsing, for two reasons that bite together: an HTML parser
  // discards `<td>` outside a table, and the chunk is sliced from a marker that
  // sits inside the first cell, so its opening tag is missing. The prefix
  // supplies both the table and that tag.
  const $ = cheerio.load(`<table><tr><td ${chunk}</td></tr></table>`)

  // Found by shape, not by column index. A row's chunk is sliced between two
  // markers that sit *inside* the first cell, so its opening tag is cut off and
  // the cells do not start where counting would say they do.
  const headline = $('b.btn-block').first()
  if (headline.length === 0) return out

  const heading = tidy(headline.text())
  const dash = heading.split(' - ')
  if (dash.length > 1) out.subject = dash.slice(1).join(' - ')

  const caseCell = headline.closest('td')
  const link = headline.closest('a')
  if (caseCell.length > 0 && link.length > 0) {
    const parts = caseCell.contents()
    const at = parts.index(link)
    const before = tidy(parts.slice(0, at).text())
    if (before !== '') out.className = before
    const after = tidy(parts.slice(at + 1).text())
    if (after !== '') out.parties = after
  }

  const movement = tidy(caseCell.next('td').text())
  if (movement !== '') {
    const m = MOVEMENT_RE.exec(movement)
    out.lastMovement = m
      ? { description: m[1]!.trim(), timestamp: m[2]!.trim() }
      : { description: movement }
  }
  return out
}

export interface SearchOutcome {
  rows: SearchRow[]
  /** True when the server said it truncated the result set at 30. */
  capped: boolean
}

export function parseSearchResponse(xml: string): SearchOutcome {
  const updateIds = [...xml.matchAll(/Ajax-Update-Ids"\s+content="([^"]*)"/g)].map((m) => m[1]!)
  // A normal AJAX response always carries this header. Its total absence
  // (error page, expired session, anything non-standard) is not "zero
  // results" either — reaching that conclusion by falling through the
  // `some()` check below would be the same silent-empty-result lie through a
  // different door.
  if (updateIds.length === 0) {
    throw new ActionNotExecutedError(
      'the response carried no Ajax-Update-Ids header at all — likely an error page or an expired session',
    )
  }
  if (!updateIds.some((id) => id.includes('processosGridPanel'))) {
    throw new ActionNotExecutedError()
  }

  // Each row is announced by one or more `id="fPP:processosTable:<idProcessoTrf>:..."`
  // markers. Collect the first offset each id appears at, once, then slice the
  // document between consecutive first-offsets instead of re-scanning per id.
  const firstOffset = new Map<number, number>()
  for (const m of xml.matchAll(ROW_RE)) {
    const id = Number(m[1])
    if (!firstOffset.has(id)) firstOffset.set(id, m.index)
  }
  const boundaries = [...firstOffset.entries()].sort((a, b) => a[1] - b[1])

  const rows: SearchRow[] = []
  let dropped = 0
  for (let i = 0; i < boundaries.length; i++) {
    const [id, start] = boundaries[i]!
    const end = boundaries[i + 1]?.[1] ?? xml.length
    const chunk = xml.slice(start, end)
    const number = NUMBER_RE.exec(chunk)?.[1]
    const ca = CA_RE.exec(chunk)?.[1]
    if (number && ca) rows.push({ idProcessoTrf: id, number, ca, ...parseRowCells(chunk) })
    else dropped++
  }

  // A row marker present without a matching number/ca is not "one fewer
  // result" — it means the response shape changed underneath this parser.
  // Silently skipping it would hand the caller a result set that looks
  // complete but is missing rows with no signal anything went wrong, in
  // code that goes to real lengths elsewhere to prevent exactly that.
  if (dropped > 0) {
    throw new ActionNotExecutedError(
      `${dropped} of ${boundaries.length} result row(s) were missing a case number or ca ` +
      'token — the response shape likely changed',
    )
  }

  return { rows, capped: xml.includes('muitos processos') }
}

const UNRESERVED_RE = /[A-Za-z0-9\-._~]/

/**
 * Percent-encodes one `application/x-www-form-urlencoded` component under an
 * ISO-8859-1 charset.
 *
 * `URLSearchParams.toString()` always percent-encodes as UTF-8, regardless of
 * the charset declared in the `Content-Type` header. We declare
 * `charset=ISO-8859-1`, so a `URLSearchParams` body and that header disagree:
 * the server decodes our UTF-8 bytes as Latin-1 and silently returns wrong
 * (truncated) results for any accented input — no error at all.
 */
export function encodeFormComponent(value: string): string {
  let out = ''
  for (const ch of value) {
    const cp = ch.codePointAt(0)!
    if (UNRESERVED_RE.test(ch)) {
      out += ch
    } else if (ch === ' ') {
      out += '+'
    } else if (cp <= 0xff) {
      out += '%' + cp.toString(16).toUpperCase().padStart(2, '0')
    } else {
      // A character the Latin-1 charset cannot represent: submit it the way
      // a browser does, as a numeric character reference. Every character in
      // `&#<cp>;` is itself below 0xFF, so this recursion always terminates.
      out += encodeFormComponent(`&#${cp};`)
    }
  }
  return out
}

/** Joins a payload into an `application/x-www-form-urlencoded; charset=ISO-8859-1` body. */
export function encodeSearchBody(payload: Record<string, string>): string {
  return Object.entries(payload)
    .map(([k, v]) => `${encodeFormComponent(k)}=${encodeFormComponent(v)}`)
    .join('&')
}

export async function search(
  client: HttpClient,
  session: PjeSession,
  f: SearchFilters,
): Promise<SearchOutcome> {
  validateFilters(f)
  const payload = buildSearchPayload(session, f)
  const body = encodeSearchBody(payload)

  const res = await client.request(session.actionUrl, {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=ISO-8859-1',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': session.actionUrl,
    },
  })
  // UTF-8, not Latin-1. This portal serves a page in ISO-8859-1 and its own
  // AJAX fragments in UTF-8, declaring neither — the same split already handled
  // in `movement-pages.ts`. Decoding this response as Latin-1 was harmless
  // while only the number and the `ca` were read, since both are ASCII; it
  // turns every accented class, subject and party name into mojibake the
  // moment those are read too.
  return parseSearchResponse(res.body.toString('utf8'))
}
