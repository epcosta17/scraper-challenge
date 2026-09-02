import type { Db } from '../db.ts'

export class SearchQueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SearchQueryError'
  }
}

/** Which index a case turned up in. A hit can come from more than one. */
export type SearchSource = 'case' | 'party' | 'document'

export interface SearchSnippet {
  idProcessoDocumento: number
  label: string
  /** A fragment of the document, with the matching terms wrapped in markers. */
  text: string
}

export interface SearchHit {
  idProcessoTrf: number
  number: string
  className: string
  court: string | null
  distributedAt: string | null
  /** Higher is better. See `combineScores` for what the number means. */
  score: number
  matchedIn: SearchSource[]
  /** The best-matching document, when the case matched through one. */
  snippet: SearchSnippet | null
}

export interface SearchOptions {
  limit?: number
  offset?: number
  highlightStart?: string
  highlightEnd?: string
}

export interface SearchResults {
  /** The query exactly as it was given. */
  query: string
  /** What it was translated to before reaching FTS5 — useful when debugging a surprising result. */
  ftsQuery: string
  /** Matching cases in total, not just on this page. */
  total: number
  limit: number
  offset: number
  hits: SearchHit[]
}

const DEFAULT_LIMIT = 20
const SNIPPET_TOKENS = 20
const ELLIPSIS = '…'

const OPERATORS = new Set(['AND', 'OR', 'NOT'])

/** `"` is the only character with meaning inside an FTS5 string; doubling escapes it. */
const quote = (s: string): string => `"${s.replaceAll('"', '""')}"`

/**
 * Translates what a person typed into an FTS5 MATCH expression.
 *
 * Raw user input cannot go to FTS5 directly. Half the things a user of this
 * particular corpus will paste are FTS5 syntax errors or, worse, silently
 * mean something else: a case number ("0013475-36.2026.4.05.0000") and an
 * OAB registration contain characters FTS5 reads as structure, `:` is a
 * column filter, `^` anchors, `(`/`)` group, and an odd number of `"` ends
 * the expression mid-air. A syntax error surfacing from SQLite as
 * "fts5: syntax error near ..." is not an answer anybody wants for a pasted
 * case number.
 *
 * So every bare term is wrapped in quotes, which in FTS5 makes it a literal
 * string — the tokenizer still splits it, so a quoted case number becomes an
 * ordered phrase of its digit groups and matches the stored number, while
 * every metacharacter inside it is inert.
 *
 * What survives from the user's own syntax, because it is genuinely useful
 * and unambiguous: an explicit `"phrase"`, a trailing `*` for a prefix
 * search, and the uppercase operators AND/OR/NOT. Terms with no operator
 * between them are ANDed, which is FTS5's own default.
 */
export function toFtsQuery(raw: string): string {
  const parts: string[] = []
  // Either a "quoted phrase" or a run of non-space characters.
  const scanner = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = scanner.exec(raw)) !== null) {
    const phrase = m[1]
    if (phrase !== undefined) {
      if (phrase.trim() !== '') parts.push(quote(phrase.trim()))
      continue
    }
    const word = m[2]!
    if (OPERATORS.has(word)) { parts.push(word); continue }
    const isPrefix = word.endsWith('*')
    const bare = isPrefix ? word.slice(0, -1) : word
    // A term of pure punctuation produces no tokens at all; passing it on
    // would make FTS5 match everything or nothing depending on position.
    if (!hasToken(bare)) continue
    parts.push(quote(bare) + (isPrefix ? '*' : ''))
  }

  const normalised = dropDanglingOperators(parts)
  if (normalised.length === 0) {
    throw new SearchQueryError(
      `Query ${JSON.stringify(raw)} has no searchable terms in it.`,
    )
  }
  return normalised.join(' ')
}

/**
 * True if the string contains at least one character the tokenizer would
 * keep. `unicode61` splits on everything that is not a letter, a digit or an
 * underscore, so "- . -" and "***" index nothing and must not be sent on as
 * terms.
 */
