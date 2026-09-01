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

    // The stream body's compressed bytes can themselves contain the literal
    // ASCII sequence "endstream" (confirmed by a synthetic STORED-deflate
    // fixture in tests). The first `indexOf('endstream')` hit may therefore
    // land inside the real body rather than at its true end, truncating it.
    // If inflating fails, retry against the next `endstream` occurrence
    // rather than discarding the stream outright, so a genuine text stream
    // isn't dropped alongside benign non-inflatable ones (fonts, images).
    let end = pdf.indexOf(endMarker, dataStart)
    let inflated: string | null = null
    while (end !== -1) {
      let dataEnd = end
      if (pdf[dataEnd - 1] === 0x0a) dataEnd--
      if (pdf[dataEnd - 1] === 0x0d) dataEnd--

      const raw = pdf.subarray(dataStart, dataEnd)
      try {
        inflated = inflateSync(raw).toString('latin1')
        break
      } catch {
        // Either a non-inflatable stream (font, image) or a false
        // "endstream" match inside the real body. Try the next occurrence.
        end = pdf.indexOf(endMarker, end + endMarker.length)
      }
    }

    if (end === -1) break

    if (inflated !== null && (inflated.includes('Tj') || inflated.includes('TJ'))) {
      out.push(inflated)
    }
    cursor = end + endMarker.length
  }
  return out
}
