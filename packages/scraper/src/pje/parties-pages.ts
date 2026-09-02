import { HttpClient, decodeLatin1 } from '../http/client.ts'
import { detailUrl } from './urls.ts'
import { parseParties } from './detail.ts'
import type { PartyInput } from '@pje/core'

/**
 * Follows the participant lists past their first page.
 *
 * A case file shows ten participants per polo and hides the rest behind a
 * `Richfaces.Datascroller`. Until now this scraper parsed page one, noticed
 * the count did not match what the page declared, and recorded the gap as a
 * failure — honest, but a fifty-litigant case was stored with twenty parties.
 *
 * The scroller is a JSF ajax POST back to the same detail URL. Everything it
 * needs is written into the page's own script, so nothing here is hardcoded:
 * the scroller's client id, the id of the region that owns it, the form it
 * lives in (the scroller id's own first segment), and the view state.
 *
 * The one value that is not on the page is `AJAXREQUEST`, and it is the whole
 * trick. The obvious reading of the script is that it carries the region id —
 * that is what `A4J.AJAX.Submit` is handed — and a POST built that way comes
 * back 200 with an empty `Ajax-Update-Ids` and no rows: the action silently
 * did not run. `_viewRoot` is what makes it execute. Established by trying
 * both against the live portal, not by reading the RichFaces source.
 */

export interface PartyScroller {
  /** The scroller's own client id — the parameter that carries the page number. */
  scrollerId: string
  /** Which list it pages, for reporting. */
  list: string
}

/** Rows per page. The portal's own, and not configurable from our side. */
const PAGE_SIZE = 10

/**
 * `Richfaces.Datascroller('<clientId>', ...` — one call per paged list, and
 * the id's segments name both the form and the list it belongs to.
 */
const SCROLLER_RE = /Richfaces\.Datascroller\('([^']+)'/g

const VIEW_STATE_RE = /name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/

export function parsePartyScrollers(html: string): PartyScroller[] {
  const found: PartyScroller[] = []
  for (const m of html.matchAll(SCROLLER_RE)) {
    const scrollerId = m[1]!
    const segments = scrollerId.split(':')
    // `<form>:<list>:<table>:<scroller>` — anything shorter is not a list
    // scroller and has no page parameter to drive.
    if (segments.length < 3) continue
    found.push({ scrollerId, list: segments[1]! })
  }
  return found
}

export function parseViewState(html: string): string | null {
  return VIEW_STATE_RE.exec(html)?.[1] ?? null
}

/**
 * How many pages a list of `total` participants spans, given the page already
 * in hand. Derived from the page's own declared total rather than probed:
 * asking for a page past the end does not error, it re-serves the last one,
 * so a loop that stopped on "no new rows" would work by accident and a loop
 * with no bound would not stop at all.
 */
export function pageCount(total: number | null): number {
  if (total === null || total <= PAGE_SIZE) return 1
  return Math.ceil(total / PAGE_SIZE)
}

export interface PagedParties {
  parties: PartyInput[]
  /** Pages actually fetched beyond the first, for the run log. */
  extraRequests: number
}

/**
 * Reads every page of every participant list on a case file.
 *
 * Takes the first page's HTML — already fetched by the caller — and asks only
 * for what is missing, so a case whose lists fit on one page costs nothing
 * extra.
 *
 * Duplicates are kept. The same lawyer really does appear twice in these
 * lists, once per client, and collapsing them would make the stored count
 * disagree with the portal's own for a reason that has nothing to do with
 * truncation — which is precisely the signal this exists to clear.
 */
export async function fetchAllParties(
  client: HttpClient,
  ca: string,
  firstPageHtml: string,
  totals: { ativo: number | null; passivo: number | null },
): Promise<PagedParties> {
  const parties = [...parseParties(firstPageHtml).parties]
  const viewState = parseViewState(firstPageHtml)
  const scrollers = parsePartyScrollers(firstPageHtml)
  if (viewState === null || scrollers.length === 0) return { parties, extraRequests: 0 }

  const url = detailUrl(ca)
  let extraRequests = 0

  for (const scroller of scrollers) {
    // Each list is bounded by its own declared total. A list this does not
    // recognise gets one page — the one already parsed — rather than a guess.
    const total = scroller.list.includes('PoloAtivo')
      ? totals.ativo
      : scroller.list.includes('PoloPassivo')
        ? totals.passivo
        : 1
    const formId = scroller.scrollerId.split(':')[0]!

    for (let page = 2; page <= pageCount(total); page++) {
      const res = await client.request(url, {
        method: 'POST',
        body: new URLSearchParams({
          // `_viewRoot`, not the region id. See the note at the top.
          AJAXREQUEST: '_viewRoot',
          [formId]: formId,
          [scroller.scrollerId]: String(page),
          ajaxSingle: scroller.scrollerId,
          'javax.faces.ViewState': viewState,
          'AJAX:EVENTS_COUNT': '1',
        }).toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=ISO-8859-1',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: url,
        },
      })
      extraRequests++
      // The ajax response is a fragment of the same markup, so the same
      // parser reads it — the rows come back in the table it re-rendered.
      parties.push(...parseParties(decodeLatin1(res.body)).parties)
    }
  }

  return { parties, extraRequests }
}