function hasToken(s: string): boolean {
  return /[\p{L}\p{N}_]/u.test(s)
}

/**
 * Removes operators that would make the expression a syntax error: a leading
 * or trailing one, and all but the last of a run. `sentença OR` is a typo,
 * not a reason to hand SQLite an unparseable string.
 */
function dropDanglingOperators(parts: readonly string[]): string[] {
  const out: string[] = []
  for (const part of parts) {
    if (!OPERATORS.has(part)) { out.push(part); continue }
    if (out.length === 0) continue // leading operator
    if (OPERATORS.has(out[out.length - 1]!)) out.pop() // run of operators: keep the last
    out.push(part)
  }
  while (out.length > 0 && OPERATORS.has(out[out.length - 1]!)) out.pop()
  return out
}

/**
 * One statement, so that ranking, the snippet and the total count all come
 * from the same matched set.
 *
 * Each index is matched separately and the results are folded back together
 * on `id_processo_trf`, because that is the unit a person searches for: one
 * row per case, however many of its documents matched.
 *
 * `bm25()` returns a *smaller* (more negative) number for a better match, so
 * every score is negated on the way out and the ordering is plain DESC.
 * Column weights are the arguments after the table name, in declaration
 * order.
 */
const FTS_CTES = `
doc_match AS (
  SELECT
    d.id_processo_trf                       AS case_id,
    d.id_processo_documento                 AS document_id,
    d.label                                 AS document_label,
    -- label is weighted above the body: "Sentença" as a document's *title*
    -- is a far stronger signal than the same word buried in its text.
    -bm25(documents_fts, 3.0, 1.0)          AS score,
    snippet(documents_fts, 1, @hlStart, @hlEnd, @ellipsis, @snippetTokens) AS snippet
  FROM documents_fts
  JOIN documents d ON d.id_processo_documento = documents_fts.rowid
  WHERE documents_fts MATCH @q
),
-- Only the best-scoring document per case reaches the result: a case with
-- forty matching documents is still one hit, shown through its strongest one.
best_doc AS (
  SELECT case_id, document_id, document_label, score, snippet
  FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY case_id ORDER BY score DESC, document_id) AS rn
    FROM doc_match
  )
  WHERE rn = 1
),
case_match AS (
  SELECT
    cases_fts.rowid AS case_id,
    -- The case number is weighted far above everything else: someone who
    -- pastes a case number wants that case first, not every case whose
    -- documents happen to cite it. parties_json outranks the remaining
    -- metadata because a name is a deliberate search, a panel name rarely is.
    -bm25(cases_fts, 12.0, 2.0, 1.0, 1.0, 1.5, 3.0) AS score
  FROM cases_fts
  WHERE cases_fts MATCH @q
),
-- Split in two: an FTS5 auxiliary function like bm25() may not appear
-- inside an aggregate, so the per-party scores are computed first and only
-- then reduced to the best one per case. MATERIALIZED is load-bearing, not
-- decoration: without it SQLite flattens this CTE straight into the MAX()
-- below and the query fails with the very error the split exists to avoid.
party_hit AS MATERIALIZED (
  SELECT p.id_processo_trf AS case_id, -bm25(parties_fts, 3.0, 1.0, 1.0) AS score
  FROM parties_fts
  JOIN parties p ON p.id = parties_fts.rowid
  WHERE parties_fts MATCH @q
),
party_match AS (
  SELECT case_id, MAX(score) AS score FROM party_hit GROUP BY case_id
),
matched AS (
  SELECT case_id FROM best_doc
  UNION
  SELECT case_id FROM case_match
  UNION
  SELECT case_id FROM party_match
)
`

