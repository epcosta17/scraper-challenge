import { describe, it, expect, beforeEach } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import {
  openDatabase, enqueueJob, claimNextJob, completeJob, failJob,
  getJob, listJobs, countJobsByStatus,
  updateJobProgress, heartbeatJob, releaseJob, reclaimStaleJobs,
} from '../src/index.ts'

let dir: string
let dbPath: string
let db: ReturnType<typeof openDatabase>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pje-jobs-'))
  dbPath = join(dir, 'jobs.db')
  db = openDatabase(dbPath)
  return () => { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

describe('enqueueJob', () => {
  it('stores a pending job with its payload, zero attempts and a creation timestamp', () => {
    const job = enqueueJob(db, 'deep_case', { idProcessoTrf: 130100 })
    expect(job.type).toBe('deep_case')
    expect(job.status).toBe('pending')
    expect(job.attempts).toBe(0)
    expect(job.payload).toEqual({ idProcessoTrf: 130100 })
    expect(job.createdAt).not.toBe('')
    expect(job.startedAt).toBeNull()
    expect(job.finishedAt).toBeNull()
    expect(job.error).toBeNull()
  })

  it('defaults the payload to an empty object rather than storing SQL NULL', () => {
    const job = enqueueJob(db, 'discover')
    expect(job.payload).toEqual({})
    expect(getJob(db, job.id)!.payload).toEqual({})
  })

  it('accepts every planned job type', () => {
    for (const type of ['discover', 'refresh_case', 'deep_case', 'backfill'] as const) {
      expect(enqueueJob(db, type).type).toBe(type)
    }
    expect(listJobs(db)).toHaveLength(4)
  })

  it('round-trips a nested payload through JSON', () => {
    const payload = { number: '0013475-36.2026.4.05.0000', opts: { documents: true, depth: 2 } }
    const id = enqueueJob(db, 'refresh_case', payload).id
    expect(getJob(db, id)!.payload).toEqual(payload)
  })
})

describe('claimNextJob', () => {
  it('returns null on an empty queue', () => {
    expect(claimNextJob(db)).toBeNull()
  })

  it('marks the claimed job running, counts the attempt and stamps started_at', () => {
    const id = enqueueJob(db, 'discover').id
    const claimed = claimNextJob(db)!
    expect(claimed.id).toBe(id)
    expect(claimed.status).toBe('running')
    expect(claimed.attempts).toBe(1)
    expect(claimed.startedAt).not.toBeNull()
    // The returned row is the stored row, not an optimistic guess.
    expect(getJob(db, id)).toEqual(claimed)
  })

  it('hands out jobs in enqueue order, one each', () => {
    const first = enqueueJob(db, 'discover').id
    const second = enqueueJob(db, 'backfill').id
    expect(claimNextJob(db)!.id).toBe(first)
    expect(claimNextJob(db)!.id).toBe(second)
    expect(claimNextJob(db)).toBeNull()
  })

  it('never hands the same job to a second caller', () => {
    enqueueJob(db, 'discover')
    expect(claimNextJob(db)).not.toBeNull()
    expect(claimNextJob(db)).toBeNull()
  })

  it('ignores running, done and failed jobs', () => {
    const running = enqueueJob(db, 'discover').id
    claimNextJob(db)
    const done = enqueueJob(db, 'discover').id
    claimNextJob(db)
    completeJob(db, done)
    const failed = enqueueJob(db, 'discover').id
    claimNextJob(db)
    failJob(db, failed, 'boom', { maxAttempts: 1 })
    expect(getJob(db, running)!.status).toBe('running')
    expect(claimNextJob(db)).toBeNull()
  })

  it('can be restricted to a subset of job types', () => {
    enqueueJob(db, 'discover')
    const deep = enqueueJob(db, 'deep_case').id
    expect(claimNextJob(db, { types: ['deep_case'] })!.id).toBe(deep)
    expect(claimNextJob(db, { types: ['deep_case'] })).toBeNull()
  })

  it('keeps the previous error visible while a retry is running', () => {
    const id = enqueueJob(db, 'deep_case').id
    claimNextJob(db)
    failJob(db, id, 'RateLimitedError', { maxAttempts: 3 })
    const retried = claimNextJob(db)!
    expect(retried.id).toBe(id)
    expect(retried.attempts).toBe(2)
    expect(retried.error).toBe('RateLimitedError')
  })
})

describe('completeJob', () => {
  it('marks the job done, stamps finished_at and clears a stale error', () => {
    const id = enqueueJob(db, 'deep_case').id
    claimNextJob(db)
    failJob(db, id, 'transient', { maxAttempts: 3 })
    claimNextJob(db)
    completeJob(db, id)
    const job = getJob(db, id)!
    expect(job.status).toBe('done')
    expect(job.finishedAt).not.toBeNull()
    expect(job.error).toBeNull()
  })

  it('ignores an unknown id instead of throwing', () => {
    expect(() => completeJob(db, 4242)).not.toThrow()
  })
})

describe('failJob', () => {
  it('returns the job to the queue while attempts remain', () => {
    const id = enqueueJob(db, 'deep_case').id
    claimNextJob(db)
    expect(failJob(db, id, 'HTTP 429', { maxAttempts: 3 })).toBe('retry')
    const job = getJob(db, id)!
    expect(job.status).toBe('pending')
    expect(job.error).toBe('HTTP 429')
    expect(job.attempts).toBe(1)
    // Pending means "not started"; the timestamps of the abandoned attempt
    // must not linger and make it look like it is still in flight.
    expect(job.startedAt).toBeNull()
    expect(job.finishedAt).toBeNull()
  })

  it('gives up once attempts reach the limit', () => {
    const id = enqueueJob(db, 'deep_case').id
    claimNextJob(db)
    expect(failJob(db, id, 'first', { maxAttempts: 2 })).toBe('retry')
    claimNextJob(db)
    expect(failJob(db, id, 'second', { maxAttempts: 2 })).toBe('failed')
    const job = getJob(db, id)!
    expect(job.status).toBe('failed')
    expect(job.attempts).toBe(2)
    expect(job.error).toBe('second')
    expect(job.finishedAt).not.toBeNull()
  })

  it('defaults to three attempts', () => {
    const id = enqueueJob(db, 'deep_case').id
    for (let i = 0; i < 2; i++) {
      claimNextJob(db)
      expect(failJob(db, id, `attempt ${i}`)).toBe('retry')
    }
    claimNextJob(db)
    expect(failJob(db, id, 'last')).toBe('failed')
  })

  it('reports a terminal failure for an unknown id rather than a phantom retry', () => {
    expect(failJob(db, 4242, 'boom')).toBe('failed')
  })
})

describe('listJobs / countJobsByStatus', () => {
  beforeEach(() => {
    enqueueJob(db, 'discover')
    const deep = enqueueJob(db, 'deep_case').id
    claimNextJob(db, { types: ['deep_case'] })
    completeJob(db, deep)
    enqueueJob(db, 'backfill')
  })

  it('lists every job by default, newest last', () => {
    expect(listJobs(db).map((j) => j.type)).toEqual(['discover', 'deep_case', 'backfill'])
  })

  it('filters by status and by type', () => {
    expect(listJobs(db, { status: 'pending' }).map((j) => j.type)).toEqual(['discover', 'backfill'])
    expect(listJobs(db, { type: 'deep_case' })).toHaveLength(1)
  })

  it('paginates', () => {
    expect(listJobs(db, { limit: 1, offset: 1 }).map((j) => j.type)).toEqual(['deep_case'])
  })

  it('counts every status, including the ones with no rows', () => {
    expect(countJobsByStatus(db)).toEqual({ pending: 2, running: 0, done: 1, failed: 0 })
  })
})

describe('schema guarantees', () => {
  it('rejects a status outside the four the code knows how to handle', () => {
    const id = enqueueJob(db, 'discover').id
    expect(() => db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('halfway', id))
      .toThrow(/CHECK constraint/)
  })

  it('adds the jobs table to a database created before it existed, keeping its rows', () => {
    // A pre-existing database built from the schema as it shipped before
    // `jobs` was introduced. `CREATE TABLE IF NOT EXISTS` covers a brand-new
    // table for free — this test is what proves it.
    const legacyPath = join(dir, 'legacy.db')
    const legacy = new Database(legacyPath)
    legacy.exec(`
      CREATE TABLE cases (
        id_processo_trf INTEGER PRIMARY KEY,
        number          TEXT NOT NULL UNIQUE,
        ca              TEXT,
        class_code      TEXT,
        class_name      TEXT,
        court           TEXT,
        panel           TEXT,
        distributed_at  TEXT,
        subjects_json   TEXT NOT NULL DEFAULT '[]',
        parties_json    TEXT NOT NULL DEFAULT '[]',
        summary_pdf_key TEXT,
        first_seen_at   TEXT NOT NULL,
        last_scraped_at TEXT NOT NULL
      );
      INSERT INTO cases (id_processo_trf, number, class_name, first_seen_at, last_scraped_at)
        VALUES (1, '0000000-00.2020.4.05.0000', 'OLD CLASS', datetime('now'), datetime('now'));
    `)
    legacy.close()

    const migrated = openDatabase(legacyPath)
    try {
      expect((migrated.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number }).n).toBe(1)
      const job = enqueueJob(migrated, 'backfill', { from: 1 })
      expect(claimNextJob(migrated)!.id).toBe(job.id)
    } finally {
      migrated.close()
    }
  })
})

