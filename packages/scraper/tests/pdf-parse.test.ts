import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import {
  extractTextStreams, reconstructText, parseCaseRecord, parseMovements, isUnnumberedSummary,
} from '../src/pdf/parse.ts'

const pdf = readFileSync(fileURLToPath(new URL('./fixtures/case-130100.pdf', import.meta.url)))
// Captured live from 0800245-51.2020.4.05.8002 (idProcessoTrf 54225) — the
// case that surfaced the detail page's movements table rendering only its
// first page (15 of a stated 39; it CAN be paged, via a slider — see
// `pje/detail.ts`'s `parseMovementsTotal` — but the PDF is read instead, at
// no extra request). Its summary PDF prints the whole 39-entry log across
// three report pages — this fixture is what proves `parseMovements`
// recovers all of them, including across the page-break boilerplate in
// between.
const pdfWithPagedMovements = readFileSync(fileURLToPath(new URL('./fixtures/case-54225.pdf', import.meta.url)))
// Captured live from 0024885-29.2005.4.05.0000 (idProcessoTrf 28907) — a
// 157-movement log where several real entries embed a second, self-
// referential timestamp in their own description ("Disponibilizado no DJ
// Eletrônico em <date> <time>"), in the exact shape an entry's own leading
// timestamp has. This is what proves `parseMovements` doesn't misread that
// embedded timestamp as a second, bogus entry (see the regression test
// below).
const pdfWithEmbeddedTimestamps = readFileSync(fileURLToPath(new URL('./fixtures/case-28907.pdf', import.meta.url)))

describe('extractTextStreams', () => {
  it('finds text streams beyond the first stream in the file', () => {
    const streams = extractTextStreams(pdf)
    expect(streams.length).toBeGreaterThan(0)
    expect(streams.join('')).toContain('Tj')
  })

  it('recovers a text stream whose compressed bytes contain a false endstream match', () => {
    // deflateSync with level: 0 emits STORED (uncompressed) deflate blocks, so
    // the literal bytes of `content` -- including the trap "endstream"
    // sequence -- appear verbatim in the compressed output. A naive
    // indexOf('endstream') walk truncates the stream body here, inflateSync
    // then throws on the corrupted tail, and the blanket catch discards a
    // real text stream silently.
    const content = Buffer.from('BT (before endstream after) Tj ET')
    const body = deflateSync(content, { level: 0 })
    const fakePdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n<< /Length 99 >>\nstream\n'),
      body,
      Buffer.from('\nendstream\n'),
    ])

    const streams = extractTextStreams(fakePdf)
    expect(streams.join('')).toContain('before endstream after')
  })

  it('does not let a non-inflatable stream hide the streams that follow it', () => {
    // A stream using a non-Flate filter (image, font: DCTDecode, CCITTFaxDecode,
    // etc.) never inflates no matter which `endstream` candidate is tried. That
    // must not take down extraction of the streams that come after it.
    const nonInflatable = Buffer.concat([
      Buffer.from('%PDF-1.4\n<< /Length 99 /Filter /DCTDecode >>\nstream\n'),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from(' not deflate'),
      Buffer.from('\nendstream\n'),
    ])

    const content = Buffer.from('BT (second stream text) Tj ET')
    const body = deflateSync(content)
    const textStream = Buffer.concat([
      Buffer.from('<< /Length 50 /Filter /FlateDecode >>\nstream\n'),
      body,
      Buffer.from('\nendstream\n'),
    ])

    const fakePdf = Buffer.concat([nonInflatable, textStream])

    const streams = extractTextStreams(fakePdf)
    expect(streams.join('')).toContain('second stream text')
  })

  it('bounds the retry so a non-inflatable stream cannot swallow several later streams', () => {
    const nonInflatable = Buffer.concat([
      Buffer.from('%PDF-1.4\n<< /Length 99 /Filter /DCTDecode >>\nstream\n'),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from(' not deflate'),
      Buffer.from('\nendstream\n'),
    ])

    const makeTextStream = (text: string) => {
      const body = deflateSync(Buffer.from(`BT (${text}) Tj ET`))
      return Buffer.concat([
        Buffer.from('<< /Length 50 /Filter /FlateDecode >>\nstream\n'),
        body,
        Buffer.from('\nendstream\n'),
      ])
    }

    const fakePdf = Buffer.concat([
      nonInflatable,
      makeTextStream('stream two'),
      makeTextStream('stream three'),
      makeTextStream('stream four'),
    ])

    const streams = extractTextStreams(fakePdf)
    const joined = streams.join('')
    expect(joined).toContain('stream two')
    expect(joined).toContain('stream three')
    expect(joined).toContain('stream four')
  })
})

