import {
  getCaseById, getCaseByNumber, getMaxCaseId,
  type Db, type BlobStore, type Job, type JobProgressUpdate, type JobType,
} from '@pje/core'
import {
  crawl, deepCase, deepRange,
  type HttpClient, type Reporter, type DeepTarget,
} from '@pje/scraper'
import { parseCrawlPayload, parseDeepCasePayload, parseDeepRangePayload } from './payloads.ts'
import { JobPayloadError } from './errors.ts'
import { stageOf } from './stages.ts'

/**
 * The scraper entry points a handler calls, named so they can be replaced in
 * a test. Nothing here reimplements any part of the scrape — a handler's
 * whole job is to turn a queued payload into one of these three calls and
 * turn what they report back into progress on the job's row.
 */
export interface Engine {
  crawl: typeof crawl
  deepCase: typeof deepCase
  deepRange: typeof deepRange
}

export const REAL_ENGINE: Engine = { crawl, deepCase, deepRange }

export interface HandlerDeps {
  db: Db
  blobs: BlobStore
  client: HttpClient
  engine: Engine
}

export interface HandlerContext {
  job: Job
  /** Report where the job has got to. Rate-limited on the way to SQLite; see `progress.ts`. */
  publish: (p: JobProgressUpdate) => void
  reporter: Reporter
  /** The worker's own default, used for any job whose payload names no concurrency. */
  concurrency?: number
}

/** Runs one job and returns the single line describing what it did. Throws to fail the job. */
export type JobHandler = (deps: HandlerDeps, ctx: HandlerContext) => Promise<string>