/**
 * The claim has to be atomic across *processes*, not just across calls in
 * one process — the queue exists so that several workers can drain it at
 * once. Anything short of separate OS processes hitting the same file
 * through separate SQLite connections would prove nothing about the lock
 * that actually does the work here, so this test spawns real ones.
 */
describe('concurrent claiming', () => {
  const WORKERS = 4
  const JOBS = 200

  /** Runs one worker process to completion and returns the ids it claimed. */
  function runWorker(script: string, args: string[]): Promise<number[]> {
    return new Promise((resolve_, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', script, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c })
      child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr += c })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`worker exited ${code}: ${stderr}`))
        resolve_(JSON.parse(stdout) as number[])
      })
    })
  }

  const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 2000 && !predicate(); i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    if (!predicate()) throw new Error('timed out waiting for the workers to line up')
  }

  it('partitions the queue across parallel worker processes — every job claimed exactly once', async () => {
    const fill = db.transaction(() => {
      for (let i = 0; i < JOBS; i++) enqueueJob(db, 'deep_case', { i })
    })
    fill()
    db.close() // release this connection before the children pile on

    const script = resolve(import.meta.dirname, 'fixtures/claim-worker.ts')
    const goPath = join(dir, 'go')
    const readyPaths = Array.from({ length: WORKERS }, (_, i) => join(dir, `ready-${i}`))

    // Start every worker, wait until all of them are booted and holding at
    // the barrier, and only then let them go — so the claims genuinely
    // overlap instead of being serialised by process startup.
    const running = readyPaths.map((readyPath) => runWorker(script, [dbPath, readyPath, goPath]))
    await waitFor(() => readyPaths.every((p) => existsSync(p)))
    writeFileSync(goPath, '')

    const runs = await Promise.all(running)
    const claimed = runs.flat()

    // Exactly once: no id claimed twice (the failure this test exists for),
    // and none left behind.
    expect(new Set(claimed).size).toBe(claimed.length)
    expect(claimed).toHaveLength(JOBS)

    // And every worker actually got work, so "exactly once" above is not the
    // trivial result of one process winning the whole queue uncontended.
    expect(runs.map((ids) => ids.length).filter((n) => n > 0)).toHaveLength(WORKERS)

    db = openDatabase(dbPath)
    expect(countJobsByStatus(db)).toEqual({ pending: 0, running: 0, done: JOBS, failed: 0 })
    // One attempt each: a lost race must not show up as a silently re-run job.
    expect(listJobs(db).every((j) => j.attempts === 1)).toBe(true)
  })
})

