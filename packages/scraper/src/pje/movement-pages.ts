import * as cheerio from 'cheerio'
import { HttpClient, decodeLatin1 } from '../http/client.ts'
import { detailUrl } from './urls.ts'

/**
 * Walks the case file's "Movimentações do Processo" table page by page.
 *
 * The movements used to be parsed out of the summary PDF, which was a
 * deliberate choice and the wrong one: it cost no extra requests, but it
 * counted movements by matching timestamps in extracted text, and on a long
 * case that count drifted from what the page declares — 4,200 against 4,182,
 * 597 against 596. Counting rows in the table it came from cannot drift.
 *
 * The control is a `rich:inputNumberSlider`, and its envelope is not the one
 * the participant Datascroller uses. Both were established by watching the
 * portal answer:
 *
 *  - `AJAXREQUEST` carries the **containerId** — the region that wraps the
 *    table — where the Datascroller wants the literal `_viewRoot`. Send
 *    `_viewRoot` here and the panel re-renders with page one, every time: the
 *    action runs, so nothing looks broken, and the page number is ignored.
 *  - The slider's own submit control (`…j_id563`) has to be posted as a
 *    parameter. It is named only inside the `onchange` script, never as a
 *    field, so it cannot be picked up by reading the form's inputs.
 *
 * Neither is guessable from the markup, and each alone is not enough. Both
 * come off the page at runtime; nothing here is hardcoded.
 */

export interface MovementPager {
  /** The field carrying the page number. */
  pageParam: string
  /** The slider's own form. */
  form: string
  /** The submit control named in its `onchange`. */
  control: string
  /** The region the response re-renders. */
  container: string
  viewState: string
}

/** Rows per page, fixed by the portal. */
export const MOVEMENTS_PAGE_SIZE = 15

const PAGE_FIELD_RE = /name="([^"]+)"\s+size="3"/
const VIEW_STATE_RE = /name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/
const ONCHANGE_RE =
  /Submit\('[^']*',event,\{'similarityGroupingId':'([^']*)'[^}]*'containerId':'([^']*)'/

/**
 * Reads everything the slider needs off the case file, or null when the page
 * has no pager — a case whose movements fit on one page carries no slider at
 * all, which is not a failure.
 */
export function parseMovementPager(html: string): MovementPager | null {
  const pageParam = PAGE_FIELD_RE.exec(html)?.[1]
  const viewState = VIEW_STATE_RE.exec(html)?.[1]
  if (pageParam === undefined || viewState === undefined) return null

  // The onchange lives inside a JavaScript string literal, so its quotes
  // arrive escaped; flattening the backslashes is what makes it readable with
  // the same expression the rest of this file uses.
  const flat = html
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .replaceAll('\\', '')
  const at = flat.indexOf('onchange')
  if (at === -1) return null
  const m = ONCHANGE_RE.exec(flat.slice(at, at + 900))
  if (m === null) return null

  return {
    pageParam,
    // The slider's form is the page field's own prefix — there is no need to
    // find the <form> tag, and the first one on the page belongs to something
    // else entirely.
    form: pageParam.split(':').slice(0, -1).join(':'),
    control: m[1]!,
    container: m[2]!,
    viewState,
  }
}

/** How many pages `total` movements span. */
export function movementPageCount(total: number | null): number {
  if (total === null || total <= MOVEMENTS_PAGE_SIZE) return 1
  return Math.ceil(total / MOVEMENTS_PAGE_SIZE)
}

/**
 * Asks the portal for one page of the movements table, as raw markup.
 *
 * Decoded as UTF-8, not Latin-1 — and this is not a detail. The case file
 * itself is ISO-8859-1, which is why the rest of this scraper decodes that
 * way, but the ajax fragment the same server returns for this control is
 * UTF-8 and declares no encoding at all. Read it as Latin-1 and every
 * accented movement is stored mojibake: "Distribuído" becomes
 * "DistribuÃ­do", and that is what ends up in the search index.
 */
