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
  label: string
  docDate: string | null
  format: 'PDF' | 'HTML'
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

// ── Portal search ───────────────────────────────────────────────────────────

export interface PortalQuery {
  caseNumber: string
  autuacaoFrom: string
  autuacaoTo: string
  className: string
  partyName: string
  lawyerName: string
  documentKind: 'cpf' | 'cnpj'
  documentNumber: string
  oabNumber: string
  oabUf: string
  referenceNumber: string
}

export interface PortalHit {
  number: string
  className: string
  /** Whether this case is already in our acervo. */
  inArchive: boolean
}

export interface PortalSearchResult {
  hits: PortalHit[]
  /**
   * Rows the portal will answer with, at most. The cut happens in the server's
   * own query, so no parameter, page or sort order gets past it.
   */
  rowLimit: number
  /** The portal returned a full page: there are more results we cannot see. */
  capped: boolean
  elapsedMs: number
}

// ── Capture processes ───────────────────────────────────────────────────────

export type JobKind = 'crawl' | 'deep' | 'discover' | 'daily' | 'backfill'
export type JobState = 'running' | 'queued' | 'done' | 'failed'

export interface Job {
  id: string
  kind: JobKind
  target: string
  done: number | null
  /** null when the run has no known end — a discover walking the watermark. */
  total: number | null
  /** The total is an estimate, not a promise. */
  totalIsEstimate: boolean
  state: JobState
}

export interface CaptureFailure {
  kind: string
  ref: string
  error: string
}

export interface CaptureOverview {
  runningJobs: number
  casesToday: number
  documentsToday: number
  openFailures: number
  requestsPerSecond: number
  updatedAgoLabel: string
  jobs: Job[]
  failures: CaptureFailure[]
  /** Requests a single deep capture costs, on average. */
  requestsPerCase: number
}

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