describe('job types the worker executes', () => {
  it('accepts the engine-shaped types a worker dispatches on', () => {
    for (const type of ['crawl', 'deep_range'] as const) {
      expect(enqueueJob(db, type).type).toBe(type)
    }
    expect(listJobs(db).map((j) => j.type)).toEqual(['crawl', 'deep_range'])
  })
})

describe('progress', () => {
  it('starts at zero done with no total and no heartbeat', () => {
    const job = enqueueJob(db, 'crawl')
    expect(job.progress).toEqual({ done: 0, total: null, totalIsEstimate: false })
    expect(job.heartbeatAt).toBeNull()
  })

  it('records how far a running job has got, against a known total', () => {
    const id = enqueueJob(db, 'crawl', { fromId: 1, toId: 300 }).id
    claimNextJob(db)
    updateJobProgress(db, id, { done: 217, total: 300 })
    expect(getJob(db, id)!.progress).toEqual({ done: 217, total: 300, totalIsEstimate: false })
  })

  it('can mark the total an estimate, for a run with no known end', () => {
    const id = enqueueJob(db, 'crawl').id
    claimNextJob(db)
    updateJobProgress(db, id, { done: 4, total: 50, totalIsEstimate: true })
    expect(getJob(db, id)!.progress).toEqual({ done: 4, total: 50, totalIsEstimate: true })
  })

  it('keeps the total when a later update reports only the count', () => {
    const id = enqueueJob(db, 'deep_range', { fromId: 1, toId: 5 }).id
    claimNextJob(db)
    updateJobProgress(db, id, { done: 1, total: 5 })
    updateJobProgress(db, id, { done: 2 })
    expect(getJob(db, id)!.progress).toEqual({ done: 2, total: 5, totalIsEstimate: false })
  })

  it('is a sign of life: publishing progress refreshes the lease', () => {
    const id = enqueueJob(db, 'crawl').id
    claimNextJob(db)
    db.prepare("UPDATE jobs SET heartbeat_at = datetime('now', '-1 hour') WHERE id = ?").run(id)
    updateJobProgress(db, id, { done: 1 })
    expect(reclaimStaleJobs(db, { leaseMs: 60_000 })).toBe(0)
    expect(getJob(db, id)!.status).toBe('running')
  })

  it('ignores an update for a job that is no longer running', () => {
    const id = enqueueJob(db, 'crawl').id
    claimNextJob(db)
    completeJob(db, id)
    updateJobProgress(db, id, { done: 99 })
    expect(getJob(db, id)!.progress.done).toBe(0)
  })

  it('ignores an update from a worker whose attempt was reclaimed', () => {
    const id = enqueueJob(db, 'crawl', { fromId: 1, toId: 100 }).id
    const mine = claimNextJob(db)!
    updateJobProgress(db, id, { done: 7, total: 100 }, mine.attempts)

    // This worker goes quiet, the job is reclaimed, another worker takes it
    // and gets further than this one ever did.
    db.prepare("UPDATE jobs SET heartbeat_at = datetime('now', '-1 hour') WHERE id = ?").run(id)
    reclaimStaleJobs(db, { leaseMs: 60_000 })
    const theirs = claimNextJob(db)!
    updateJobProgress(db, id, { done: 40, total: 100 }, theirs.attempts)

    // The stale worker wakes up and publishes its own count. Dropping it is
    // the point: writing it would walk the number backwards on a screen
    // somebody is watching, and refresh a lease this worker no longer holds.
    updateJobProgress(db, id, { done: 8, total: 100 }, mine.attempts)
    expect(getJob(db, id)!.progress.done).toBe(40)
  })

  it('cannot keep a dead worker\'s lease alive from a previous attempt', () => {
    const id = enqueueJob(db, 'crawl').id
    const mine = claimNextJob(db)!
    db.prepare("UPDATE jobs SET heartbeat_at = datetime('now', '-1 hour') WHERE id = ?").run(id)
    reclaimStaleJobs(db, { leaseMs: 60_000 })
    claimNextJob(db)
    db.prepare("UPDATE jobs SET heartbeat_at = datetime('now', '-1 hour') WHERE id = ?").run(id)

    // The second worker has now died too. A report from the first must not
    // stand in for it, or the job stays running forever with nobody on it.
    updateJobProgress(db, id, { done: 3 }, mine.attempts)
    expect(reclaimStaleJobs(db, { leaseMs: 60_000 })).toBe(1)
  })
})

