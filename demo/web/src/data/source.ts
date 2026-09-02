import type {
  ArchiveStats,
  CaseDetail,
  CasePage,
  CaptureOverview,
  Conversation,
  PortalQuery,
  PortalSearchResult,
} from './types.ts'

/**
 * Everything the web app is allowed to know about where the data comes from.
 *
 * This is the seam: today `fixtures.ts` answers with the sample rows lifted
 * from the design, tomorrow an implementation over `@pje-trf5/core`'s
 * repositories answers with rows out of the SQLite file. Pages import the
 * singleton from `./index.ts` and nothing else — no page opens a database, and
 * no storage type leaks into a template.
 *
 * Every method is async so that a synchronous better-sqlite3 implementation and
 * a remote one are both a drop-in.
 */
export interface WebDataSource {
  /** Acervo-wide counters for the footer of the list screen. */
  archiveStats(): Promise<ArchiveStats>

  /** One page of the acervo, newest capture first. `page` is 1-based. */
  listCases(page: number, pageSize: number): Promise<CasePage>

  /** A single case by its CNJ number, or null when it is not in the acervo. */
  getCase(number: string): Promise<CaseDetail | null>

  /** Live state of the capture workers: KPIs, queue and unresolved failures. */
  captureOverview(): Promise<CaptureOverview>

  /**
   * A live query against the TRF5 public search form. The result carries the
   * server-side row cap, because a caller cannot page past it.
   */
  searchPortal(query: PortalQuery): Promise<PortalSearchResult>

  /** The current chat thread, with the passages its answer is standing on. */
  conversation(): Promise<Conversation>
}