/**
 * The same five names, for a search with no text in it at all.
 *
 * A filtered search still has to answer with the shape a ranked one does —
 * the result columns, the snippet, the three `matched_*` flags — so rather
 * than a second SELECT kept in step with the first by hand, the four
 * text-derived CTEs are declared empty (`WHERE 0`: no row, but the column
 * names exist) and `matched` becomes every case. Every hit then reports a
 * score of 0 and an empty `matchedIn`, which is the truth: nothing about it
 * was matched through the text index.
 */
const EMPTY_CTES = `
best_doc AS (
  SELECT NULL AS case_id, NULL AS document_id, NULL AS document_label,
         0 AS score, NULL AS snippet
  WHERE 0
),
case_match AS (SELECT NULL AS case_id, 0 AS score WHERE 0),
party_match AS (SELECT NULL AS case_id, 0 AS score WHERE 0),
matched AS (SELECT id_processo_trf AS case_id FROM cases)
`

const RESULT_SELECT = `
SELECT
  c.id_processo_trf,
  c.number,
  c.class_name,
  c.court,
  c.distributed_at,
  bd.document_id,
  bd.document_label,
  bd.snippet,
  bd.case_id IS NOT NULL AS matched_document,
  cm.case_id IS NOT NULL AS matched_case,
  pm.case_id IS NOT NULL AS matched_party,
  -- Summed rather than maxed, so a case that matches in its metadata *and*
  -- its documents outranks one that only matches in one of them. The three
  -- bm25 scales are not calibrated against each other (a long PDF and a
  -- one-line party name cannot be), so this is a deliberate heuristic, not a
  -- probability: it orders sensibly within a source and rewards breadth
  -- across sources.
  COALESCE(bd.score, 0) + COALESCE(cm.score, 0) + COALESCE(pm.score, 0) AS score,
  COUNT(*) OVER () AS total
FROM matched
JOIN cases c ON c.id_processo_trf = matched.case_id
LEFT JOIN best_doc bd ON bd.case_id = matched.case_id
LEFT JOIN case_match cm ON cm.case_id = matched.case_id
LEFT JOIN party_match pm ON pm.case_id = matched.case_id
{{WHERE}}
-- id as the tie-break so paging is stable: without it two cases on the same
-- score could swap places between two pages and one of them would never be
-- seen.
ORDER BY score DESC, c.id_processo_trf
LIMIT @limit OFFSET @offset
`

interface HitRow {
  id_processo_trf: number
  number: string
  class_name: string | null
  court: string | null
  distributed_at: string | null
  document_id: number | null
  document_label: string | null
  snippet: string | null
  matched_document: number
  matched_case: number
  matched_party: number
  score: number
  total: number
}

// ── The portal's own eight criteria, asked of the acervo ────────────────────

/** What was wrong with a filter, as something other than a sentence. */
export type SearchFilterProblem =
  | 'date-format'
  | 'date-not-real'
  | 'range-inverted'
  | 'oab-state-without-number'

/**
 * A filter refused before it reached SQLite: a date that is not a date, an
 * OAB state with no number under it. Separate from `SearchQueryError`, which
 * is about the *text* box having nothing searchable in it, because the two
 * need different words on screen.
 *
 * `problem` and `field` are the reason this is not just a message. The
 * message is in English, like the rest of this package; the interface that
 * shows it is in Spanish and points at the offending input. Matching on the
 * wording to work out which is which would break the first time a sentence
 * is reworded, so the classification travels with the error instead.
 */
export class SearchFilterError extends Error {
  readonly problem: SearchFilterProblem
  /** The criterion at fault, named as `AcervoFilters` names it. */
  readonly field: 'from' | 'to' | 'oabState'
  /** What the caller actually gave, for an interface that wants to quote it. */
  readonly value: string

  constructor(problem: SearchFilterProblem, field: 'from' | 'to' | 'oabState', value: string, message: string) {
    super(message)
    this.name = 'SearchFilterError'
    this.problem = problem
    this.field = field
    this.value = value
  }
}

