import type { JobType } from '@pje/core'

/**
 * The shapes the pages render. They are deliberately *view* types, not a copy
 * of the storage rows: a number is `Coverage` wherever the portal declares a
 * total we may not have fully read, and the labels the interface shows in
 * Spanish never travel inside the data (court data stays in Portuguese, as it
 * arrives).
 */

/**
 * A count that knows whether it is the whole truth.
 *
 * `captured` is what we hold; `declared` is what the portal said it had, when
 * it said anything at all. They come apart for real reasons — the detail
 * page's Datascroller only ever paints the first ten parties, a document
 * download can 429 out — and the interface must not round the difference away.
 */
export interface Coverage {
  captured: number
  declared: number | null
}

export const isPartial = (c: Coverage): boolean =>
  c.declared !== null && c.captured < c.declared

export const missing = (c: Coverage): number =>
  c.declared === null ? 0 : Math.max(0, c.declared - c.captured)

export interface Movement {
  /** As printed by the portal: `DD/MM/YYYY HH:mm`. */
  timestamp: string | null
  description: string
}

export type Polo = 'ativo' | 'passivo'

export interface Party {
  polo: Polo
  name: string
  documentType: 'cpf' | 'cnpj' | null
  documentNumber: string | null
  oab: string | null
  /** APELANTE, ADVOGADO, APELADO… kept in Portuguese. */
  role: string | null
}

export interface CaseDocument {
  /** `id_processo_documento` — the portal's own id, and the key of `/documentos/:id`. */
  id: number
  label: string
  docDate: string | null
  format: 'PDF' | 'HTML'
  /** Bytes on disk for a PDF; the stored act's own length for an HTML document. */
  sizeBytes: number | null
}

/** One row of the acervo table. */
export interface CaseSummary {
  number: string
  className: string
  organ: string | null
  parties: Coverage
  documents: Coverage
  lastMovement: Movement | null
}

export interface CasePage {
  items: CaseSummary[]
  /** Cases in the acervo, not in this page. */
  total: number
  page: number
  pageSize: number
  pageCount: number
}

/** What the scraper managed to read of a case, against what the portal claims. */
export interface CaptureState {
  documents: Coverage
  movements: Coverage
  parties: Coverage
  lastCaptureAt: string | null
  /** HTTP requests the last capture of this case cost. */
  requestCount: number | null
  /**
   * The still-open `failures` rows filed against this case. A truncated party
   * list or a document that never came down is recorded there, in the
   * scraper's own words, and this is what puts those words on the screen
   * instead of leaving a silent gap between two numbers.
   */
  failures: CaptureFailure[]
}

export interface CaseDetail {
  number: string
  className: string
  classCode: string | null
  organ: string | null
  panel: string | null
  jurisdiction: string | null
  distributedAt: string | null
  referenceNumber: string | null
  parties: Party[]
  movements: Movement[]
  documents: CaseDocument[]
  documentsBytes: number | null
  capture: CaptureState
}

export interface ArchiveStats {
  caseCount: number
  documentCount: number
  /** Share of the id space we have actually read, 0–100. */
  coveragePct: number
  lastSyncLabel: string
}

// ── Is there an acervo at all ───────────────────────────────────────────────

/**
 * Whether there is anything behind the screens, and if not, exactly why.
 *
 * A web app pointed at a database that was never created, or at one no run has
 * filled yet, must say so. Rendering "0 expedientes" for a missing file is the
 * one answer that is indistinguishable from an empty court.
 */
export type ArchiveStatus =
  | { kind: 'ready'; databasePath: string; blobRoot: string }
  | { kind: 'missing'; databasePath: string; blobRoot: string }
  | { kind: 'empty'; databasePath: string; blobRoot: string }
  | { kind: 'unreadable'; databasePath: string; blobRoot: string; error: string }

// ── Full-text search over the acervo ────────────────────────────────────────

/**
 * The portal never answers a query with more than this, and never offers a
 * page 2 — the cut happens in its own server-side query, so no parameter, page
 * or sort order gets past it. Still true, and still the reason this screen
 * searches the captured acervo instead of the portal: the crawl is what buys
 * coverage the public form cannot give.
 */
export const PORTAL_ROW_LIMIT = 30

/**
 * The criteria the search form can carry, named exactly as the CLI names its
 * flags (`--number`, `--from`, `--class`, …) and as `AcervoFilters` names
 * them in `@pje/core`. One word, one meaning, from the command line through
 * the query string to the SQL.
 *
 * Every one of them is a column the acervo really stores. A criterion the
 * schema could not answer would not be here: a control wired to nothing is
 * worse than a control that is missing.
 */
export interface SearchFilters {
  /** CNJ number, matched exactly. */
  number?: string
  /** Distribution date, `dd/mm/yyyy`, start of the range. */
  from?: string
  /** Distribution date, `dd/mm/yyyy`, end of the range. */
  to?: string
  /** Judicial class, matched as a substring, accents and case ignored. */
  class?: string
  /**
   * Judging panel, matched the same way. Not one of the portal's eight — its
   * form has no such field — but the acervo stores it, and a list of captured
   * cases is where somebody narrows by it.
   */
  organ?: string
  /** Name of a participant who is not a lawyer. */
  party?: string
  /** Name of a participant whose role is `ADVOGADO`. */
  lawyer?: string
  document?: string
  documentType?: 'cpf' | 'cnpj'
  oab?: string
  oabState?: string
  reference?: string
}

/** What the form asks: free text, the eight criteria, or both together. */
export interface SearchCriteria {
  text?: string
  filters?: SearchFilters
}

