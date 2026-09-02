export interface Party {
  name: string
  role: string
}

export interface StoredCase {
  idProcessoTrf: number
  number: string
  ca: string | null
  className: string
  classCode: string | null
  court: string | null
  panel: string | null
  distributedAt: string | null
  subjects: string[]
  parties: Party[]
  summaryPdfKey: string | null
  /** From the detail page's "Dados do Processo" panel — TRF5 for every case observed so far. */
  jurisdiction: string | null
  courtAddress: string | null
  /** "Processo referência", when the case cites a related case number. */
  referenceNumber: string | null
}

export type Polo = 'ativo' | 'passivo'
export type PartyDocumentType = 'cpf' | 'cnpj'

/**
 * One row of the detail page's Polo Ativo/Passivo tables, already split out
 * of the single free-text string the page prints (name, an optional OAB
 * registration, an optional CPF *or* CNPJ, and a procedural role) — see
 * `packages/scraper/src/pje/detail.ts`'s `parseParties` for how.
 */
export interface PartyInput {
  polo: Polo
  name: string
  documentType: PartyDocumentType | null
  documentNumber: string | null
  oab: string | null
  role: string | null
  situation: string | null
}

export interface StoredParty extends PartyInput {
  idProcessoTrf: number
}

/** One row of the "Movimentações do Processo" table, in the page's own order. */
export interface MovementInput {
  /** 0-based position in the page's own ordering — the table has no other stable key. */
  position: number
  timestamp: string | null
  description: string
}

export interface StoredMovement extends MovementInput {
  idProcessoTrf: number
}

// The portal answers a sealed ("segredo de justiça") case and an unassigned
// id with the identical HTTP 200 + error.seam shape (see `fetchReportPdf`),
// so the scraper has no way to distinguish them — every probe is recorded
// as `not_found`. Narrowed to what is actually produced rather than
// declaring statuses ('secret', 'error') the code can never write.
export type ProbeStatus = 'not_found'

export interface Failure {
  id: number
  kind: string
  ref: string
  error: string
  attempts: number
  lastAttemptAt: string
  resolvedAt: string | null
  /**
   * The case this failure belongs to, when it belongs to one. Null for a
   * failure about something else, and on rows written before the column
   * existed. It is what lets a failure be retried rather than only read.
   */
  idProcessoTrf: number | null
}

/**
 * The work a queued job asks for. Open by design — new types are expected,
 * and the `jobs.type` column deliberately carries no CHECK constraint so
 * that adding one here is the only change needed (see `schema.ts`).
 *
 * The four the worker dispatches on, one per engine entry point:
 *
 *   crawl         enumerate an id range, or resume from the watermark
 *   deep_case     fetch one case and every document in its file
 *   deep_range    the same, over an id range
 *   refresh_case  re-read a case that is already stored
 *
 * `discover` and `backfill` predate that split and are kept because rows
 * carrying them may already be queued. Both are a `crawl` under a different
 * name — `discover` is a crawl with no explicit range (it walks on from the
 * watermark until the misses run out), `backfill` a crawl over one — and the
 * worker runs them through the same handler rather than pretending they are
 * distinct work. New enqueuers should say `crawl` and let the payload carry
 * the difference, which is where it actually lives.
 */
export type JobType =
  | 'crawl'
  | 'deep_case'
  | 'deep_range'
  | 'refresh_case'
  | 'discover'
  | 'backfill'

/**
 * A job's lifecycle. `pending -> running` on a claim; `running -> done` on
 * completion; `running -> pending` on a failure with attempts left, or
 * `running -> failed` once they run out. There is no path back out of
 * `done`/`failed` — a retry past the limit is a new job.
 */
export type JobStatus = 'pending' | 'running' | 'done' | 'failed'

/** Whatever the enqueuer needs the worker to know; stored as JSON. */
export type JobPayload = Record<string, unknown>

/**
 * How far a running job has got, so a dashboard can say `217 / 300` rather
 * than only "running".
 *
 * `total` is null when the run has no known end — a crawl resuming from the
 * watermark stops after a streak of consecutive misses, and how many ids
 * that takes is not knowable in advance. `totalIsEstimate` covers the case
 * in between: a bound exists (an explicit `limit`) but the run may still
 * stop short of it, so the denominator is a ceiling and not a promise.
 */
export interface JobProgress {
  done: number
  total: number | null
  totalIsEstimate: boolean
}

export interface Job {
  id: number
  type: JobType
  payload: JobPayload
  status: JobStatus
  attempts: number
  createdAt: string
  /** When the *current* attempt started; null while pending. */
  startedAt: string | null
  /** Set only on a terminal outcome (`done` or `failed`). */
  finishedAt: string | null
  /** Why the last attempt failed; survives into the retry so it stays visible. */
  error: string | null
  /** Counts for the *current* attempt; reset whenever the job re-enters the queue. */
  progress: JobProgress
  /**
   * What the job is doing right now, in the engine's own words, or null when
   * it is not running. It answers the question a counter cannot: a single
   * case spends most of its time before the first document is known, and a
   * row sitting at 0 with no total is indistinguishable from a hung one.
   */
  stage: string | null
  /**
   * The last sign of life from the worker holding this job — the lease
   * `reclaimStaleJobs` reads to tell a job still being worked on from one
   * stranded by a worker that died. Null unless the job is running.
   */
  heartbeatAt: string | null
}