describe('heartbeatJob', () => {
  it('refreshes the lease and reports the job is still ours', () => {
    const id = enqueueJob(db, 'crawl').id
    claimNextJob(db)
    db.prepare("UPDATE jobs SET heartbeat_at = datetime('now', '-1 hour') WHERE id = ?").run(id)
    expect(heartbeatJob(db, id)).toBe(true)
    expect(reclaimStaleJobs(db, { leaseMs: 60_000 })).toBe(0)
  })

  it('reports false once the job has been taken away or finished', () => {
    const id = enqueueJob(db, 'crawl').id
    claimNextJob(db)
    completeJob(db, id)
    expect(heartbeatJob(db, id)).toBe(false)
    expect(heartbeatJob(db, 4242)).toBe(false)
  })
})

describe('claimNextJob leases the job it hands out', () => {
  it('stamps a heartbeat, so a fresh claim is never stale', () => {
    enqueueJob(db, 'crawl')
    const claimed = claimNextJob(db)!
    expect(claimed.heartbeatAt).not.toBeNull()
    expect(reclaimStaleJobs(db, { leaseMs: 60_000 })).toBe(0)
  })
})

describe('releaseJob', () => {
  it('returns an interrupted job to the queue without charging the attempt', () => {
    const id = enqueueJob(db, 'crawl').id
    claimNextJob(db)
    updateJobProgress(db, id, { done: 12, total: 300 })
    expect(releaseJob(db, id, 'interrupted')).toBe(true)
    const job = getJob(db, id)!
    expect(job.status).toBe('pending')
    expect(job.attempts).toBe(0)
    expect(job.startedAt).toBeNull()
    expect(job.finishedAt).toBeNull()
    expect(job.heartbeatAt).toBeNull()
    expect(job.error).toBe('interrupted')
    // The count belonged to the attempt that was cut short; leaving it would
    // render a queued job as though it were already part-way through.
    expect(job.progress).toEqual({ done: 0, total: 300, totalIsEstimate: false })
  })

  it('is claimable again straight away', () => {
    const id = enqueueJob(db, 'crawl').id
    claimNextJob(db)
    releaseJob(db, id, 'interrupted')
    expect(claimNextJob(db)!.id).toBe(id)
  })

  it('does nothing to a job that is not running', () => {
    const id = enqueueJob(db, 'crawl').id
    expect(releaseJob(db, id, 'interrupted')).toBe(false)
    expect(getJob(db, id)!.status).toBe('pending')
    expect(releaseJob(db, 4242, 'interrupted')).toBe(false)
  })
})

