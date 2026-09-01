import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { HttpClient } from '../src/http/client.ts'
import {
  parseDetailPage, fetchDetail, UnrecognisedDetailPageError,
  parseProcessFields, parseParties, parseMovementsTotal,
  type BinaryDocumentRef, type HtmlDocumentRef,
} from '../src/pje/detail.ts'

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))

const detailWithDocs = fixture('detail-with-docs.html').toString('latin1')
const detailHtmlOnly = fixture('detail-html-docs-only.html').toString('latin1')
const detailInvalidCa = fixture('detail-invalid-ca.html').toString('latin1')
const detailWithMovementPopups = fixture('detail-with-movement-popups.html').toString('latin1')
// Captured live from 0024885-29.2005.4.05.0000 (idProcessoTrf 28907) — a
// passivo list of 40 participants spanning several Datascroller pages, only
// the first of which renders (10 rows). This is what surfaced the
// scroller's own page-control row being misread as an 11th, spurious
// participant (see the `parseParties` regression test below).
const detailPaginatedParties = fixture('detail-paginated-parties.html').toString('latin1')

function clientReturning(body: string, status = 200, url = 'https://x/listView.seam') {
  const fetchImpl = (async () => {
    const r = new Response(Buffer.from(body, 'latin1'), { status })
    Object.defineProperty(r, 'url', { value: url })
    return r
  }) as unknown as typeof fetch
  return new HttpClient({ fetchImpl, sleep: async () => {}, rps: 0 })
}

describe('parseDetailPage', () => {
  it('parses a case with both binary and HTML documents (0801438-34.2016.4.05.8102)', () => {
    const docs = parseDetailPage(detailWithDocs)
    const binary = docs.filter((d): d is BinaryDocumentRef => d.kind === 'binary')
    const html = docs.filter((d): d is HtmlDocumentRef => d.kind === 'html')
    expect(binary).toHaveLength(9)
    expect(html).toHaveLength(1)
  })

  it('extracts all four required fields for a binary document', () => {
    const docs = parseDetailPage(detailWithDocs)
    const first = docs.find((d): d is BinaryDocumentRef => d.kind === 'binary' && d.id === 12284583)
    expect(first).toMatchObject({
      kind: 'binary',
      id: 12284583,
      idBin: 12039033,
      numeroDocumento: '4caf3e2af32f9130b384fc0c2aef62251e2b3823',
      date: '24/07/2025 20:30:45',
      type: 'Despacho',
    })
    expect(first!.label).toBe('24/07/2025 20:30:45 - Despacho (Despacho)')
  })

  it('decodes accented HTML entities in the label', () => {
    const docs = parseDetailPage(detailWithDocs)
    const decisao = docs.find((d) => d.type === 'Decisão')
    expect(decisao).toBeDefined()
    expect(decisao!.label).toContain('Decisão')
  })

  it('extracts the session-bound ca and id for an HTML document', () => {
    const docs = parseDetailPage(detailWithDocs)
    const html = docs.find((d): d is HtmlDocumentRef => d.kind === 'html')
    expect(html).toMatchObject({ kind: 'html', id: 12284587 })
    expect(html!.ca).toMatch(/^[0-9a-f]{112}$/)
    expect(html!.date).toBe('13/02/2026 14:32:27')
  })

  it('parses a case with only HTML documents and zero binary ones (0005425-26.2026.4.05.8308)', () => {
    const docs = parseDetailPage(detailHtmlOnly)
    expect(docs.filter((d) => d.kind === 'binary')).toHaveLength(0)
    expect(docs.filter((d) => d.kind === 'html')).toHaveLength(2)
  })

  // Captured live from case 0013478-88.2026.4.05.0000: its timeline has five
  // "view movement" triggers that reuse the exact same documentoSemLoginHTML.seam
  // endpoint and ca-shape as the one real document on the page (a real,
  // fetchable document — verified live, see download.test.ts's fixtures),
  // but never carry idProcessoDoc — that param belongs to the document, not
  // the movement. They're kept, not dropped: each gets a synthetic id
  // derived from the case number and its own label, since the trigger's own
  // `ca` is too short-lived (changes on every re-fetch, live-verified) to
  // key a resumable download on.
  it('gives a timeline "view movement" trigger with no idProcessoDoc a synthetic id, keeping the real document too', () => {
    const docs = parseDetailPage(detailWithMovementPopups)
    // 1 real document (idProcessoDoc=12114281) + 5 timeline triggers.
    expect(docs).toHaveLength(6)

    const real = docs.find((d) => d.kind === 'html' && d.idProcessoDoc === 12114281)
    expect(real).toBeDefined()

    const synthetic = docs.filter((d): d is HtmlDocumentRef => d.kind === 'html' && d.idProcessoDoc === null)
    expect(synthetic).toHaveLength(5)
    for (const d of synthetic) {
      // Clear of any real idProcessoDocumento observed in the wild (a few
      // million) so a synthetic and a real id can never collide.
      expect(d.id).toBeGreaterThan(1_000_000_000_000)
    }
    // The five triggers carry only two distinct labels (the timeline
    // references the same underlying acts from multiple movements), and
    // the synthetic id is derived from the label — so they collapse to two
    // distinct ids, not five, without any dedup logic in the parser itself.
    expect(new Set(synthetic.map((d) => d.id)).size).toBe(2)
  })

  it('derives the same synthetic id for the same case+label every time — a stable key across re-fetches', () => {
    const a = parseDetailPage(detailWithMovementPopups).map((d) => d.id)
    const b = parseDetailPage(detailWithMovementPopups).map((d) => d.id)
    expect(a).toEqual(b)
  })

  // Finding from a live range run: one malformed row (a binary link missing
  // a required param) used to throw and abort the entire case, losing every
  // other document on the page along with it. A case should only fail when
  // the case itself can't be reached — not because one row had a shape the
  // parser didn't expect.
  it('turns a binary link missing a required parameter into a malformed ref, without losing the rest of the page', () => {
    const broken = detailWithDocs.replace('numeroDocumento=4caf3e2af32f9130b384fc0c2aef62251e2b3823&amp;', '')
    const docs = parseDetailPage(broken)
    const malformed = docs.filter((d) => d.kind === 'malformed')
    expect(malformed).toHaveLength(1)
    expect(malformed[0]!.raw).toContain('idBin=12039033')
    expect(docs.filter((d) => d.kind === 'binary')).toHaveLength(8)
    expect(docs.filter((d) => d.kind === 'html')).toHaveLength(1)
  })

  it('turns an HTML trigger with an unrecognised ca shape into a malformed ref too', () => {
    const broken = detailWithDocs.replace(/documentoSemLoginHTML\.seam\?ca=[0-9a-f]{112}/, 'documentoSemLoginHTML.seam?ca=not-hex-at-all')
    const docs = parseDetailPage(broken)
    expect(docs.filter((d) => d.kind === 'malformed')).toHaveLength(1)
    expect(docs.filter((d) => d.kind === 'binary')).toHaveLength(9)
  })
})