/**
 * The criteria of the TRF5's public search form, named exactly as the CLI
 * names them (`--number`, `--from`, `--class`, …) so that one word means one
 * thing across the scraper, the repositories and the web form.
 *
 * The portal answers these against its own live database; this answers them
 * against what the crawl brought back. Every one of them is a column we
 * actually store — see `SCHEMA`: the case's number, class and distribution
 * date, and, for the four that are about people, the `parties` rows, where a
 * lawyer is a participant whose `role` is `ADVOGADO` and whose `oab` is the
 * state and the registration number run together (`PE63982`).
 */
export interface AcervoFilters {
  /** CNJ number, matched exactly — the portal accepts no partials either. */
  number?: string
  /** Distribution date, `dd/mm/yyyy`, start of the range. */
  from?: string
  /** Distribution date, `dd/mm/yyyy`, end of the range. */
  to?: string
  /** Judicial class, matched as a substring, case- and accent-insensitively. */
  class?: string
  /**
   * Judging panel, matched the same way. Not one of the portal's own eight —
   * its form has no such field — but the acervo stores it and it is the
   * question a person skimming a list of captured cases actually asks.
   */
  organ?: string
  /** Name of a participant who is not a lawyer. */
  party?: string
  /** Name of a participant whose role is `ADVOGADO`. */
  lawyer?: string
  /** A CPF or a CNPJ; the punctuation is ignored on both sides. */
  document?: string
  documentType?: 'cpf' | 'cnpj'
  /** OAB registration number, with or without its state prefix. */
  oab?: string
  /** OAB state. Refused without `oab`, which is what the portal silently ignores. */
  oabState?: string
  /** The reference case number, which is not always the case's own. */
  reference?: string
}

export interface AcervoQuery {
  /** Free text, run through FTS5 exactly as `searchCases` runs it. */
  text?: string
  filters?: AcervoFilters
}

/**
 * The accents `lower()` cannot fold.
 *
 * SQLite's built-in `lower()` is ASCII-only — `lower('Ç')` is `'Ç'` — and it
 * has no notion of a diacritic at all, so a `LIKE` over court data would make
 * "APELAÇÃO" unreachable from "apelacao", which is how anybody actually types
 * it. The FTS5 indexes solve this with `remove_diacritics 2`, but these
 * filters are substring matches, not token matches, and cannot go through
 * FTS5. So the same folding is done here, in SQL, over the short list of
 * characters Portuguese court prose and Brazilian names really use.
 *
 * The last six entries are the combining marks: PDF text extraction produces
 * decomposed spellings as well as precomposed ones (`c` + U+0327 for `ç`),
 * and a fold that only knew the precomposed forms would silently miss them.
 */
const ACCENTED = 'áàâãäéèêëíìîïóòôõöúùûüçñ'
const PLAIN = 'aaaaaeeeeiiiiooooouuuucn'

const FOLD_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ...[...ACCENTED].map((ch, i) => [ch, PLAIN[i]!] as const),
  ...[...ACCENTED.toUpperCase()].map((ch, i) => [ch, PLAIN[i]!] as const),
  // Combining grave, acute, circumflex, tilde, diaeresis and cedilla.
  ...['\u0300', '\u0301', '\u0302', '\u0303', '\u0308', '\u0327'].map((ch) => [ch, ''] as const),
]

/** The SQL side of the fold: `foldSql('c.class_name')` folds the column. */
function foldSql(expr: string): string {
  let sql = expr
  for (const [from, to] of FOLD_PAIRS) sql = `replace(${sql}, '${from}', '${to}')`
  // `lower()` last, for the ASCII the table above deliberately leaves alone.
  return `lower(${sql})`
}

/** The TypeScript side of it, character for character, so both agree. */
function foldValue(raw: string): string {
  let value = raw.normalize('NFC')
  for (const [from, to] of FOLD_PAIRS) value = value.replaceAll(from, to)
  return value.toLowerCase()
}

/** Everything `LIKE` would otherwise read as a pattern. */
const escapeLike = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')

const digitsOf = (value: string): string => value.replace(/\D+/g, '')