describe('reclaimStaleJobs', () => {
  const strand = (id: number, ago: string): void => {
    db.prepare(`UPDATE jobs SET heartbeat_at = datetime('now', ?) WHERE id = ?`).run(ago, id)
  }

  it('leaves a job whose worker is still checking in alone', () => {
    enqueueJob(db, 'crawl')
    claimNextJob(db)
    expect(reclaimStaleJobs(db, { leaseMs: 60_000 })).toBe(0)
  })

  it('returns a job whose worker stopped checking in to the queue', () => {
    const id = enqueueJob(db, 'crawl').id
    claimNextJob(db)
    updateJobProgress(db, id, { done: 40, total: 300 })
    strand(id, '-10 minutes')
    expect(reclaimStaleJobs(db, { leaseMs: 60_000 })).toBe(1)
    const job = getJob(db, id)!
    expect(job.status).toBe('pending')
    expect(job.startedAt).toBeNull()
    expect(job.heartbeatAt).toBeNull()
    expect(job.progress.done).toBe(0)
    expect(job.error).toMatch(/lease/i)
    // The attempt is still charged: nothing here proves the job is innocent
    // of whatever killed the worker holding it.
    expect(job.attempts).toBe(1)
    expect(claimNextJob(db)!.id).toBe(id)
  })

  it('gives up on a job that has burned every attempt this way', () => {
    const id = enqueueJob(db, 'crawl').id
    claimNextJob(db)
    strand(id, '-10 minutes')
    expect(reclaimStaleJobs(db, { leaseMs: 60_000, maxAttempts: 1 })).toBe(1)
    const job = getJob(db, id)!
    expect(job.status).toBe('failed')
    expect(job.finishedAt).not.toBeNull()
    expect(claimNextJob(db)).toBeNull()
  })

  it('rescues a job stranded by a worker too old to have left a heartbeat', () => {
    const id = enqueueJob(db, 'crawl').id
    claimNextJob(db)
    db.prepare("UPDATE jobs SET heartbeat_at = NULL, started_at = datetime('now', '-10 minutes') WHERE id = ?").run(id)
    expect(reclaimStaleJobs(db, { leaseMs: 60_000 })).toBe(1)
    expect(getJob(db, id)!.status).toBe('pending')
  })

  it('never touches a pending, done or failed job', () => {
    const pending = enqueueJob(db, 'crawl').id
    const done = enqueueJob(db, 'crawl').id
    claimNextJob(db, { types: ['crawl'] })
    claimNextJob(db, { types: ['crawl'] })
    completeJob(db, done)
    db.prepare("UPDATE jobs SET heartbeat_at = datetime('now', '-10 minutes')").run()
    expect(reclaimStaleJobs(db, { leaseMs: 60_000 })).toBe(1)
    expect(getJob(db, pending)!.status).toBe('pending')
    expect(getJob(db, done)!.status).toBe('done')
  })
})