describe('parseProcessFields', () => {
  it('extracts jurisdiction, courtAddress and referenceNumber from the rich fixture', () => {
    const fields = parseProcessFields(detailWithDocs)
    expect(fields).toEqual({
      jurisdiction: 'TRF5',
      courtAddress:
        'Tribunal Regional Federal - 5ª Região, Cais do Apolo, s/n, Recife, RECIFE - PE - CEP: 50030-908',
      referenceNumber: '0801438-34.2016.4.05.8102',
    })
  })

  // The sparse 2026 case: same three fields, different values — proves the
  // parser isn't accidentally keyed on anything specific to the rich case.
  it('extracts the same three fields from the sparse fixture', () => {
    const fields = parseProcessFields(detailHtmlOnly)
    expect(fields).toEqual({
      jurisdiction: 'TRF5',
      courtAddress:
        'Tribunal Regional Federal - 5ª Região, Cais do Apolo, s/n, Recife, RECIFE - PE - CEP: 50030-908',
      referenceNumber: '0005425-26.2026.4.05.8308',
    })
  })

  it('returns null fields rather than throwing when the panel is entirely absent', () => {
    expect(parseProcessFields('<html><body>no panel here</body></html>')).toEqual({
      jurisdiction: null, courtAddress: null, referenceNumber: null,
    })
  })
})

