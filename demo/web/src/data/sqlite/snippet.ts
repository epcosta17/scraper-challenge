import type { SnippetSegment } from '../types.ts'

/**
 * FTS5's `snippet()` marks the matched terms by wrapping them in two strings
 * of our choosing. Those markers have to survive back to the template without
 * ever becoming markup: the fragment is court text, and injecting it as HTML
 * to get a `<mark>` would hand any document in the acervo an XSS.
 *
 * So the markers are two control characters — which cannot appear in extracted
 * PDF text, and could not be mistaken for content if they did — and the
 * fragment reaches the page already cut into segments, each of which the
 * template renders as ordinary escaped text.
 */
export const HIGHLIGHT_START = '\u0001'
export const HIGHLIGHT_END = '\u0002'

export function toSegments(
  text: string,
  start: string = HIGHLIGHT_START,
  end: string = HIGHLIGHT_END,
): SnippetSegment[] {
  const out: SnippetSegment[] = []
  let rest = text
  for (;;) {
    const open = rest.indexOf(start)
    if (open === -1) break
    const close = rest.indexOf(end, open + start.length)
    if (close === -1) break
    if (open > 0) out.push({ text: rest.slice(0, open), hit: false })
    out.push({ text: rest.slice(open + start.length, close), hit: true })
    rest = rest.slice(close + end.length)
  }
  if (rest.length > 0) out.push({ text: rest, hit: false })
  // A fragment with no match in it at all is still a fragment worth showing.
  return out.length > 0 ? out : [{ text, hit: false }]
}