describe('reconstructText', () => {
  it('recovers readable field labels', () => {
    const text = reconstructText(extractTextStreams(pdf))
    expect(text).toContain('Número do Processo')
    expect(text).toContain('Classe Judicial')
  })

  it('unescapes parentheses so subject codes are not truncated', () => {
    const text = reconstructText(extractTextStreams(pdf))
    expect(text).not.toContain('\\(')
    expect(text).not.toContain('\\)')
  })
})

describe('parseCaseRecord', () => {
  it('extracts the case number', () => {
    expect(parseCaseRecord(pdf).number).toBe('0013475-36.2026.4.05.0000')
  })

  it('extracts class name and CNJ code', () => {
    const rec = parseCaseRecord(pdf)
    expect(rec.className).toBe('AGRAVO DE INSTRUMENTO')
    expect(rec.classCode).toBe('202')
  })

  it('extracts court and panel', () => {
    const rec = parseCaseRecord(pdf)
    expect(rec.court).toContain('PAULO CORDEIRO')
    expect(rec.panel).toBe('2ª Turma')
  })

  it('extracts subjects with word boundaries preserved across wrapped PDF lines', () => {
    // Recon: "Alienação" and "Fiduciária" are drawn as two separate Tj calls
    // on two lines of the same stream. A naive literal join glues them into
    // "AlienaçãoFiduciária" with no space; reconstructText must insert one at
    // the Tm/Td/TD/T* boundary between them.
    const { subjects } = parseCaseRecord(pdf)
    expect(subjects).toContain('DIREITO CIVIL (899)')
    expect(subjects.some((s) => s.includes('Alienação Fiduciária'))).toBe(true)
    expect(subjects.some((s) => s.includes('AlienaçãoFiduciária'))).toBe(false)
  })

  it('extracts the distribution date', () => {
    expect(parseCaseRecord(pdf).distributedAt).toBe('17 de Agosto de 2026')
  })

  it('throws a typed error when the buffer is not a PDF', () => {
    expect(() => parseCaseRecord(Buffer.from('<html>error</html>'))).toThrow(/not a PDF/i)
  })
})

