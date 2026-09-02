import type { MovementInput } from '@pje/core'
import { extractTextStreams } from './streams.ts'

export { extractTextStreams }

export interface CaseRecord {
  number: string
  className: string
  classCode: string | null
  court: string | null
  panel: string | null
  distributedAt: string | null
  subjects: string[]
}

export class NotAPdfError extends Error {
  constructor() {
    super('Buffer is not a PDF (missing %PDF- magic)')
    this.name = 'NotAPdfError'
  }
}

/** Decodes a single `(...)` PDF string literal (without its enclosing parens). */
function decodeLiteral(raw: string): string {
  return raw
    // PDF escapes these; leaving them escaped truncates subject codes like "(9582)".
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    // The template uses literal tab escapes as cell separators.
    .replace(/\\t/g, ' ')
    .replace(/\\[rn]/g, ' ')
}

/**
 * Concatenates the `(...)` string literals a PDF uses to draw text.
 *
 * A naive join of every literal glues wrapped lines together with no space
 * (recon found "SALDANHA" + "CAVALCANTE" -> "SALDANHACAVALCANTE"), because
 * the PDF renders a wrapped name as two separate `Tj` calls at two text
 * positions rather than as one literal with an embedded space. To recover
 * the word boundary we scan tokens in stream order and treat any text
 * positioning operator (`Tm`, `Td`, `TD`, `T*`) between two literals as a
 * boundary that inserts a single space.
 */
export function reconstructText(streams: string[]): string {
  const tokenRe = /\((?:[^()\\]|\\.)*\)|\bTm\b|\bTd\b|\bTD\b|T\*/g
  let result = ''
  let boundary = false

  for (const stream of streams) {
    boundary = true // treat the start of each stream as a boundary too
    tokenRe.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = tokenRe.exec(stream))) {
      const token = m[0]
      if (token.startsWith('(')) {
        const decoded = decodeLiteral(token.slice(1, -1))
        if (decoded.length === 0) continue
        if (boundary && result.length > 0) result += ' '
        result += decoded
        boundary = false
      } else {
        boundary = true
      }
    }
  }

  return result.replace(/\s+/g, ' ').trim()
}

// The fixed set of field labels the summary template prints, in document
// order. A generic "capitalized word followed by a colon" heuristic is not
// safe here: a label like "Órgão Julgador:" contains "Julgador:", which on
// its own also looks like a label and falsely truncates the previous field's
// value. Bounding each field by this explicit list avoids that.
const FIELD_LABELS = [
  'Número do Processo',
  'Classe Judicial',
  'Órgão Julgador Colegiado',
  'Órgão Julgador',
  'Data de distribuição',
  'Assunto',
]

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function field(text: string, label: string): string | null {
  // A field's value runs up to the next known label, or "Polo Ativo" (the
  // parties table header), or the end of the text.
  const boundary = [...FIELD_LABELS.map((l) => `${escapeRegExp(l)}:`), 'Polo Ativo'].join('|')
  const re = new RegExp(`${escapeRegExp(label)}:\\s*(.+?)\\s*(?=${boundary}|$)`)
  return re.exec(text)?.[1]?.trim() ?? null
}

/**
 * The whole-document text step `parseCaseRecord` builds on, exported so
 * other callers (`crawl/deep.ts`, for a binary document's `text_content`)
 * can reuse the same extraction — walk every stream, keep the ones with
 * `Tj`/`TJ` operators, reconstruct with word boundaries — rather than
 * duplicating it or reimplementing case-summary-specific field parsing for
 * a document that has none.
 */
export function extractPdfText(pdf: Buffer): string {
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new NotAPdfError()
  return reconstructText(extractTextStreams(pdf))
}

/**
 * True when the portal answered with a real summary that names no case.
 *
 * Captured live (id 134050 among others): the PDF is well formed and carries
 * the judicial class, the full subject list and both poles with their parties
 * by name and role — everything except the number, the judging panel, the
 * distribution date and the movements. It reads as a case that exists and has
 * not been distributed yet, or one whose numbering is withheld.
 *
 * Worth telling apart from a parse failure because the two deserve opposite
 * treatment. A failure is retried; this cannot be. The scraper was recording
 * these as `summary_pdf` failures and retrying them up to seven times each —
 * 57 of them in one acervo — against a page that will answer the same way
 * every time.
 *
 * Recognised by what is present rather than by what is missing: any PDF can
 * lack a case number, but only the portal's own summary carries this heading
 * and a populated Polo Ativo under it.
 */
export function isUnnumberedSummary(pdf: Buffer): boolean {
  let text: string
  try {
    text = extractPdfText(pdf)
  } catch {
    return false
  }
  if (/(\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4})/.test(text)) return false
  return text.includes('Detalhe do Processo')
    && text.includes('Classe Judicial')
    && text.includes('Polo Ativo')
}

