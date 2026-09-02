import {
  claimNextJob, completeJob, failJob, heartbeatJob, releaseJob, reclaimStaleJobs,
  updateJobProgress, DEFAULT_LEASE_MS,
  type Db, type BlobStore, type Job, type JobType,
} from '@pje/core'
import { type HttpClient, type Reporter } from '@pje/scraper'
import { HANDLERS, REAL_ENGINE, type Engine, type JobHandler } from './handlers.ts'
import { PermanentJobError, UnknownJobTypeError } from './errors.ts'
import { createProgressPublisher, DEFAULT_PROGRESS_INTERVAL_MS } from './progress.ts'
import {
  reclaimedLine, jobStartLine, jobDoneLine, jobFailedLine, jobLostLine, jobAbandonedLine,
} from './format.ts'

/** How often a running job proves it is still being worked on. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000

/** How long `--watch` waits before asking an empty queue again. */
export const DEFAULT_POLL_INTERVAL_MS = 1_000

export interface WorkerDeps {
  db: Db
  blobs: BlobStore
  client: HttpClient
  /** Replaceable so a test can drive a handler without a portal; defaults to the real scraper. */
  engine?: Engine
}

export interface WorkerOptions {
  /** Claim only these job types. Omitted, the worker takes whatever is next. */
  types?: readonly JobType[]
  /** Keep polling once the queue empties instead of returning. */
  watch?: boolean
  pollIntervalMs?: number
  /** Stop after this many jobs, leaving the rest queued. */
  maxJobs?: number
  /** Passed to any handler whose payload names no concurrency of its own. */
  concurrency?: number
  maxAttempts?: number
  leaseMs?: number
  heartbeatIntervalMs?: number
  progressIntervalMs?: number
  handlers?: Partial<Record<string, JobHandler>>
  reporter?: Reporter
}

export interface WorkerSummary {
  claimed: number
  done: number
  /** Failed with attempts still to spend — back in the queue. */
  retried: number
  /** Failed terminally. */
  failed: number
  /** Handed back to the queue by `abandon`. */
  abandoned: number
  /** Finished, but the lease had already been taken away, so the result was dropped. */
  lost: number
  /** Jobs freed from a dead worker before this one started. */
  reclaimed: number
  stopped: 'drained' | 'max_jobs' | 'interrupted'
}

export interface Worker {
  run(): Promise<WorkerSummary>
  /** Stop claiming new jobs. Whatever is in flight is allowed to finish. */
  drain(): void
  /**
   * Hand the in-flight job straight back to the queue and stop. Returns
   * whether there was one to hand back. Synchronous on purpose: this is what
   * a signal handler calls, and it must have committed before the process
   * goes away.
   */
  abandon(reason: string): boolean
  /** The job being executed right now, if any. */
  readonly currentJobId: number | null
}

const silentReporter: Reporter = {
  header: () => {}, note: () => {}, detail: () => {},
  deepStep: () => {}, deepDocument: () => {}, deepCase: () => {},
  crawlProgress: () => {}, http: () => {},
}

/**
 * The whole worker: claim a job, run it, mark it done or failed, repeat.
 *
 * It deliberately holds no queue state of its own. Which job is next, and
 * whether this worker or another one gets it, is decided entirely by
 * `claimNextJob`'s single atomic statement, and nothing here brackets that
 * call with logic that could reopen the window it closes — no "is there
 * anything pending?" check before it, no re-read of the row after it. Every
 * decision this loop makes is made from the row that statement handed back.
 * Running several of these against one database needs no coordination beyond
 * that.
 */
