import type { Db } from '../db.ts'
import type { Job, JobPayload, JobStatus, JobType } from '../types.ts'

/**
 * How many times a job is attempted before `failJob` gives up on it.
 * A default rather than a column: the retry budget is a property of the
 * worker's policy, not of the queued work, and keeping it out of the table
 * means changing it does not need a migration or a backfill of existing rows.
 */
const DEFAULT_MAX_ATTEMPTS = 3

const STATUSES: readonly JobStatus[] = ['pending', 'running', 'done', 'failed']

/**
 * How long a claimed job may go without a sign of life before
 * `reclaimStaleJobs` treats the worker holding it as gone. Generous on
 * purpose: reclaiming too eagerly costs two workers running the same job at
 * once, while waiting costs one job sitting idle a little longer — so the
 * default is many times the interval a worker actually heartbeats at (see
 * `demo/worker`), leaving room for a machine that stalled, swapped, or spent
 * a while in 429 backoff.
 */
export const DEFAULT_LEASE_MS = 60_000

interface Row {
  id: number
  type: string
  payload_json: string
  status: string
  attempts: number
  created_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
  progress_done: number
  progress_total: number | null
  progress_total_is_estimate: number
  stage: string | null
  heartbeat_at: string | null
}

const toJob = (r: Row): Job => ({
  id: r.id,
  type: r.type as JobType,
  payload: JSON.parse(r.payload_json) as JobPayload,
  status: r.status as JobStatus,
  attempts: r.attempts,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  error: r.error,
  progress: {
    done: r.progress_done,
    total: r.progress_total,
    // SQLite has no boolean type; the column is the 0/1 integer it stores.
    totalIsEstimate: r.progress_total_is_estimate !== 0,
  },
  stage: r.stage,
  heartbeatAt: r.heartbeat_at,
})

export function enqueueJob(db: Db, type: JobType, payload: JobPayload = {}): Job {
  const row = db.prepare(`
    INSERT INTO jobs (type, payload_json, status, attempts, created_at)
    VALUES (?, ?, 'pending', 0, datetime('now'))
    RETURNING *
  `).get(type, JSON.stringify(payload)) as Row
  return toJob(row)
}

/**
 * Takes the oldest pending job and marks it running, or returns null if
 * there is none. Safe to call from any number of concurrent workers: no two
 * callers can ever be handed the same job.
 *
 * That guarantee rests entirely on this being **one statement**. The obvious
 * shape — `SELECT` the next pending id, then `UPDATE` it — has a window
 * between the two in which a second worker runs the same `SELECT` and gets
 * the same id; both then "claim" it and the work runs twice. Wrapping those
 * two statements in a transaction does not close the window either, because
 * SQLite starts a deferred transaction as a *reader* and only takes the
 * write lock at the `UPDATE`, by which point the id it read may already
 * belong to someone else.
 *
 * A single `UPDATE ... WHERE id = (SELECT ...) RETURNING *` has no window:
 * the statement holds the database's one write lock for its whole duration,
 * so the subquery and the write it feeds are indivisible. A concurrent
 * worker either waits for the lock (that is what `busy_timeout` in
 * `openDatabase` buys) and then runs its own subquery against the state this
 * one already committed — seeing the row as `running` and skipping it — or
 * it gets there first and this one waits. `RETURNING` closes the last gap by
 * reporting *what this statement itself wrote*, rather than re-reading a row
 * that a third worker could have touched in between.
 *
 * Proven across real OS processes in `tests/jobs.test.ts` ("partitions the
 * queue across parallel worker processes").
 *
 * The lease is stamped here, in this same statement, and so is the reset of
 * `progress_done`: a job is never `running` without a `heartbeat_at`, which
 * is what lets `reclaimStaleJobs` read the age of that column as the age of
 * the claim with no special case for "claimed but not yet heartbeated", and
 * a fresh attempt never inherits the count of the one before it. A follow-up
 * `UPDATE` for either would open exactly the window this statement exists to
 * avoid.
 */