/** Strips the punctuation a stored CPF/CNPJ carries, so both sides compare as digits. */
const DIGITS_SQL = (expr: string): string =>
  `replace(replace(replace(replace(${expr}, '.', ''), '-', ''), '/', ''), ' ', '')`

const MONTHS_PT = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
]

/**
 * `cases.distributed_at` as a sortable `YYYY-MM-DD`, or NULL.
 *
 * The column holds the date *as the tribunal printed it* — the case PDF says
 * `22 de Agosto de 2026`, some pages say `03/09/2026` — and nothing
 * normalises it on the way in, deliberately: a date the court printed is
 * data, not a moment we get to recompute. A range filter still has to compare
 * them, so the conversion happens here, at read time, and anything this does
 * not recognise becomes NULL and therefore falls outside every range rather
 * than landing inside one by accident.
 */
const DISTRIBUTED_ISO = ((): string => {
  const at = `trim(c.distributed_at)`
  const rest = `substr(${at}, instr(${at}, ' de ') + 4)`
  const monthWord = `substr(${rest}, 1, instr(${rest}, ' de ') - 1)`
  const month = `CASE ${foldSql(monthWord)}\n    ` +
    MONTHS_PT.map((name, i) =>
      `WHEN '${foldValue(name)}' THEN '${String(i + 1).padStart(2, '0')}'`).join('\n    ') +
    `\n    ELSE NULL END`
  const day = `substr('0' || substr(${at}, 1, instr(${at}, ' ') - 1), -2)`

  return `CASE
  WHEN c.distributed_at IS NULL OR ${at} = '' THEN NULL
  -- Already numeric: dd/mm/yyyy, possibly with a clock after it.
  WHEN ${at} GLOB '[0-9][0-9]/[0-9][0-9]/[0-9][0-9][0-9][0-9]*'
    THEN substr(${at}, 7, 4) || '-' || substr(${at}, 4, 2) || '-' || substr(${at}, 1, 2)
  WHEN ${at} LIKE '% de % de %'
    THEN substr(${at}, -4) || '-' || (${month}) || '-' || ${day}
  ELSE NULL
END`
})()

const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/

/** `17/08/2026` → `2026-08-17`; anything else is refused by name. */
function toIsoDate(raw: string, field: 'from' | 'to'): string {
  const m = DATE_RE.exec(raw)
  if (m === null) {
    throw new SearchFilterError('date-format', field, raw, `${field} must be dd/mm/yyyy, got "${raw}".`)
  }
  const [, day, month, year] = m as unknown as [string, string, string, string]
  const iso = `${year}-${month}-${day}`
  // Round-tripped through Date so that 31/13/2026 and 31/02/2026 are refused
  // rather than compared as strings that no row can ever equal.
  const parsed = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new SearchFilterError('date-not-real', field, raw, `${field} is not a real date: "${raw}".`)
  }
  return iso
}

const trimmed = (value: string | undefined): string | null => {
  const t = (value ?? '').trim()
  return t === '' ? null : t
}

interface FilterSql {
  clauses: string[]
  params: Record<string, string>
}

/**
 * One WHERE clause per criterion given, ANDed — the portal's own semantics,
 * where every field you fill narrows the result further.
 *
 * The four criteria about people are `IN (SELECT …)` over `parties` rather
 * than joins: a case with three matching parties must stay one hit, and a
 * semi-join says that without a DISTINCT to undo the duplication afterwards.
 */
