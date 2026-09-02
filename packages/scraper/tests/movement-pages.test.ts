import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseMovementPager, parseMovementRows, movementPageCount, fetchMovementPage,
  MOVEMENTS_PAGE_SIZE,
} from '../src/pje/movement-pages.ts'
import type { HttpClient } from '../src/http/client.ts'

const fx = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'latin1')

/** A real case file: 4,182 movements over 279 pages. */
const PAGED = fx('detail-parties-paged.html')

describe('reading the movements pager off a case file', () => {
  it('takes every id the POST needs from the page itself', () => {
    const pager = parseMovementPager(PAGED)!
    expect(pager.pageParam).toBe('j_id146:j_id561:j_id562')
    // The form is the page field's own prefix. The first <form> on the page
    // is a different one, and posting under it does nothing.
    expect(pager.form).toBe('j_id146:j_id561')
    // Named only inside the onchange script, never as a field — reading the
    // form's inputs would miss it entirely.
    expect(pager.control).toBe('j_id146:j_id561:j_id563')
    expect(pager.viewState).toBe('j_id2')
  })

  it('has nothing to report for a page with no slider on it', () => {
    expect(parseMovementPager('<html><body>sin paginador</body></html>')).toBeNull()
  })
})

describe('how many pages the movements span', () => {
  it('is one when they already fit', () => {
    expect(movementPageCount(1)).toBe(1)
    expect(movementPageCount(MOVEMENTS_PAGE_SIZE)).toBe(1)
  })

  it('rounds up, and matches what the portal showed for a real case', () => {
    expect(movementPageCount(21)).toBe(2)
    // 4,182 movements, and the portal's own slider reads "1 … 279".
    expect(movementPageCount(4182)).toBe(279)
  })

  it('is one when the page declares no total', () => {
    expect(movementPageCount(null)).toBe(1)
  })
})

describe('the POST that turns the page', () => {
  const capture = async (): Promise<URLSearchParams> => {
    let body: URLSearchParams | null = null
    const client = {
      async request(_url: string, init?: { body?: string }) {
        body ??= new URLSearchParams(init?.body ?? '')
        return { status: 200, headers: {}, body: Buffer.from('', 'latin1') }
      },
    } as unknown as HttpClient
    await fetchMovementPage(client, 'a'.repeat(48), parseMovementPager(PAGED)!, 2)
    return body!
  }

  it('sends the containerId, not _viewRoot', async () => {
    // This is the difference from the participant scroller, which wants the
    // literal `_viewRoot`. Send that here and the panel re-renders with page
    // one every time: the action runs, so nothing looks broken, and the page
    // number is silently ignored.
    expect((await capture()).get('AJAXREQUEST')).toBe('j_id146:j_id474')
  })

  it('reads the response as UTF-8, though the page it came from is Latin-1', async () => {
    // The same server answers the case file in ISO-8859-1 and this fragment in
    // UTF-8, declaring no encoding on either. Decoded the way the page was,
    // every accented movement is stored mojibake — "Distribuído" becomes
    // "DistribuÃ­do", and that is what would reach the search index.
    const utf8 = Buffer.from(
      '<span id="x:processoEvento:0:y">30/03/2021 13:41:19 - Distribuído por sorteio</span>',
      'utf8',
    )
    const client = {
      async request() { return { status: 200, headers: {}, body: utf8 } },
    } as unknown as HttpClient
    const page = await fetchMovementPage(client, 'a'.repeat(48), parseMovementPager(PAGED)!, 2)
    expect(parseMovementRows(page)[0]!.description).toBe('Distribuído por sorteio')
  })

  it('sends the slider\'s own submit control', async () => {
    const body = await capture()
    expect(body.get('j_id146:j_id561:j_id563')).toBe('j_id146:j_id561:j_id563')
    expect(body.get('j_id146:j_id561:j_id562')).toBe('2')
    expect(body.get('j_id146:j_id561')).toBe('j_id146:j_id561')
    expect(body.get('javax.faces.ViewState')).toBe('j_id2')
    expect(body.get('AJAX:EVENTS_COUNT')).toBe('1')
  })
})

describe('reading the rows', () => {
  it('reads timestamp and description from the table', () => {
    const rows = parseMovementRows(PAGED)
    expect(rows.length).toBe(MOVEMENTS_PAGE_SIZE)
    expect(rows[0]).toEqual({
      timestamp: '22/08/2026 09:59:22',
      description: 'Conclusos para decisão',
    })
  })

  it('counts rows, which is why it cannot drift the way the PDF count did', () => {
    // The version this replaces scanned a PDF's extracted text for anything
    // shaped like a timestamp, and reported 4,200 movements on a case whose
    // page declares 4,182. A row is a row.
    expect(parseMovementRows(PAGED)).toHaveLength(15)
  })

  it('finds nothing in a page that has no table', () => {
    expect(parseMovementRows('<html><body>vacío</body></html>')).toEqual([])
  })
})