export function createWorker(deps: WorkerDeps, opts: WorkerOptions = {}): Worker {
  const db = deps.db
  const engine = deps.engine ?? REAL_ENGINE
  const reporter = opts.reporter ?? silentReporter
  const handlers = { ...HANDLERS, ...opts.handlers }
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  const summary: WorkerSummary = {
    claimed: 0, done: 0, retried: 0, failed: 0, abandoned: 0, lost: 0, reclaimed: 0,
    stopped: 'drained',
  }

  let current: Job | null = null
  let stopping = false
  let interrupted = false
  /** True once `abandon` has given the current job away; its result must be dropped. */
  let abandoned = false
  /** Resolves the `--watch` wait early, so a stop does not sit out the poll interval. */
  let wake: (() => void) | null = null

  const idle = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => { wake = null; resolve() }, ms)
      wake = () => { clearTimeout(timer); wake = null; resolve() }
    })

  async function execute(job: Job): Promise<void> {
    const handler = handlers[job.type]
    const publisher = createProgressPublisher({
      write: (p) => updateJobProgress(db, job.id, p, job.attempts),
      minIntervalMs: opts.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS,
    })

    // Proves the job is still being worked on for as long as it takes, so
    // `reclaimStaleJobs` can tell it apart from one whose worker died. A
    // progress report renews the lease too, but a single case can spend
    // minutes on one slow document without reporting anything, and that must
    // not read as death. `unref` so a stray timer can never be the reason
    // the process refuses to exit.
    let lost = false
    const beat = setInterval(() => {
      if (!heartbeatJob(db, job.id, job.attempts)) {
        lost = true
        clearInterval(beat)
      }
    }, heartbeatIntervalMs)
    beat.unref()

    const startedAt = Date.now()
    try {
      if (!handler) throw new UnknownJobTypeError(job.type, Object.keys(HANDLERS))
      const line = await handler(
        { db, blobs: deps.blobs, client: deps.client, engine },
        { job, publish: (p) => publisher.publish(p), reporter, concurrency: opts.concurrency },
      )
      publisher.flush()
      if (!settle(job, lost)) return
      completeJob(db, job.id)
      summary.done++
      reporter.note(jobDoneLine(job, line, Date.now() - startedAt))
    } catch (err) {
      publisher.flush()
      if (!settle(job, lost)) return
      const message = err instanceof Error ? err.message : String(err)
      // A malformed job is spent on its first attempt: see `PermanentJobError`.
      const outcome = err instanceof PermanentJobError
        ? failJob(db, job.id, message, { maxAttempts: 1 })
        : failJob(db, job.id, message, { maxAttempts: opts.maxAttempts })
      if (outcome === 'retry') summary.retried++
      else summary.failed++
      reporter.note(jobFailedLine(job, outcome, message))
    } finally {
      clearInterval(beat)
      current = null
    }
  }

  /**
   * Decides whether this worker may still write the outcome of `job`, and
   * accounts for it when it may not.
   *
   * Two ways it may not, and they are different things. `abandon` gave the
   * job back deliberately, so the row is already `pending` and writing
   * `done` over it would lose work somebody is about to redo. Losing the
   * lease is the involuntary version: this worker went quiet long enough to
   * be presumed dead, the job was reclaimed, and another worker may already
   * be part-way through it — so this one's result is not merely late, it is
   * about to overwrite an attempt that is still live.
   *
   * The check is deliberately last, after the work is finished: nothing is
   * gained by finding out earlier, since the work cannot be called back, and
   * anything already written to `cases`/`documents` is idempotent by design.
   */
  function settle(job: Job, lostLease: boolean): boolean {
    if (abandoned) {
      summary.abandoned++
      return false
    }
    if (lostLease || !heartbeatJob(db, job.id, job.attempts)) {
      summary.lost++
      reporter.note(jobLostLine(job))
      return false
    }
    return true
  }

  return {
    get currentJobId() {
      return current?.id ?? null
    },

    drain() {
      stopping = true
      interrupted = true
      wake?.()
    },

    abandon(reason) {
      stopping = true
      interrupted = true
      wake?.()
      const job = current
      if (job === null) return false
      abandoned = true
      const released = releaseJob(db, job.id, reason)
      reporter.note(jobAbandonedLine(job, released))
      return released
    },

    async run() {
      // Before claiming anything: free whatever an earlier worker died
      // holding. Doing it here rather than on a timer is enough for the
      // manual model this worker is built for — you start it, and starting
      // it is the moment a stranded job becomes worth rescuing.
      summary.reclaimed = reclaimStaleJobs(db, { leaseMs, maxAttempts: opts.maxAttempts })
      if (summary.reclaimed > 0) reporter.note(reclaimedLine(summary.reclaimed))

      for (;;) {
        if (stopping) break
        if (opts.maxJobs !== undefined && summary.claimed >= opts.maxJobs) {
          summary.stopped = 'max_jobs'
          return summary
        }

        const job = claimNextJob(db, opts.types ? { types: opts.types } : {})
        if (job === null) {
          if (!opts.watch) break
          await idle(pollIntervalMs)
          // A worker sitting in `--watch` is the only one likely to be
          // running when another one dies, so it is also the only one in a
          // position to notice.
          const freed = reclaimStaleJobs(db, { leaseMs, maxAttempts: opts.maxAttempts })
          if (freed > 0) {
            summary.reclaimed += freed
            reporter.note(reclaimedLine(freed))
          }
          continue
        }

        current = job
        summary.claimed++
        reporter.note(jobStartLine(job))
        await execute(job)
      }

      summary.stopped = interrupted ? 'interrupted' : 'drained'
      return summary
    },
  }
}
