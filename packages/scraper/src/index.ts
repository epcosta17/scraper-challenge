/**
 * The scraper as a library: the engine entry points and the pieces needed to
 * drive and narrate them. `demo/worker` is the first caller that is not the
 * CLI, and this exists so it depends on `@pje/scraper` the way it depends on
 * any package rather than reaching into file paths inside one.
 *
 * Deliberately narrow. The CLI's own argument parsing and line formatting
 * stay unexported — they are how *that* program talks to a terminal, not
 * part of the engine — with the single exception of the reporter, which is
 * where the three logging levels are decided and is worth having one
 * implementation of rather than two. The CLI's `main` is reachable at
 * `@pje/scraper/cli` for anything that wants to invoke the command line
 * itself.
 */
export { HttpClient, RateLimitedError, decodeLatin1 } from './http/client.ts'
export type { HttpClientOptions, HttpEvent, HttpResponse } from './http/client.ts'

// The portal's own search form. Exported because a caller other than the CLI
// needs it now: the demo's search screen queries the live portal, and the
// whole point of that screen is to be faithful to the website's form rather
// than to reimplement a version of it.
export { search, validateFilters, SearchValidationError, ActionNotExecutedError } from './pje/search.ts'
export { startSession } from './pje/session.ts'
export type { SearchFilters, SearchRow, SearchOutcome } from './pje/search.ts'
export { CookieJar } from './http/cookie-jar.ts'

export { crawl, pdfKeyFor, DEFAULT_STOP_AFTER_MISSES } from './crawl/enumerate.ts'
export type { CrawlDeps, CrawlOptions, CrawlProgress, CrawlSummary } from './crawl/enumerate.ts'

export { deepCase, deepRange, documentPdfKeyFor, sanitizeFilename, CaseNotFoundError } from './crawl/deep.ts'
export type {
  DeepDeps, DeepOptions, DeepTarget, DeepCaseOutcome,
  DeepDocumentProgress, DeepRangeOptions, DeepRangeSummary, DeepStepEvent,
} from './crawl/deep.ts'

export { createReporter } from './cli/reporter.ts'
export type { Reporter, ReporterOptions } from './cli/reporter.ts'
export type { LogLevel } from './cli/args.ts'

export { SCRAPER_VERSION } from './version.ts'