export async function fetchMovementPage(
  client: HttpClient,
  ca: string,
  pager: MovementPager,
  page: number,
): Promise<string> {
  const url = detailUrl(ca)
  const res = await client.request(url, {
    method: 'POST',
    body: new URLSearchParams({
      AJAXREQUEST: pager.container,
      [pager.pageParam]: String(page),
      [pager.form]: pager.form,
      autoScroll: '',
      'javax.faces.ViewState': pager.viewState,
      [pager.control]: pager.control,
      'AJAX:EVENTS_COUNT': '1',
    }).toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=ISO-8859-1',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: url,
    },
  })
  return res.body.toString('utf8')
}

/**
 * Where each row of the table begins. The portal indexes them, so this is
 * what bounds one row from the next.
 */
const ROW_START_RE = /id="[^"]*:processoEvento:(\d+):/g

/** `dd/mm/yyyy hh:mm:ss - <description>` — the movement itself. */
const MOVEMENT_RE = /(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2})\s*-\s*([^<|]+)/

export interface MovementRow {
  timestamp: string
  description: string
}

/**
 * Reads the movement rows out of a page of the table.
 *
 * Row-shaped from the start, unlike the PDF version this replaces: that one
 * scanned extracted text for anything that looked like a timestamp, which is
 * why its count drifted above what the page declares. Here a row is a row.
 *
 * Works on the ajax fragment as well as the whole page, because the fragment
 * is the same markup — the portal re-renders the panel and sends it back.
 */
export function parseMovementRows(html: string): MovementRow[] {
  // Sliced row by row rather than scanned whole: the portal writes each
  // movement's text twice — once as the link, once in a title attribute — so
  // a page-wide scan reports thirty movements for a table of fifteen. Taking
  // the first match inside each row's own bounds counts each one once, and
  // makes the count a count of rows.
  const starts: Array<[number, number]> = []
  for (const m of html.matchAll(ROW_START_RE)) {
    const index = Number(m[1])
    if (starts.length > 0 && starts[starts.length - 1]![0] === index) continue
    starts.push([index, m.index])
  }

  const rows: MovementRow[] = []
  for (let i = 0; i < starts.length; i++) {
    const chunk = html.slice(starts[i]![1], starts[i + 1]?.[1] ?? html.length)
    const m = MOVEMENT_RE.exec(chunk)
    if (m === null) continue
    // Through cheerio for the entities: the page is ISO-8859-1 and writes
    // its accents as `&atilde;`, so a raw slice would store "decis&atilde;o"
    // — and that is what would end up in the search index.
    const description = cheerio.load(`<i>${m[2]!}</i>`)('i').text().trim()
    if (description === '') continue
    rows.push({ timestamp: m[1]!, description })
  }
  return rows
}

/**
 * Every movement on a case file, walking the table to its end.
 *
 * Returns null when the page carries no pager it can read — the caller then
 * keeps whatever it already had rather than replacing a full log with an
 * empty one.
 *
 * Bounded by the count the page declares, not probed. The portal answers a
 * page past the end by re-serving the last one, so a loop that stopped on
 * "nothing new" would be working by accident.
 */
export async function fetchAllMovements(
  client: HttpClient,
  ca: string,
  firstPageHtml: string,
  total: number | null,
  onPage?: (page: number, of: number) => void,
): Promise<MovementRow[] | null> {
  const first = parseMovementRows(firstPageHtml)
  const pages = movementPageCount(total)
  if (pages <= 1) return first

  const pager = parseMovementPager(firstPageHtml)
  if (pager === null) return first.length > 0 ? first : null

  const all = [...first]
  for (let page = 2; page <= pages; page++) {
    onPage?.(page, pages)
    all.push(...parseMovementRows(await fetchMovementPage(client, ca, pager, page)))
  }
  return all
}