export function parseCaseRecord(pdf: Buffer): CaseRecord {
  const text = extractPdfText(pdf)

  const number = /(\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4})/.exec(text)?.[1]
  if (!number) throw new Error('Could not locate a case number in the PDF text')

  const classRaw = field(text, 'Classe Judicial') ?? ''
  const classMatch = /^(.*?)\s*\((\d+)\)\s*$/.exec(classRaw)

  const subjectRaw = field(text, 'Assunto') ?? ''
  const subjects = subjectRaw
    .split(/\s+-\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  return {
    number,
    className: (classMatch?.[1] ?? classRaw).trim(),
    classCode: classMatch?.[2] ?? null,
    court: field(text, 'Órgão Julgador'),
    panel: field(text, 'Órgão Julgador Colegiado'),
    distributedAt: field(text, 'Data de distribuição'),
    subjects,
  }
}

// The section header the template prints right before the "Data de
// atualização | Movimento" column headings and the entries themselves.
const MOVEMENT_SECTION_HEADER = 'Movimentação do Processo'

// Two boilerplate fragments the template reprints once per PDF page the log
// spans: the column heading itself (whenever a new page starts a fresh
// table — see case 0800245-51.2020.4.05.8002, a 3-page report), and, when
// the PDF was generated after being viewed once already, a
// "Visualizado/Impresso em:<timestamp>" stamp whose own timestamp would
// otherwise be misread as an extra, bogus movement (found live: without
// stripping it first, this case's log parsed to 40 entries instead of the
// true 39 the detail page's own count agrees with). Either fragment may be
// preceded by a bare page-number run the reconstructed text has no other
// delimiter for; swallowing it here is the only way to keep it out of the
// *previous* entry's description.
const VIEWED_STAMP_RE = /\d{0,4}\s*Visualizado\/Impresso em:\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}/g
const COLUMN_HEADER_RE = /\d{0,4}\s*Data de atualização Movimento/g

// Found live (case 0024885-29.2005.4.05.0000, idProcessoTrf 28907, a
// 157-movement log): a real movement's own description can embed a SECOND
// timestamp of its own, in the exact same `DD/MM/YYYY HH:MM:SS` shape as an
// entry's leading one — "Disponibilizado no DJ Eletrônico em
// 05/03/2020 03:12:14" and "Publicado Decisão em 07/05/2015 03:13:22." are
// real entries, and both self-report the very timestamp they publish at.
// Splitting on every such match therefore misread each one as *two*
// entries: the real one, truncated, plus a bogus second "entry" for the
// embedded timestamp whose slice up to the next real entry was empty or
// punctuation-only ("", "."). Naively dropping empty-description output
// rows would have hidden the symptom without fixing the cause (and could
// still occasionally swallow a real, if terse, movement); excluding a
// timestamp preceded by "em " from ever being read as an entry boundary in
// the first place is the actual fix — confirmed against this case: 166
// naive matches, 157 once "em "-preceded ones are excluded, exactly
// matching the detail page's own stated total.
const MOVEMENT_TIMESTAMP_RE = /(?<!em )\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}/g

/**
 * Parses the procedural log from the case's own summary PDF — deliberately
 * NOT from the case detail HTML page, even though that page also renders a
 * "Movimentações do Processo" table.
 *
 * Found live: that HTML table renders only its first page — case
 * 0800245-51.2020.4.05.8002 shows 15 rows of a stated 39. It can be paged
 * (via a `rich:inputNumberSlider`; see `pje/detail.ts`'s
 * `parseMovementsTotal` for the mechanism), but the PDF prints the whole
 * log in one shot, costs no extra request since every case downloads it
 * regardless, and so makes the log available from `crawl` across the entire
 * corpus. Paging the HTML would cost extra POSTs per case and work only in
 * `deep`. Do not "fix" this back to the richer-looking HTML table: reading
 * only its first page silently drops most of a long case's history, and
 * paging it properly trades corpus-wide coverage for extra requests.
 *
 * Every entry in the reconstructed text is a bare
 * `<timestamp> <description>` pair with no other delimiter between them
 * (there is no literal " - " here, unlike the HTML's row text), so entries
 * are split purely on where a timestamp-shaped run of text occurs, after
 * stripping the two known boilerplate fragments (see the regexes above)
 * that would otherwise be misread as extra entries or bleed into a real
 * one's description.
 */
export function parseMovements(pdf: Buffer): MovementInput[] {
  const text = extractPdfText(pdf)
  const headerIdx = text.indexOf(MOVEMENT_SECTION_HEADER)
  if (headerIdx === -1) return []

  const section = text
    .slice(headerIdx + MOVEMENT_SECTION_HEADER.length)
    .replace(VIEWED_STAMP_RE, ' ')
    .replace(COLUMN_HEADER_RE, ' ')

  const matches = [...section.matchAll(MOVEMENT_TIMESTAMP_RE)]
  return matches.map((m, i) => {
    const start = m.index + m[0].length
    const end = i + 1 < matches.length ? matches[i + 1]!.index : section.length
    return { position: i, timestamp: m[0], description: section.slice(start, end).replace(/\s+/g, ' ').trim() }
  })
}