describe('finishing a job drops its lease', () => {
  it('clears the heartbeat on completion and on terminal failure', () => {
    const doneId = enqueueJob(db, 'crawl').id
    claimNextJob(db)
    completeJob(db, doneId)
    expect(getJob(db, doneId)!.heartbeatAt).toBeNull()

    const failedId = enqueueJob(db, 'crawl').id
    claimNextJob(db)
    failJob(db, failedId, 'boom', { maxAttempts: 1 })
    expect(getJob(db, failedId)!.heartbeatAt).toBeNull()
  })

  it('clears the heartbeat when a failure sends the job back to the queue', () => {
    const id = enqueueJob(db, 'crawl').id
    claimNextJob(db)
    failJob(db, id, 'transient', { maxAttempts: 3 })
    expect(getJob(db, id)!.heartbeatAt).toBeNull()
  })
})

describe('heartbeatJob identifies the attempt, not just the job', () => {
  it('refuses to renew a lease on an attempt that is no longer this worker’s', () => {
    const id = enqueueJob(db, 'crawl').id
    const mine = claimNextJob(db)!
    // The lease goes cold, a reclaimer frees the job, and somebody else
    // takes it. The row is `running` again — but not for us.
    db.prepare("UPDATE jobs SET heartbeat_at = datetime('now', '-1 hour') WHERE id = ?").run(id)
    expect(reclaimStaleJobs(db, { leaseMs: 60_000 })).toBe(1)
    const theirs = claimNextJob(db)!
    expect(theirs.attempts).toBe(mine.attempts + 1)

    expect(heartbeatJob(db, id, mine.attempts)).toBe(false)
    expect(heartbeatJob(db, id, theirs.attempts)).toBe(true)
  })
})
