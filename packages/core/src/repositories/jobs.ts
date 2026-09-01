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
 * Note this deliberately does not reclaim jobs abandoned in `running` by a
 * worker that died — doing that safely needs a lease/heartbeat column, which
 * the agreed schema does not have. Until then a crashed worker's job stays
 * `running` and is visible as such in `countJobsByStatus`.
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
           finished_at = NULL
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
       SET status = 'done', finished_at = datetime('now'), error = NULL
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
 * columns.
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
           finished_at = CASE WHEN attempts < @maxAttempts THEN NULL ELSE datetime('now') END
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
