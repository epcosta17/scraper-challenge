import type {
  ArchiveStats,
  ArchiveStatus,
  CaseDetail,
  CasePage,
  CaptureOverview,
  Conversation,
  EnqueueOutcome,
  JobKind,
  SearchResult,
} from './types.ts'

/** A stored document, ready to be written to an HTTP response. */
export interface DocumentFile {
  /** Descriptive, and safe as a path segment: `0800120-05.2024.4.05.8306 — Despacho — 09-04-2024.pdf`. */
  filename: string
  contentType: string
  body: Uint8Array | string
}

/**
 * Everything the web app is allowed to know about where the data comes from.
 *
 * This is the seam: an implementation over `@pje/core`'s repositories answers
 * with rows out of the SQLite file the scraper writes. Pages import the
 * singleton from `./index.ts` and nothing else — no page opens a database, and
 * no storage type leaks into a template.
 *
 * Every method is async so that a synchronous better-sqlite3 implementation and
 * a remote one are both a drop-in. Nothing here throws for an absent or empty
 * database: `status()` says what is wrong and every other method answers
 * emptily, so a misconfigured deployment renders an explanation rather than a
 * stack trace.
 */
export interface WebDataSource {
  /** Whether there is an acervo behind these screens, and where it lives. */
  status(): Promise<ArchiveStatus>

  /** Acervo-wide counters for the footer of the list screen. */
  archiveStats(): Promise<ArchiveStats>

  /** One page of the acervo, newest capture first. `page` is 1-based. */
  listCases(page: number, pageSize: number): Promise<CasePage>

  /** A single case by its CNJ number, or null when it is not in the acervo. */
  getCase(number: string): Promise<CaseDetail | null>

  /**
   * Full-text search across case metadata, party names and the text of every
   * document, ranked, with a highlighted fragment of the document that
   * matched. An empty query answers with no hits and no error.
   */
  search(query: string, page: number, pageSize: number): Promise<SearchResult>

  /** The same index, asked in prose: the passages an answer would stand on. */
  conversation(question: string | null): Promise<Conversation>

  /** Live state of the capture queue: KPIs, jobs and unresolved failures. */
  captureOverview(): Promise<CaptureOverview>

  /**
   * Puts a job on the queue. The web only ever enqueues — an external worker
   * drains the queue and does the actual capturing.
   */
  enqueue(kind: JobKind, target: string): Promise<EnqueueOutcome>

  /** A stored document's bytes, by `id_processo_documento`, or null. */
  openDocument(id: number): Promise<DocumentFile | null>

  /**
   * The summary PDF the portal generates for a whole case — the one every
   * capture downloads first, and the closest thing to "the file, entire".
   */
  openCaseSummary(number: string): Promise<DocumentFile | null>
}