describe('parseMovements', () => {
  it('parses every entry from a single-page log, in the page\'s own order', () => {
    const movements = parseMovements(pdf)
    expect(movements).toHaveLength(10)
    expect(movements[0]).toEqual({
      position: 0, timestamp: '27/08/2026 00:08:06', description: 'Publicado Decisão em 27/08/2026.',
    })
    expect(movements.at(-1)).toEqual({
      position: 9, timestamp: '17/08/2026 14:56:43', description: 'Distribuído por sorteio',
    })
    // Ordering is preserved verbatim, not re-sorted by timestamp — two
    // consecutive entries share the exact same timestamp in this log.
    expect(movements.map((m) => m.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  // The load-bearing case: a 3-page report whose log is interrupted twice by
  // page-break boilerplate — once by a bare "Data de atualização Movimento"
  // column-header repeat, once by a "Visualizado/Impresso em:<timestamp>"
  // stamp whose own timestamp would otherwise be misread as a 40th, bogus
  // entry (a naive extractor found exactly that — 40, not 39). The detail
  // page's own stated total for this same case is 39 (see
  // `detail.test.ts`'s live-derived fixtures), which is what this asserts
  // against, not just a round number.
  it('recovers the complete log across page-break boilerplate, matching the detail page\'s own stated total', () => {
    const movements = parseMovements(pdfWithPagedMovements)
    expect(movements).toHaveLength(39)
    expect(movements[0]).toMatchObject({
      position: 0, timestamp: '11/06/2026 11:23:11',
      description: 'Remetidos os Autos (por julgamento definitivo do recurso) para 1º GRAU',
    })
    expect(movements.at(-1)).toMatchObject({
      position: 38, timestamp: '08/01/2026 11:08:53', description: 'Distribuído por sorteio',
    })
    // Neither page-break artifact survives into any description: no stray
    // "Visualizado/Impresso" stamp, and no bare page-number digit leaking in
    // from the column-header repeat.
    for (const m of movements) {
      expect(m.description).not.toContain('Visualizado')
      expect(m.description).not.toMatch(/^\d{1,2}$/)
    }
  })

  it('returns an empty list rather than throwing when the section header is absent', () => {
    expect(parseMovements(Buffer.from('%PDF-1.4\nno movements section here'))).toEqual([])
  })

  // Found live (case 0024885-29.2005.4.05.0000): several real entries embed
  // a second, self-referential `DD/MM/YYYY HH:MM:SS` timestamp in their own
  // description — "Disponibilizado no DJ Eletrônico em 05/03/2020 03:12:14"
  // is itself the description of the entry timestamped 05/03/2020 03:12:14,
  // not two entries. A naive split on every timestamp-shaped match misread
  // each one as an extra, bogus entry with an empty (or punctuation-only)
  // description — 166 matches where the detail page's own stated total, and
  // the true count, is 157. The fix excludes a timestamp preceded by "em "
  // from ever starting a new entry, since only an embedded, self-referential
  // one is ever introduced that way — a real entry boundary never is.
  it('does not split a real entry in two when its own description embeds a second timestamp', () => {
    const movements = parseMovements(pdfWithEmbeddedTimestamps)
    expect(movements).toHaveLength(157)
    // No entry has an empty or punctuation-only description — the exact
    // symptom the 9 phantom entries had.
    for (const m of movements) expect(m.description.replace(/[.\s]/g, '').length).toBeGreaterThan(0)
    // Position stays contiguous — no gaps left behind by the fix.
    expect(movements.map((m) => m.position)).toEqual(Array.from({ length: 157 }, (_, i) => i))
    // The specific real entry that used to get split in two comes back
    // whole, with the embedded timestamp intact as part of its description.
    expect(movements.find((m) => m.timestamp === '05/03/2020 03:12:14')).toMatchObject({
      description: 'Disponibilizado no DJ Eletrônico em 05/03/2020 03:12:14',
    })
  })
})

describe('a summary the portal answers without a case number', () => {
  const fixture = (name: string): Buffer =>
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))
  const unnumbered = fixture('summary-unnumbered.pdf')

  /**
   * Captured live from id 134050. The portal answers, the PDF is well formed,
   * and it carries the judicial class, the full subject list and both poles
   * with their parties by name and role — everything except the number, the
   * judging panel, the distribution date and the movements.
   *
   * That is not an id with nothing behind it, and it is not a transient
   * error. It reads as a case that exists and has not been distributed yet
   * (or is restricted): retrying will not produce a number, and the scraper
   * had been retrying these up to seven times each.
   */
  it('is recognised as unnumbered rather than reported as a parse failure', () => {
    expect(isUnnumberedSummary(unnumbered)).toBe(true)
  })

  it('is not confused with a summary that simply failed to parse', () => {
    // A page that carries no case data at all is a different thing, and has
    // to keep going down the failure path.
    expect(isUnnumberedSummary(fixture('sample-document.pdf'))).toBe(false)
  })

  it('still refuses to invent a record for it', () => {
    // The distinction is about how it is *recorded*, not about pretending a
    // numberless case can be stored: there is no key to store it under.
    expect(() => parseCaseRecord(unnumbered)).toThrow(/case number/)
  })
})