export function claimNextJob(db: Db, opts: { types?: readonly JobType[] } = {}): Job | null {
  const types = opts.types
  // Built rather than fixed only because `IN (?, ?, ...)` needs one
  // placeholder per value; the values themselves are still bound, never
  // interpolated.
  const typeFilter = types && types.length > 0
    ? ` AND type IN (${types.map(() => '?').join(', ')})`
    : ''
  const row = db.prepare(`
    UPDATE jobs
       SET status = 'running',
           attempts = attempts + 1,
           started_at = datetime('now'),
           finished_at = NULL,
           heartbeat_at = datetime('now'),
           progress_done = 0,
           stage = NULL
     WHERE id = (
       SELECT id FROM jobs
        WHERE status = 'pending'${typeFilter}
        ORDER BY id
        LIMIT 1
     )
    RETURNING *
  `).get(...(types ?? [])) as Row | undefined
  return row ? toJob(row) : null
}

/**
 * Marks a running job done. Clears `error`, which at this point can only be
 * the reason an *earlier* attempt failed — leaving it would make a job that
 * eventually succeeded look like one that did not.
 *
 * An id that does not exist (or is already finished) is a no-op rather than
 * an error: a worker completing a job twice after a retry of its own is not
 * a condition worth crashing on.
 */
export function completeJob(db: Db, id: number): void {
  db.prepare(`
    UPDATE jobs
       SET status = 'done', finished_at = datetime('now'), error = NULL,
           stage = NULL, heartbeat_at = NULL
     WHERE id = ?
  `).run(id)
}

/**
 * Records that an attempt failed, and decides what happens next: back to
 * `pending` for another go while attempts remain, or terminal `failed` once
 * they are spent. Returns which of the two it did, so a worker can log the
 * difference without a follow-up read.
 *
 * The attempt was already counted at claim time, so `attempts` here is the
 * number of attempts *made* — comparing it against the budget needs no
 * adjustment.
 *
 * On a retry the timestamps of the abandoned attempt are cleared: the job is
 * genuinely not started, and leaving `started_at` set would make a queued
 * job indistinguishable from one in flight in any dashboard reading these
 * columns. `progress_done` goes with them, for the same reason. A *terminal*
 * failure keeps its count, which is the opposite call for the opposite
 * reason: "failed after 217 of 300" is the single most useful thing that row
 * can still say, and no further attempt is coming to overwrite it.
 *
 * The lease is dropped either way — neither a queued job nor a finished one
 * is being held by anybody.
 *
 * An unknown id reports `'failed'`, the conservative answer — it is the one
 * that does not tell a caller "this will be retried" about a job that no
 * longer exists.
 */
export function failJob(
  db: Db,
  id: number,
  error: string,
  opts: { maxAttempts?: number } = {},
): 'retry' | 'failed' {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const row = db.prepare(`
    UPDATE jobs
       SET status      = CASE WHEN attempts < @maxAttempts THEN 'pending' ELSE 'failed' END,
           error       = @error,
           started_at  = CASE WHEN attempts < @maxAttempts THEN NULL ELSE started_at END,
           finished_at = CASE WHEN attempts < @maxAttempts THEN NULL ELSE datetime('now') END,
           stage         = NULL,
           heartbeat_at  = NULL,
           progress_done = CASE WHEN attempts < @maxAttempts THEN 0 ELSE progress_done END
     WHERE id = @id
    RETURNING status
  `).get({ id, error, maxAttempts }) as { status: string } | undefined
  return row?.status === 'pending' ? 'retry' : 'failed'
}

export function getJob(db: Db, id: number): Job | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined
  return row ? toJob(row) : null
}