describe('parseParties', () => {
  it('splits each participant row into name, document, oab, role and situation (rich fixture)', () => {
    const { parties, ativoTotal, passivoTotal } = parseParties(detailWithDocs)
    expect(ativoTotal).toBe(2)
    expect(passivoTotal).toBe(1)
    expect(parties).toHaveLength(3)

    expect(parties).toContainEqual({
      polo: 'ativo',
      name: 'CONSELHO REGIONAL DE ODONTOLOGIA DO CEARA',
      documentType: 'cnpj',
      documentNumber: '07.299.589/0001-10',
      oab: null,
      role: 'APELANTE',
      situation: 'Ativo',
    })
    expect(parties).toContainEqual({
      polo: 'ativo',
      name: 'ALLEX KONNE DE NOGUEIRA E SOUZA',
      documentType: 'cpf',
      documentNumber: '640.535.983-20',
      oab: 'CE17669-A',
      role: 'ADVOGADO',
      situation: 'Ativo',
    })
    expect(parties).toContainEqual({
      polo: 'passivo',
      name: 'BENJAMIM SAMPAIO FILHO',
      documentType: 'cpf',
      documentNumber: '102.897.124-91',
      oab: null,
      role: 'APELADO',
      situation: 'Ativo',
    })
  })

  // The sparse fixture's passivo entry embeds an abbreviation ("CREF12/PE")
  // between the entity name and its CNPJ, joined by the same " - " a real
  // field is — proves the parser matches known fields (CNPJ/CPF/OAB) rather
  // than naively splitting on every dash.
  it('keeps an embedded abbreviation as part of the name instead of misparsing it as a field (sparse fixture)', () => {
    const { parties, ativoTotal, passivoTotal } = parseParties(detailHtmlOnly)
    expect(ativoTotal).toBe(2)
    expect(passivoTotal).toBe(2)
    expect(parties).toContainEqual({
      polo: 'passivo',
      name: 'CONSELHO REGIONAL DE EDUCACAO FISICA DA 12 REGIAO/PERNAMBUCO - CREF12/PE',
      documentType: 'cnpj',
      documentNumber: '03.956.986/0001-66',
      oab: null,
      role: 'APELADO',
      situation: 'Ativo',
    })
  })

  it('returns an empty list and null totals when neither polo table is present', () => {
    expect(parseParties('<html><body>no parties here</body></html>')).toEqual({
      parties: [], ativoTotal: null, passivoTotal: null,
    })
  })

  // The anti-truncation contract this whole feature exists for: a page that
  // states more participants than it actually rendered must be detectable
  // by comparing the parsed count against the stated total — never silently
  // treated as a complete list. `crawl/deep.ts` is what acts on this.
  it('lets the caller detect truncation by disagreeing with the stated total', () => {
    const patched = detailWithDocs.replace('2 resultados encontrados', '5 resultados encontrados')
    const { parties, ativoTotal } = parseParties(patched)
    const ativoParsed = parties.filter((p) => p.polo === 'ativo').length
    expect(ativoTotal).toBe(5)
    expect(ativoParsed).toBe(2)
    expect(ativoParsed).not.toBe(ativoTotal)
  })

  // Found live (case 0800245-51.2020.4.05.8002): a participant row can carry
  // a trailing `<ul class="tree">` of real, non-empty auxiliary text — here
  // a "Procuradoria" line naming the representing office — not just the
  // always-empty "Defensoria" marker both fixtures happen to show. Left in,
  // that text lands after the role's closing paren and breaks the
  // trailing-`(...)`-is-the-role assumption entirely (verified: before this
  // fix, `role` came back `null` for this exact row). The whole `<ul>` must
  // be stripped regardless of what it contains, not just when it's empty.
  it('strips a non-empty auxiliary annotation (e.g. a representing office) instead of letting it swallow the role', () => {
    const html = `
      <table id="x:processoPartesPoloPassivoResumidoList"><tbody><tr>
        <td><span id="j_id146:processoPartesPoloPassivoResumidoList:0:j_id361">
          <div class="col-sm-12 "><span class="text-bold">MINISTÉRIO PÚBLICO FEDERAL - CNPJ: 03.636.198/0001-92 (APELADO)</span>
            <div class="col-sm-12 "></div>
            <style type="text/css">.none { list-style-type: none; }</style>
            <ul class="tree">
              <li>
                <small class="text-muted"><img src="" class="fa fa-users mr-10">
                  <span title="Procuradoria">PROCURADORIA MINISTÉRIO PÚBLICO FEDERAL</span>
                </small>
              </li>
            </ul>
          </div></span></td>
        <td><div class="col-sm-12">Ativo</div></td>
      </tr></tbody></table><span class="pull-right text-muted">1 resultados encontrados</span>
    `
    const { parties } = parseParties(html)
    expect(parties).toEqual([{
      polo: 'passivo',
      name: 'MINISTÉRIO PÚBLICO FEDERAL',
      documentType: 'cnpj',
      documentNumber: '03.636.198/0001-92',
      oab: null,
      role: 'APELADO',
      situation: 'Ativo',
    }])
  })

  // Found live (case 0024885-29.2005.4.05.0000): a Datascroller's own
  // page-control row (««, «, page numbers, », »» — whichever glyph is
  // active depends on the current page) lives in a `<tr>` inside the same
  // `tbody` as the real participant rows and was being parsed as an 11th,
  // spurious passivo participant with no document and no role. Only 10 of
  // this passivo table's 40 declared participants render on this page (the
  // rest sit behind pages this scraper doesn't follow), so this also
  // exercises the truncation check on a genuinely long, real list — the
  // scenario flagged as under-tested against fixtures with only 1-4
  // participants.
  it('excludes the Datascroller control row from a paginated participant list, still reporting truncation', () => {
    const { parties, ativoTotal, passivoTotal } = parseParties(detailPaginatedParties)
    expect(ativoTotal).toBe(1)
    expect(passivoTotal).toBe(40)
    expect(parties.filter((p) => p.polo === 'ativo')).toHaveLength(1)
    const passivo = parties.filter((p) => p.polo === 'passivo')
    // 10 real rows, not 11 — the control row is gone.
    expect(passivo).toHaveLength(10)
    for (const p of passivo) {
      expect(p.name.length).toBeGreaterThan(0)
      expect(p.documentType !== null || p.role !== null).toBe(true)
    }
    expect(passivo).not.toContainEqual(expect.objectContaining({ name: '««' }))
  })
})