const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`

/**
 * How many ids an explicit range covers. Clamped at zero because a range can
 * legitimately be empty by the time it runs — a `toId` that the watermark
 * has already passed — and a negative denominator on a progress bar is worse
 * than an honest zero.
 */
const rangeSize = (fromId: number, toId: number): number => Math.max(0, toId - fromId + 1)

/**
 * `crawl`, and the two older names for it.
 *
 * The denominator is worked out here, before the call, because the engine's
 * `onProgress` carries a count of what has happened and nothing about what
 * is left. Three cases, all real:
 *  - an explicit `toId`: an exact total. A missing `fromId` means the run
 *    resumes from the watermark, so the total is measured from there and not
 *    from zero — the same expression `crawl` itself uses for its start.
 *  - a `limit` and no `toId`: a ceiling, not a promise. The run also stops on
 *    a streak of consecutive misses, so it may finish well short of it —
 *    hence `totalIsEstimate`.
 *  - neither: no total. The run ends when the misses run out and there is
 *    genuinely no honest number to divide by.
 *
 * Ids that fail do not fail the job. A crawl is expected to walk past
 * individual failures (they are recorded in `failures`, to be retried by a
 * later run over the same range) and a job marked `failed` because 1 id in
 * 300 was a bad PDF would be both wrong and, on a retry, 299 wasted
 * requests.
 */
const runCrawl: JobHandler = async (deps, ctx) => {
  const spec = parseCrawlPayload(ctx.job.payload)
  const fromId = spec.fromId ?? getMaxCaseId(deps.db) + 1
  const total =
    spec.toId !== undefined ? rangeSize(fromId, spec.toId)
    : spec.limit !== undefined ? spec.limit
    : null
  ctx.publish({ done: 0, total, totalIsEstimate: spec.toId === undefined && spec.limit !== undefined })

  let done = 0
  const summary = await deps.engine.crawl({ client: deps.client, db: deps.db, blobs: deps.blobs }, {
    fromId,
    toId: spec.toId,
    limit: spec.limit,
    stopAfterMisses: spec.stopAfterMisses,
    concurrency: spec.concurrency ?? ctx.concurrency,
    onProgress: (p) => {
      done++
      ctx.publish({ done })
      ctx.reporter.crawlProgress(p)
    },
    onRetry: (r) => ctx.reporter.detail(
      `↻ id ${r.id}: summary PDF came back HTTP ${r.status} - retry ${r.attempt} of ${r.of}`,
    ),
  })

  return `${plural(summary.stored, 'case')} stored, ${summary.absent} absent, ` +
    `${summary.failed} failed, last id ${summary.lastId}`
}

/**
 * Runs one case and narrates it. Shared by `deep_case` and `refresh_case`,
 * which differ only in how they arrive at the target (see `runRefreshCase`).
 *
 * Progress is counted in *documents*, not cases: one case is one unit of
 * work at the job level, which would only ever render as 0/1 or 1/1, while a
 * case file with forty documents is several minutes in which the interface
 * would have nothing to show. The total is unknown until the detail page has
 * been read, so it starts null and is filled in by the `documents` step
 * event the engine already emits for exactly this purpose.
 *
 * A failed case throws. Unlike a range, a single-target job *is* its one
 * case: there is no partial success to preserve, and a job reported `done`
 * for a case that was never captured would be a lie the queue then has no
 * way to retry.
 */
async function runOneCase(deps: HandlerDeps, ctx: HandlerContext, target: DeepTarget): Promise<string> {
  ctx.publish({ done: 0, total: null, totalIsEstimate: false })

  let done = 0
  const outcome = await deps.engine.deepCase({ client: deps.client, db: deps.db, blobs: deps.blobs }, target, {
    onStep: (e) => {
      // The stage is what carries this job between the claim and the first
      // document, which on one case is most of the wall clock.
      if (e.kind === 'documents') ctx.publish({ done, total: e.total, stage: null })
      else ctx.publish({ done, stage: stageOf(e) })
      ctx.reporter.deepStep(e)
    },
    onDocumentProgress: (p) => {
      done++
      ctx.publish({ done })
      ctx.reporter.deepDocument(p)
    },
  })

  if (outcome.kind === 'failed') throw new Error(outcome.error)
  ctx.reporter.deepCase(outcome)
  return `${outcome.number} (id ${outcome.idProcessoTrf}): ` +
    `${outcome.documentsStored} documents stored, ${outcome.documentsSkipped} already on disk, ` +
    `${outcome.documentsFailed} failed`
}

const runDeepCase: JobHandler = async (deps, ctx) =>
  runOneCase(deps, ctx, parseDeepCasePayload(ctx.job.payload))

/**
 * `deep_range`. Counts *cases*, since the range's size is the one total
 * known up front, and — like `crawl` — treats an individual case's failure
 * as something to record rather than something to fail the job over: the
 * other ids in the range succeeded, and rerunning the whole range to retry
 * one of them would redo every case that already worked.
 */
const runDeepRange: JobHandler = async (deps, ctx) => {
  const spec = parseDeepRangePayload(ctx.job.payload)
  ctx.publish({ done: 0, total: rangeSize(spec.fromId, spec.toId), totalIsEstimate: false })

  let done = 0
  const summary = await deps.engine.deepRange({ client: deps.client, db: deps.db, blobs: deps.blobs }, {
    fromId: spec.fromId,
    toId: spec.toId,
    concurrency: spec.concurrency ?? ctx.concurrency,
    onStep: (e) => ctx.reporter.deepStep(e),
    onDocumentProgress: (p) => ctx.reporter.deepDocument(p),
    onCaseProgress: (o) => {
      done++
      ctx.publish({ done })
      ctx.reporter.deepCase(o)
    },
  })

  return `${plural(summary.casesDone, 'case')} captured, ${summary.casesFailed} failed, ` +
    `${summary.documentsStored} documents stored, ${summary.documentsSkipped} already on disk`
}

/**
 * `refresh_case` — re-read a case that is already in the acervo.
 *
 * The work is `deepCase`, which is already the right shape for a refresh:
 * it re-reads the summary PDF, the detail page, the parties and the
 * movements, and skips every document it finds already downloaded. What
 * makes this a separate job type is the precondition, which is enforced
 * here: the case must already be stored. Enqueuing a refresh for an id
 * nobody has ever captured is a mistake — most likely a typo'd id — and
 * quietly turning it into a first-time capture would hide that, as well as
 * spending a full deep capture nobody asked for.
 *
 * Resolving the target locally is the second thing the precondition buys: a
 * case number already on file resolves to its id straight out of SQLite, so
 * a refresh never pays for the search bridge (a session GET, a search POST,
 * and a retry loop for the roughly one run in four where it does not take).
 */
const runRefreshCase: JobHandler = async (deps, ctx) => {
  const target = parseDeepCasePayload(ctx.job.payload)
  const stored = target.kind === 'id'
    ? getCaseById(deps.db, target.id)
    : getCaseByNumber(deps.db, target.number)
  if (!stored) {
    const named = target.kind === 'id' ? `id ${target.id}` : `case ${target.number}`
    throw new JobPayloadError(
      `refresh_case is for a case that is already stored, and ${named} is not stored. ` +
      'Enqueue a deep_case to capture it for the first time.',
    )
  }
  return runOneCase(deps, ctx, { kind: 'id', id: stored.idProcessoTrf })
}

/**
 * One handler per job type. `discover` and `backfill` share the `crawl`
 * handler because that is precisely what they are — a crawl with no explicit
 * range, and a crawl with one — and giving them branches of their own would
 * be three copies of the same code kept in step for the sake of three names.
 */
export const HANDLERS: Readonly<Record<JobType, JobHandler>> = {
  crawl: runCrawl,
  discover: runCrawl,
  backfill: runCrawl,
  deep_case: runDeepCase,
  deep_range: runDeepRange,
  refresh_case: runRefreshCase,
}