export function listJobs(
  db: Db,
  opts: { status?: JobStatus; type?: JobType; limit?: number; offset?: number } = {},
): Job[] {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (opts.status !== undefined) { where.push('status = @status'); params.status = opts.status }
  if (opts.type !== undefined) { where.push('type = @type'); params.type = opts.type }
  const rows = db.prepare(`
    SELECT * FROM jobs
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY id
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: opts.limit ?? -1, offset: opts.offset ?? 0 }) as Row[]
  return rows.map(toJob)
}

/**
 * Queue depth by status, with every status present even at zero — a caller
 * rendering a dashboard should not have to know which keys SQL happened to
 * return rows for.
 */
export function countJobsByStatus(db: Db): Record<JobStatus, number> {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status')
    .all() as Array<{ status: JobStatus; n: number }>
  for (const r of rows) counts[r.status] = r.n
  return counts
}

/** A progress report. `total` omitted leaves whatever total is on file alone. */
export interface JobProgressUpdate {
  done: number
  total?: number | null
  totalIsEstimate?: boolean
  /**
   * What the job is doing right now, in the engine's own words. Omitted
   * leaves whatever stage is on file; an explicit `null` clears it.
   */
  stage?: string | null
}

/**
 * Records how far the current attempt has got, so a dashboard can render
 * `217 / 300` instead of only "running".
 *
 * Guarded the same way `heartbeatJob` is, and for the same reason: on
 * `status = 'running'` so a late report arriving after `completeJob` cannot
 * un-finish a finished row, and on `expectedAttempts` so a report can only
 * ever land on the attempt that produced it. The status test alone is not
 * enough — a job reclaimed from a stalled worker and picked up by another is
 * `running` again, so the stalled worker's next report would walk the count
 * backwards on top of the live attempt and, worse, keep renewing a lease it
 * no longer holds. A job whose second worker then died would never be
 * reclaimed, because a zombie was signing for it. Omitted, this degrades to
 * the status test alone, which is right for a caller that only means "this
 * job, whoever is running it".
 *
 * A report is also a sign of life, so it refreshes the lease in the same
 * statement. A worker publishing progress is by definition not dead, and
 * making it heartbeat separately would mean a worker that reports steadily
 * could still have its job reclaimed out from under it.
 *
 * `total` is deliberately three-valued: omitted means "unchanged" (the
 * common case — the denominator is known once, at the start, and only the
 * count moves after that), while an explicit `null` means "this run has no
 * known end", which is a thing a caller genuinely needs to be able to say.
 * That is why the SET list is built rather than fixed; the values are still
 * bound, never interpolated.
 */
export function updateJobProgress(
  db: Db,
  id: number,
  p: JobProgressUpdate,
  expectedAttempts?: number,
): void {
  const sets = ['progress_done = @done', "heartbeat_at = datetime('now')"]
  if (p.total !== undefined) sets.push('progress_total = @total')
  if (p.totalIsEstimate !== undefined) sets.push('progress_total_is_estimate = @estimate')
  if (p.stage !== undefined) sets.push('stage = @stage')
  db.prepare(`
    UPDATE jobs SET ${sets.join(', ')}
     WHERE id = @id AND status = 'running'
       AND (@attempts IS NULL OR attempts = @attempts)
  `).run({
    id,
    done: p.done,
    total: p.total ?? null,
    estimate: p.totalIsEstimate === true ? 1 : 0,
    stage: p.stage ?? null,
    attempts: expectedAttempts ?? null,
  })
}

/**
 * Refreshes the lease on a job this worker believes it is holding, and
 * reports whether it still is. `false` means the row is no longer this
 * worker's running job — reclaimed by `reclaimStaleJobs` after it went quiet
 * for too long, or already finished — and a worker that sees it must stop
 * treating the job as its own rather than later marking somebody else's work
 * done.
 *
 * `expectedAttempts` is what closes the gap that `status = 'running'` alone
 * leaves: a job reclaimed from this worker and then claimed by another is
 * `running` again, so the status test would say yes to a row that now
 * belongs to someone else. Every claim increments `attempts`, so the count
 * this worker was handed at claim time is an identifier for *its* attempt,
 * and no new column is needed to tell two attempts apart. Omitted, this
 * degrades to the status test alone — right for a caller that only wants to
 * know whether the job is still in flight at all.
 */
export function heartbeatJob(db: Db, id: number, expectedAttempts?: number): boolean {
  const result = db.prepare(`
    UPDATE jobs SET heartbeat_at = datetime('now')
     WHERE id = @id AND status = 'running'
       AND (@attempts IS NULL OR attempts = @attempts)
  `).run({ id, attempts: expectedAttempts ?? null })
  return result.changes > 0
}

/**
 * Hands a running job back to the queue because the worker holding it is
 * shutting down — the Ctrl-C path. Reports whether it actually released
 * something, so a caller does not narrate an interruption it did not cause.
 *
 * The attempt is *given back* (`attempts - 1`), which is the one place this
 * differs from `reclaimStaleJobs` below, and the difference is knowledge: a
 * worker releasing its own job knows for certain that the job was cut short
 * by the operator and not by anything wrong with the job, so charging it an
 * attempt would let a few Ctrl-Cs walk an innocent job into `failed`.
 * `MAX(0, ...)` keeps the column sane if this is ever called twice.
 *
 * `error` is set rather than cleared. Strictly it is not a failure, but it
 * is the most recent thing that happened to this job, and "interrupted,
 * requeued" is far more useful on a process screen than either silence or a
 * stale message from an attempt two tries ago.
 *
 * Guarded on `status = 'running'` so a shutdown racing a job that just
 * finished cannot drag a `done` row back into the queue.
 */
export function releaseJob(db: Db, id: number, error: string): boolean {
  const result = db.prepare(`
    UPDATE jobs
       SET status = 'pending',
           attempts = MAX(0, attempts - 1),
           started_at = NULL,
           finished_at = NULL,
           stage = NULL,
           heartbeat_at = NULL,
           progress_done = 0,
           error = @error
     WHERE id = @id AND status = 'running'
  `).run({ id, error })
  return result.changes > 0
}

/** Why a reclaimed job is back in the queue — the text `reclaimStaleJobs` writes to `error`. */
export const STALE_LEASE_ERROR =
  'The worker holding this job stopped renewing its lease and is presumed dead; requeued.'

/**
 * Frees jobs stranded in `running` by a worker that died without releasing
 * them — a SIGKILL, an OOM, a pulled power cable — and returns how many it
 * freed. Nothing else can rescue those rows: `releaseJob` needs the worker
 * to still be alive to call it, which is exactly what is not true here.
 *
 * "Died" is inferred from the lease: a running job whose `heartbeat_at` has
 * not moved in `leaseMs` had a worker that stopped checking in. Falling back
 * to `started_at` covers a row claimed before this column existed, which
 * would otherwise be immortal for want of a heartbeat it never had a chance
 * to write.
 *
 * The attempt is *not* given back, unlike `releaseJob`: nothing here proves
 * the job is innocent of whatever killed the worker, and a job that reliably
 * takes its worker down with it must be able to reach `failed` rather than
 * loop forever. That is also why this applies the same attempt budget
 * `failJob` does instead of always returning the row to `pending` — a
 * reclaim that could never give up would be a way around the budget.
 *
 * One statement, for the reason spelled out at length on `claimNextJob`: a
 * `SELECT` of the stale ids followed by an `UPDATE` of them leaves a window
 * in which a second reclaimer, or the worker itself waking from a long
 * stall, acts on the same rows.
 */
export function reclaimStaleJobs(
  db: Db,
  opts: { leaseMs?: number; maxAttempts?: number } = {},
): number {
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  // SQLite's modifier takes seconds; sub-second leases round down to 0,
  // which reads as "anything not heartbeated this very instant", the
  // sensible floor rather than an error.
  const cutoff = `-${Math.floor(leaseMs / 1000)} seconds`
  const result = db.prepare(`
    UPDATE jobs
       SET status      = CASE WHEN attempts < @maxAttempts THEN 'pending' ELSE 'failed' END,
           started_at  = CASE WHEN attempts < @maxAttempts THEN NULL ELSE started_at END,
           finished_at = CASE WHEN attempts < @maxAttempts THEN NULL ELSE datetime('now') END,
           progress_done = CASE WHEN attempts < @maxAttempts THEN 0 ELSE progress_done END,
           stage = NULL,
           heartbeat_at = NULL,
           error = @error
     WHERE status = 'running'
       AND COALESCE(heartbeat_at, started_at) <= datetime('now', @cutoff)
  `).run({ maxAttempts, cutoff, error: STALE_LEASE_ERROR })
  return result.changes
}
