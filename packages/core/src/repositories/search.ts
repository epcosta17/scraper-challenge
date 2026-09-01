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
const SEARCH_SQL = `
WITH doc_match AS (
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

/**
 * Full-text search across case metadata, party names and document text,
 * ranked by BM25 and returned one row per case, with a highlighted fragment
 * of the document that matched.
 *
 * Throws `SearchQueryError` for a query with nothing searchable in it —
 * rather than the alternative, which is quietly answering "every case in the
 * acervo" to an empty search box.
 */
export function searchCases(db: Db, query: string, opts: SearchOptions = {}): SearchResults {
  const ftsQuery = toFtsQuery(query)
  const limit = opts.limit ?? DEFAULT_LIMIT
  const offset = opts.offset ?? 0

  const rows = db.prepare(SEARCH_SQL).all({
    q: ftsQuery,
    limit,
    offset,
    hlStart: opts.highlightStart ?? '[',
    hlEnd: opts.highlightEnd ?? ']',
    ellipsis: ELLIPSIS,
    snippetTokens: SNIPPET_TOKENS,
  }) as HitRow[]

  return {
    query,
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
