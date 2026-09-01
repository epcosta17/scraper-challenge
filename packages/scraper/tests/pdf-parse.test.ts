import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { extractTextStreams, reconstructText, parseCaseRecord } from '../src/pdf/parse.ts'

const pdf = readFileSync(fileURLToPath(new URL('./fixtures/case-130100.pdf', import.meta.url)))

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

  it('throws a typed error when the buffer is not a PDF', () => {
    expect(() => parseCaseRecord(Buffer.from('<html>error</html>'))).toThrow(/not a PDF/i)
  })
})
