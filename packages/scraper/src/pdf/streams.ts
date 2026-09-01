import { inflateSync } from 'node:zlib'

/**
 * Returns the inflated content of every stream that carries text-drawing
 * operators. Recon finding: a summary PDF has ~4 streams and the text lives
 * in the later ones, so scanning only the first stream yields nothing.
 */
export function extractTextStreams(pdf: Buffer): string[] {
  const out: string[] = []
  const marker = Buffer.from('stream')
  const endMarker = Buffer.from('endstream')

  let cursor = 0
  while (cursor < pdf.length) {
    const start = pdf.indexOf(marker, cursor)
    if (start === -1) break
    let dataStart = start + marker.length
    // Skip the EOL that follows the `stream` keyword.
    if (pdf[dataStart] === 0x0d) dataStart++
    if (pdf[dataStart] === 0x0a) dataStart++

    const end = pdf.indexOf(endMarker, dataStart)
    if (end === -1) break

    let dataEnd = end
    if (pdf[dataEnd - 1] === 0x0a) dataEnd--
    if (pdf[dataEnd - 1] === 0x0d) dataEnd--

    const raw = pdf.subarray(dataStart, dataEnd)
    try {
      const inflated = inflateSync(raw).toString('latin1')
      if (inflated.includes('Tj') || inflated.includes('TJ')) out.push(inflated)
    } catch {
      // Not a deflate stream (font, image). Skip it.
    }
    cursor = end + endMarker.length
  }
  return out
}
