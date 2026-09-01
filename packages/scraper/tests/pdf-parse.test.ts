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
