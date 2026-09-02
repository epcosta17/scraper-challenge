import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parsePartyScrollers, parseViewState, pageCount, fetchAllParties,
} from '../src/pje/parties-pages.ts'
import { parseParties } from '../src/pje/detail.ts'
import type { HttpClient } from '../src/http/client.ts'

const fx = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'latin1')

/** A real case file: 25 ativo, 25 passivo, 1 outro — three paged lists. */
const PAGED = fx('detail-parties-paged.html')

describe('reading the participant scrollers off a case file', () => {
  it('finds every paged list, not only the two poles', () => {
    const found = parsePartyScrollers(PAGED)
    const lists = found.map((s) => s.list)
    expect(lists).toContain('processoPartesPoloAtivoResumidoList')
    expect(lists).toContain('processoPartesPoloPassivoResumidoList')
    // The third one is easy to miss by reading the design rather than the
    // page: a case file has "outros interessados" as well as the two poles.
    expect(lists).toContain('processoParteOutrosInteressadosResumidoList')
  })

  it('takes the view state the ajax POST has to echo back', () => {
    expect(parseViewState(PAGED)).toBe('j_id2')
  })

  it('has no view state to report on a page that carries none', () => {
    expect(parseViewState('<html><body>nada</body></html>')).toBeNull()
  })
})

describe('how many pages a list spans', () => {
  it('is one when the whole list already fits', () => {
    expect(pageCount(1)).toBe(1)
    expect(pageCount(10)).toBe(1)
  })

  it('rounds up, because a remainder is still a page', () => {
    expect(pageCount(11)).toBe(2)
    expect(pageCount(25)).toBe(3)
    expect(pageCount(50)).toBe(5)
  })

  /**
   * Bounded by the declared total rather than probed. Asking the portal for a
   * page past the end does not error — it re-serves the last one — so a loop
   * that stopped on "no new rows" would be working by accident, and one with
   * no bound would never stop.
   */
  it('is one when the page declares no total at all', () => {
    expect(pageCount(null)).toBe(1)
  })
})

describe('following the scroller', () => {
  const secondPage = (rows: string): string => rows

  it('asks only for the pages the first one did not cover', async () => {
    const asked: string[] = []
    const client = {
      async request(_url: string, init?: { body?: string }) {
        const body = new URLSearchParams(init?.body ?? '')
        for (const [k, v] of body) {
          if (/Resumido/.test(k) && !k.endsWith('ajaxSingle')) asked.push(`${k.split(':')[1]}=${v}`)
        }
        return { status: 200, headers: {}, body: Buffer.from('<html></html>', 'latin1') }
      },
    } as unknown as HttpClient

    await fetchAllParties(client, 'a'.repeat(48), PAGED, { ativo: 25, passivo: 25 })

    // 25 participants at ten a page is three pages; two of them still to ask
    // for, per pole. The third list declares one and is left alone.
    expect(asked.filter((a) => a.startsWith('processoPartesPoloAtivo'))).toEqual([
      'processoPartesPoloAtivoResumidoList=2',
      'processoPartesPoloAtivoResumidoList=3',
    ])
    expect(asked.filter((a) => a.startsWith('processoPartesPoloPassivo'))).toEqual([
      'processoPartesPoloPassivoResumidoList=2',
      'processoPartesPoloPassivoResumidoList=3',
    ])
    expect(asked.filter((a) => a.startsWith('processoParteOutros'))).toEqual([])
  })

  it('sends AJAXREQUEST=_viewRoot, which is what makes the action run at all', async () => {
    // Built from the region id — the obvious reading of the page's own script
    // — the POST comes back 200 with an empty Ajax-Update-Ids and no rows.
    // This is the one parameter that is not written on the page.
    let seen: URLSearchParams | null = null
    const client = {
      async request(_url: string, init?: { body?: string }) {
        seen ??= new URLSearchParams(init?.body ?? '')
        return { status: 200, headers: {}, body: Buffer.from('<html></html>', 'latin1') }
      },
    } as unknown as HttpClient

    await fetchAllParties(client, 'a'.repeat(48), PAGED, { ativo: 25, passivo: null })
    expect(seen!.get('AJAXREQUEST')).toBe('_viewRoot')
    expect(seen!.get('javax.faces.ViewState')).toBe('j_id2')
    expect(seen!.get('AJAX:EVENTS_COUNT')).toBe('1')
    // The form is the scroller id's own first segment, not the first form on
    // the page — which is a different one, and produces a POST that does
    // nothing.
    expect(seen!.get('j_id146')).toBe('j_id146')
  })

  it('costs nothing extra when every list already fits on its page', async () => {
    let requests = 0
    const client = {
      async request() {
        requests++
        return { status: 200, headers: {}, body: Buffer.from('<html></html>', 'latin1') }
      },
    } as unknown as HttpClient

    const out = await fetchAllParties(client, 'a'.repeat(48), PAGED, { ativo: 4, passivo: 6 })
    expect(requests).toBe(0)
    expect(out.extraRequests).toBe(0)
    expect(out.parties).toEqual(parseParties(PAGED).parties)
  })

  it('keeps a participant who genuinely appears twice', async () => {
    // The same lawyer really does appear once per client, and collapsing
    // duplicates would make the stored count disagree with the portal's own
    // for a reason that has nothing to do with truncation — which is exactly
    // the signal this code exists to clear.
    const twice = secondPage(PAGED)
    const client = {
      async request() {
        return { status: 200, headers: {}, body: Buffer.from(twice, 'latin1') }
      },
    } as unknown as HttpClient

    const first = parseParties(PAGED).parties.length
    const out = await fetchAllParties(client, 'a'.repeat(48), PAGED, { ativo: 25, passivo: null })
    expect(out.parties.length).toBe(first + 2 * first)
  })
})