describe('parseMovementsTotal', () => {
  it('reads the stated total without parsing any rows (rich fixture)', () => {
    expect(parseMovementsTotal(detailWithDocs)).toBe(5)
  })

  it('reads the stated total for the sparse fixture too', () => {
    expect(parseMovementsTotal(detailHtmlOnly)).toBe(7)
  })

  it('returns null when the table is absent', () => {
    expect(parseMovementsTotal('<html><body>no movements here</body></html>')).toBeNull()
  })
})

describe('fetchDetail', () => {
  it('classifies a real case page (with documents) as valid', async () => {
    const res = await fetchDetail(clientReturning(detailWithDocs), 'ca'.repeat(24))
    expect(res.kind).toBe('valid')
    if (res.kind === 'valid') expect(res.documents).toHaveLength(10)
  })

  it('classifies the HTML-only case page as valid too', async () => {
    const res = await fetchDetail(clientReturning(detailHtmlOnly), 'ca'.repeat(24))
    expect(res.kind).toBe('valid')
    if (res.kind === 'valid') expect(res.documents).toHaveLength(2)
  })

  it('carries process fields, parties and the movements total alongside the documents', async () => {
    const res = await fetchDetail(clientReturning(detailWithDocs), 'ca'.repeat(24))
    expect(res.kind).toBe('valid')
    if (res.kind !== 'valid') return
    expect(res.processFields.jurisdiction).toBe('TRF5')
    expect(res.parties).toHaveLength(3)
    expect(res.partiesAtivoTotal).toBe(2)
    expect(res.partiesPassivoTotal).toBe(1)
    expect(res.movementsTotal).toBe(5)
  })

  // Captured live: a `ca` of 48 `a`s produces a 200 response with the same
  // "Detalhe do Processo" title as a real case page, but none of the real
  // content — only this diagnostic. If a stale `ca` were misclassified as
  // valid, the caller would report a real case as having zero documents
  // instead of re-deriving `ca` through the search bridge.
  it('classifies the captured invalid/expired-ca page as invalid', async () => {
    const res = await fetchDetail(clientReturning(detailInvalidCa), 'a'.repeat(48))
    expect(res.kind).toBe('invalid')
  })

  it('throws on a response that looks like neither a real case page nor the known invalid-ca page', async () => {
    await expect(fetchDetail(clientReturning('<html>maintenance</html>', 200), 'x'.repeat(48)))
      .rejects.toThrow(UnrecognisedDetailPageError)
  })
})
