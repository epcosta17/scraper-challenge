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
}

/**
 * The work a queued job asks for. Open by design — new types are expected,
 * and the `jobs.type` column deliberately carries no CHECK constraint so
 * that adding one here is the only change needed (see `schema.ts`).
 *
 *   discover      walk the acervo looking for ids not seen yet
 *   refresh_case  re-fetch a case's metadata and movements
 *   deep_case     fetch a case and every document in its file
 *   backfill      re-run an id range that an earlier pass missed
 */
export type JobType = 'discover' | 'refresh_case' | 'deep_case' | 'backfill'

/**
 * A job's lifecycle. `pending -> running` on a claim; `running -> done` on
 * completion; `running -> pending` on a failure with attempts left, or
 * `running -> failed` once they run out. There is no path back out of
 * `done`/`failed` — a retry past the limit is a new job.
 */
export type JobStatus = 'pending' | 'running' | 'done' | 'failed'

/** Whatever the enqueuer needs the worker to know; stored as JSON. */
export type JobPayload = Record<string, unknown>

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
}
