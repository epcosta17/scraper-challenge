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

export function parseCaseRecord(pdf: Buffer): CaseRecord {
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new NotAPdfError()

  const text = reconstructText(extractTextStreams(pdf))

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
