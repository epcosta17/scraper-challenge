import type {
  ArchiveStats,
  ArchiveStatus,
  CaseDetail,
  CasePage,
  CaseSummary,
  Job,
  DocumentSample,
  DocumentText,
  CaptureOverview,
  ClassOption,
  OrganOption,
  Conversation,
  EnqueueOutcome,
  RetryOutcome,
  JobKind,
  SearchCriteria,
  SearchResult,
  HeldCase,
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

  /**
   * The cases with the newest activity in the court, by their own last
   * movement — which is a different question from `listCases`'s "most
   * recently captured": a case crawled this morning may have sat still since
   * 2019.
   */
  recentlyMoved(limit: number): Promise<CaseSummary[]>

  /**
   * Documents from across the acervo, for browsing rather than searching —
   * the "show me a few" that every other document query, needing an id or a
   * case, cannot answer.
   */
  sampleDocuments(limit: number, order: 'random' | 'recent'): Promise<DocumentSample[]>

  /**
   * A document's captured text, for reading rather than downloading.
   *
   * Separate from `openDocument` on purpose: that one serves the viewer and
   * hands back the PDF bytes when there is a file, which is right for a
   * browser and useless to anything that needs to read the words. Both the
   * markup and the PDF text are kept, so this never has to parse a blob.
   */
  documentText(id: number): Promise<DocumentText | null>

  /**
   * The case each of these documents belongs to, for the ids that exist.
   *
   * A citation in an answer has to become a link to the document *in its case
   * file*, which is where the viewer lives — the raw file behind
   * `/documentos/:id` is a download, not a reading experience.
   */
  documentCases(ids: number[]): Promise<Map<number, string>>

  /** A single case by its CNJ number, or null when it is not in the acervo. */
  getCase(number: string): Promise<CaseDetail | null>

  /**
   * Which of these case numbers we already hold, and the little the search
   * results need to show for them.
   *
   * Takes the whole list because the caller has the whole list: a page of
   * portal results asks this once instead of once per row, and a row we do
   * not hold is simply absent from the map rather than a null to unpack.
   */
  casesByNumber(numbers: readonly string[]): Promise<Map<string, HeldCase>>

  /**
   * Makes sure every one of these cases is on its way into the acervo, and
   * says which job is carrying each.
   *
   * Idempotent by design, because the page that calls it is a GET somebody
   * will reload: a case already captured needs nothing, and one already
   * queued or running is answered with the job it already has rather than a
   * second copy of the same work. The returned map is keyed by internal id so
   * a row can watch its own job.
   */
  ensureCaptureJobs(ids: readonly number[]): Promise<Map<number, number>>

  /**
   * Queues the capture that would clear a failure — one of them, or every one
   * that can be targeted.
   *
   * Not every failure can. A `summary_pdf` names an id nobody has captured, so
   * it re-runs as a fresh `deep_case`; a `parties` or `document` failure names
   * a case we hold, so it re-runs as a `refresh_case`. A failure recorded
   * before the case was stored alongside it names nothing actionable, and is
   * reported as skipped rather than guessed at.
   */
  retryFailures(ids: readonly number[]): Promise<RetryOutcome>

  /**
   * The search form, answered against the acervo: free text across case
   * metadata, party names and the text of every document — ranked, with a
   * highlighted fragment of the document that matched — narrowed by any of
   * the portal's own eight criteria. A form with nothing in it answers with
   * no hits and no error.
   */
  search(criteria: SearchCriteria, page: number, pageSize: number): Promise<SearchResult>

  /** The judicial classes the acervo holds, for the class control to offer. */
  caseClasses(): Promise<ClassOption[]>

  /** The judging panels the acervo holds, for the organ control to offer. */
  caseOrgans(): Promise<OrganOption[]>

  /** The OAB states the acervo holds a lawyer for. Empty when it holds none. */
  oabStates(): Promise<string[]>

  /** The same index, asked in prose: the passages an answer would stand on. */
  conversation(question: string | null): Promise<Conversation>

  /**
   * The CNJ number behind an internal id, or null.
   *
   * A capture is queued by internal id as readily as by number, so anything
   * checking on one afterwards needs to get from that id back to a case.
   */
  caseNumberById(idProcessoTrf: number): Promise<string | null>

  /**
   * One job by its id, however old.
   *
   * `captureOverview` only carries the last window of jobs, which is right for
   * a screen and wrong for anything following a particular job: a queue busy
   * enough to push it out of that window is exactly when you want to know.
   */
  job(id: number): Promise<Job | null>

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