function buildFilters(f: AcervoFilters): FilterSql {
  const clauses: string[] = []
  const params: Record<string, string> = {}

  const number = trimmed(f.number)
  if (number !== null) {
    clauses.push('c.number = @fNumber')
    params.fNumber = number
  }

  const reference = trimmed(f.reference)
  if (reference !== null) {
    clauses.push('c.reference_number = @fReference')
    params.fReference = reference
  }

  const className = trimmed(f.class)
  if (className !== null) {
    clauses.push(`${foldSql('c.class_name')} LIKE @fClass ESCAPE '\\'`)
    params.fClass = `%${escapeLike(foldValue(className))}%`
  }

  const organ = trimmed(f.organ)
  if (organ !== null) {
    clauses.push(`${foldSql('c.court')} LIKE @fOrgan ESCAPE '\\'`)
    params.fOrgan = `%${escapeLike(foldValue(organ))}%`
  }

  const party = trimmed(f.party)
  if (party !== null) {
    clauses.push(`c.id_processo_trf IN (
    SELECT p.id_processo_trf FROM parties p
    WHERE (p.role IS NULL OR upper(p.role) <> 'ADVOGADO')
      AND ${foldSql('p.name')} LIKE @fParty ESCAPE '\\'
  )`)
    params.fParty = `%${escapeLike(foldValue(party))}%`
  }

  const lawyer = trimmed(f.lawyer)
  if (lawyer !== null) {
    clauses.push(`c.id_processo_trf IN (
    SELECT p.id_processo_trf FROM parties p
    WHERE upper(p.role) = 'ADVOGADO'
      AND ${foldSql('p.name')} LIKE @fLawyer ESCAPE '\\'
  )`)
    params.fLawyer = `%${escapeLike(foldValue(lawyer))}%`
  }

  const document = trimmed(f.document)
  if (document !== null) {
    const typeClause = f.documentType === undefined ? '' : ' AND p.document_type = @fDocumentType'
    clauses.push(`c.id_processo_trf IN (
    SELECT p.id_processo_trf FROM parties p
    WHERE p.document_number IS NOT NULL AND p.document_number <> ''
      AND ${DIGITS_SQL('p.document_number')} = @fDocument${typeClause}
  )`)
    params.fDocument = digitsOf(document)
    if (f.documentType !== undefined) params.fDocumentType = f.documentType
  }

  const oab = trimmed(f.oab)
  const oabState = trimmed(f.oabState)
  if (oabState !== null && oab === null) {
    throw new SearchFilterError(
      'oab-state-without-number', 'oabState', oabState,
      'An OAB state has no effect without an OAB number; the portal ignores it silently.',
    )
  }
  if (oab !== null) {
    // Stored as the state and the number run together, with no separator:
    // `PE63982`. So a number on its own is a suffix match, and a number with
    // a state is the whole string.
    const registration = oab.replace(/[^0-9A-Za-z]+/g, '').toUpperCase()
    const stored = `upper(replace(p.oab, ' ', ''))`
    const where = oabState === null
      ? `${stored} LIKE @fOab ESCAPE '\\'`
      : `${stored} = @fOab`
    params.fOab = oabState === null
      ? `%${escapeLike(registration)}`
      : `${oabState.replace(/[^A-Za-z]+/g, '').toUpperCase()}${digitsOf(registration)}`
    clauses.push(`c.id_processo_trf IN (
    SELECT p.id_processo_trf FROM parties p
    WHERE p.oab IS NOT NULL AND p.oab <> '' AND ${where}
  )`)
  }

  const from = trimmed(f.from)
  const to = trimmed(f.to)
  const fromIso = from === null ? null : toIsoDate(from, 'from')
  const toIso = to === null ? null : toIsoDate(to, 'to')
  if (fromIso !== null && toIso !== null && fromIso > toIso) {
    throw new SearchFilterError(
      // Both are non-null here: `toIso` only exists when `to` did.
      'range-inverted', 'to', to!,
      `The date range ends before it starts: ${from} → ${to}.`,
    )
  }
  if (fromIso !== null) {
    clauses.push(`(${DISTRIBUTED_ISO}) >= @fFrom`)
    params.fFrom = fromIso
  }
  if (toIso !== null) {
    clauses.push(`(${DISTRIBUTED_ISO}) <= @fTo`)
    params.fTo = toIso
  }

  return { clauses, params }
}

