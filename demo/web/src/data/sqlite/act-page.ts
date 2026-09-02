/**
 * Wraps a judicial act's stored text in a page it can be read in.
 *
 * The portal's own styling is not ours to reproduce: the capture keeps the
 * act's text, not its markup. What this fixes is narrower and worth fixing on
 * its own — the same text served as `text/plain` is rendered by the browser in
 * monospace, at whatever colours the viewer's theme dictates, with no measure
 * and no paragraph breaks, which turns a judgment into a wall of terminal
 * output.
 *
 * A stopgap by design. An act that has its PDF is served as the PDF, which is
 * the tribunal's own layout rather than an imitation of it; this is what is
 * left when there is no PDF to serve.
 */

/**
 * The portal's page chrome, which the extractor keeps along with the act.
 *
 * Every act ends with the signature block, the portal's own URL, the document
 * id, a long numeric stamp and then two button labels — "Imprimir" and "Gerar
 * PDF" — because the extractor takes the page's text and those are text on
 * the page. Leaving them in puts a button nobody can press at the foot of a
 * judgment.
 *
 * Cut here rather than at capture because 147 documents already have it
 * stored; the extractor should stop keeping it too, and then this finds
 * nothing to cut. Anchored to the end of the text so a judgment that happens
 * to discuss printing is untouched.
 */
const TRAILING_CHROME = /\n\s*(?:Imprimir|Gerar PDF)\s*(?:\n\s*(?:Imprimir|Gerar PDF)\s*)*$/

const stripChrome = (text: string): string => text.replace(TRAILING_CHROME, '').trimEnd()

/** Everything that would otherwise be read as markup. */
const escapeHtml = (raw: string): string =>
  raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

/**
 * Breaks the run of text into paragraphs.
 *
 * The extractor joins the act's blocks without separators, so the text arrives
 * as one long line and reads as one. Blank lines are the honest split where
 * they exist; where they do not, a numbered clause ("04. De início…") is how
 * these documents are actually structured, and starting a paragraph at each is
 * closer to the original than one unbroken block.
 */
function paragraphs(text: string): string[] {
  const byBlankLine = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  if (byBlankLine.length > 1) return byBlankLine

  const byClause = text
    .replace(/(?<=[.:”"])\s*(?=\d{2}\.\s)/g, '\n\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  return byClause.length > 0 ? byClause : [text.trim()]
}

export function actPage(label: string, caseNumber: string, text: string): string {
  const body = paragraphs(stripChrome(text))
    .map((p) => `<p>${escapeHtml(p).replaceAll('\n', '<br>')}</p>`)
    .join('\n')

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(label)} — ${escapeHtml(caseNumber)}</title>
<style>
  /* Light regardless of the viewer's theme: a court document is read on
     paper, and a judgment in white-on-black reads as a terminal, not a text. */
  :root { color-scheme: light }
  body {
    margin: 0;
    padding: 48px 24px 96px;
    background: #fff;
    color: #111;
    font: 400 16px/1.7 Georgia, 'Times New Roman', serif;
  }
  main { max-width: 68ch; margin: 0 auto }
  header {
    margin-bottom: 32px;
    padding-bottom: 16px;
    border-bottom: 1px solid #ddd;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }
  h1 { margin: 0 0 4px; font-size: 15px; font-weight: 600; letter-spacing: .01em }
  .case { margin: 0; font-size: 12px; color: #666; font-family: ui-monospace, monospace }
  p { margin: 0 0 1.1em; text-align: justify; hyphens: auto }
  /*
    No emphasis anywhere. An earlier version bolded the first paragraph on the
    theory that an act opens with its own title — but these documents often
    arrive as one unbroken block, so "the first paragraph" was the whole
    judgment and the entire page came out bold.
  */
</style>
</head>
<body>
<main>
  <header>
    <h1>${escapeHtml(label)}</h1>
    <p class="case">${escapeHtml(caseNumber)}</p>
  </header>
  ${body}
</main>
</body>
</html>
`
}