/** A judicial class present in the acervo, for the class control. */
export interface ClassOption {
  name: string
  caseCount: number
}

/** A judging panel present in the acervo, for the organ control. */
export interface OrganOption {
  name: string
  caseCount: number
}

/** A run of snippet text, `hit` on the part the query matched. */
export interface SnippetSegment {
  text: string
  hit: boolean
}

export interface SearchSnippet {
  /** The document the fragment came out of. */
  label: string
  documentId: number
  segments: SnippetSegment[]
}

/** Which index a case turned up in; a hit can come from more than one. */
export type SearchSource = 'case' | 'party' | 'document' | 'movement'

export interface SearchHit {
  number: string
  className: string
  organ: string | null
  distributedAt: string | null
  matchedIn: SearchSource[]
  snippet: SearchSnippet | null
}

export interface SearchResult {
  /** The query exactly as it was typed. */
  query: string
  /**
   * What it was translated to before reaching FTS5 — shown so a surprising
   * result is explainable. Null when nothing was typed into the text box: a
   * search made only of filters never reaches FTS5 at all.
   */
  ftsQuery: string | null
  hits: SearchHit[]
  /** Matching cases in total, not just on this page. */
  total: number
  page: number
  pageSize: number
  pageCount: number
  elapsedMs: number
  /** Why the search could not run at all, in Spanish. */
  error: string | null
  /**
   * Which input `error` is about, so the form can point at it instead of
   * printing a sentence over a page of nine fields. `text` for the query box;
   * otherwise the criterion, named as `SearchFilters` names it.
   */
  errorField: 'text' | 'from' | 'to' | 'oabState' | null
}

// ── Capture processes ───────────────────────────────────────────────────────

/**
 * The job types the queue actually carries — `JobType` in `@pje/core`, not a
 * parallel vocabulary. The screen offers what a worker can be asked for and
 * nothing else.
 */
/**
 * The job types this screen can put on the queue — the worker's own
 * vocabulary, deliberately, so one name means one thing across the CLI, the
 * worker and here.
 *
 * It is a *subset* of core's `JobType`, not a copy: the worker still answers
 * to `discover` and `backfill` for rows enqueued before those collapsed into
 * `crawl` (a crawl with no range and a crawl with one), and the queue below
 * has to be able to show such a row. So what a job *is* is `JobType`, and
 * what this form can *create* is `JobKind`.
 */
export type JobKind = 'crawl' | 'deep_range' | 'deep_case' | 'refresh_case'

/** `pending` is called `queued` here, and only here: it is the word the screen uses. */
export type JobState = 'running' | 'queued' | 'done' | 'failed'

/**
 * One row of the queue.
 *
 * There is deliberately no progress field. The queue records what a job *is*
 * and what has happened to it — how many attempts it has cost, when the
 * current one started, when it ended, why it failed — and nothing yet writes
 * "217 of 300" anywhere, so nothing here pretends to know it.
 */
export interface Job {
  id: number
  kind: JobType
  /** The payload, read back as the words a person typed to enqueue it. */
  target: string
  state: JobState
  attempts: number
  createdAt: string
  /** When the *current* attempt started; null while queued. */
  startedAt: string | null
  /** Set only on a terminal outcome. */
  finishedAt: string | null
  /** Why the last attempt failed; survives into the retry, so it stays visible. */
  error: string | null
  /**
   * How far the *current* attempt has got. `total` is null when the run has
   * no knowable end — a crawl walking the watermark until it runs out of
   * cases — and `totalIsEstimate` marks one the worker may stop short of.
   * `done` describes this attempt only: a requeued job starts again at zero,
   * while a job that failed for good keeps its count, because "gave up after
   * 217 of 300" is the most useful thing that row can still say.
   */
  progress: { done: number; total: number | null; totalIsEstimate: boolean }
  /**
   * What the worker is doing right now, in the engine's own words, or null
   * when the job is not running. Shown beside the count because on a single
   * case the count stays at zero through most of the work — the summary PDF,
   * the search bridge, the case file — and a row that only ever said `0` would
   * be indistinguishable from one that had hung.
   */
  stage: string | null
}

export interface CaptureFailure {
  kind: string
  ref: string
  /** In Spanish where the failure is one the interface can explain; the scraper's own words otherwise. */
  error: string
  /** Always the scraper's own words, so nothing is lost behind the translation. */
  raw: string
  attempts: number
  lastAttemptAt: string
}

export interface CaptureOverview {
  runningJobs: number
  queuedJobs: number
  casesToday: number
  documentsToday: number
  openFailures: number
  updatedAgoLabel: string
  jobs: Job[]
  failures: CaptureFailure[]
}

/** What came back from asking the queue to take a new job. */
export type EnqueueOutcome =
  | { ok: true; job: Job }
  | { ok: false; error: string }

// ── Chat ────────────────────────────────────────────────────────────────────

export interface ChatSource {
  number: string
  className: string
  fragment: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  paragraphs: string[]
  /** Case numbers, abbreviated as the answer cites them. */
  citations: string[]
  /** Cited cases beyond the ones listed in `citations`. */
  extraCitations: number
}

export interface Conversation {
  scope: string
  messages: ChatMessage[]
  sources: ChatSource[]
  sourceCount: number
}

/**
 * The sliver of a captured case that a portal result needs: enough to show
 * what it is, and to prove we hold it. The portal's own response carries
 * neither, so this is the difference between a row that opens a case file and
 * one that can only offer to capture it.
 */
export interface HeldCase {
  className: string
  organ: string | null
}