/**
 * The portal's form and the full-text index, in one statement.
 *
 * The text goes to FTS5 as it always did, ranked and snippeted; the filters
 * become a WHERE over the matched set. Because they are one query, the count
 * and the ranking describe the same rows — a filter applied after the fact,
 * in TypeScript, would leave `total` counting cases the caller never sees.
 *
 * With no text at all the same statement runs over every case, so a purely
 * filtered search is not a different code path: it is this one with the four
 * text CTEs empty.
 *
 * Throws `SearchQueryError` when there is nothing to search by — no text and
 * no filter — rather than quietly answering "the whole acervo", and
 * `SearchFilterError` for a filter that cannot mean anything.
 */
export function searchAcervo(db: Db, query: AcervoQuery, opts: SearchOptions = {}): SearchResults {
  const text = (query.text ?? '').trim()
  // Filters are validated first: an OAB state on its own is a mistake worth
  // naming, and reporting "nothing to search by" instead would hide it.
  const filters = buildFilters(query.filters ?? {})

  if (text === '' && filters.clauses.length === 0) {
    throw new SearchQueryError(
      'A search with neither a query nor a filter would answer with the whole acervo.',
    )
  }

  const limit = opts.limit ?? DEFAULT_LIMIT
  const offset = opts.offset ?? 0
  const ftsQuery = text === '' ? '' : toFtsQuery(text)

  const where = filters.clauses.length === 0
    ? ''
    : `WHERE ${filters.clauses.join('\n  AND ')}`
  const sql = `WITH ${text === '' ? EMPTY_CTES : FTS_CTES}${RESULT_SELECT.replace('{{WHERE}}', where)}`

  // Named parameters are matched exactly by better-sqlite3, so only the ones
  // the built statement actually mentions may be handed over.
  const params: Record<string, string | number> = { limit, offset, ...filters.params }
  if (text !== '') {
    params.q = ftsQuery
    params.hlStart = opts.highlightStart ?? '['
    params.hlEnd = opts.highlightEnd ?? ']'
    params.ellipsis = ELLIPSIS
    params.snippetTokens = SNIPPET_TOKENS
  }

  const rows = db.prepare(sql).all(params) as HitRow[]

  return {
    query: text,
    ftsQuery,
    // `COUNT(*) OVER ()` only comes back on rows that exist; an empty page
    // (past the end of the results, say) carries no count with it. Callers
    // paging past the end get 0, which is the only number a page of zero
    // rows can honestly report without a second query.
    total: rows[0]?.total ?? 0,
    limit,
    offset,
    hits: rows.map(toHit),
  }
}

/**
 * Full-text search across case metadata, party names and document text,
 * ranked by BM25 and returned one row per case, with a highlighted fragment
 * of the document that matched.
 *
 * The text-only case of {@link searchAcervo}, and the shape most callers
 * want. Throws `SearchQueryError` for a query with nothing searchable in it —
 * rather than the alternative, which is quietly answering "every case in the
 * acervo" to an empty search box.
 */
export function searchCases(db: Db, query: string, opts: SearchOptions = {}): SearchResults {
  // `toFtsQuery` first, so that a query of pure punctuation is still refused
  // by the message it has always been refused by.
  toFtsQuery(query)
  return { ...searchAcervo(db, { text: query }, opts), query }
}

function toHit(r: HitRow): SearchHit {
  const matchedIn: SearchSource[] = []
  if (r.matched_case) matchedIn.push('case')
  if (r.matched_party) matchedIn.push('party')
  if (r.matched_document) matchedIn.push('document')

  return {
    idProcessoTrf: r.id_processo_trf,
    number: r.number,
    className: r.class_name ?? '',
    court: r.court,
    distributedAt: r.distributed_at,
    score: r.score,
    matchedIn,
    snippet: r.document_id === null ? null : {
      idProcessoDocumento: r.document_id,
      label: r.document_label ?? '',
      text: r.snippet ?? '',
    },
  }
}
