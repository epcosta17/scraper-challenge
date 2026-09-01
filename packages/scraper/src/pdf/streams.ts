import { inflateSync } from 'node:zlib'

// Cap on how many `endstream` candidates we retry per stream. A false
// `endstream` match inside a compressed body is rare, and more than one
// inside a single body vanishingly so, so a handful of retries is ample to
// recover from that case. The cap exists for the OTHER case: a genuinely
// non-inflatable stream (an image or font using a non-Flate filter such as
// DCTDecode or CCITTFaxDecode) fails against every candidate, and without a
// bound the retry would walk `endstream` occurrences belonging to later,
// unrelated streams all the way to the end of the file.
const MAX_ENDSTREAM_CANDIDATES = 8

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
    //
    // The retry is bounded (MAX_ENDSTREAM_CANDIDATES) and never gives up on
    // the OUTER loop: a stream that fails to inflate against every candidate
    // (a genuinely non-Flate stream, not a false match) must not prevent
    // later streams in the file from being found. In that case we fall back
    // to the FIRST `endstream` candidate as the stream's boundary and move
    // the cursor past it, so the outer loop always advances strictly and
    // resumes scanning right after this stream.
    const firstEnd = pdf.indexOf(endMarker, dataStart)
    let end = firstEnd
    let inflated: string | null = null
    let chosenEnd = -1
    let candidates = 0
    while (end !== -1 && candidates < MAX_ENDSTREAM_CANDIDATES) {
      candidates++
      let dataEnd = end
      if (pdf[dataEnd - 1] === 0x0a) dataEnd--
      if (pdf[dataEnd - 1] === 0x0d) dataEnd--

      const raw = pdf.subarray(dataStart, dataEnd)
      try {
        inflated = inflateSync(raw).toString('latin1')
        chosenEnd = end
        break
      } catch {
        // Either a non-inflatable stream (font, image) or a false
        // "endstream" match inside the real body. Try the next occurrence.
        end = pdf.indexOf(endMarker, end + endMarker.length)
      }
    }

    if (firstEnd === -1) break

    if (chosenEnd === -1) {
      // No candidate inflated (genuinely non-Flate stream, or the bounded
      // retry ran out). Skip this stream without derailing extraction of
      // the rest of the file: advance past the first `endstream` candidate.
      cursor = firstEnd + endMarker.length
      continue
    }

    if (inflated !== null && (inflated.includes('Tj') || inflated.includes('TJ'))) {
      out.push(inflated)
    }
    cursor = chosenEnd + endMarker.length
  }
  return out
}
