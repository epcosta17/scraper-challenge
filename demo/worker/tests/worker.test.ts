import { describe, it, expect, beforeEach } from 'vitest'
import {
  enqueueJob, getJob, listJobs, countJobsByStatus, claimNextJob, reclaimStaleJobs,
} from '@pje/core'
import { createWorker, type WorkerDeps } from '../src/worker.ts'
import type { JobHandler } from '../src/handlers.ts'
import { tempWorkspace, recordingReporter, offlineClient, stubEngine } from './helpers.ts'

let ws: ReturnType<typeof tempWorkspace>
let reporter: ReturnType<typeof recordingReporter>
let deps: WorkerDeps

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

beforeEach(() => {
  ws = tempWorkspace()
  reporter = recordingReporter()
  deps = { db: ws.db, blobs: ws.blobs, client: offlineClient(), engine: stubEngine() }
  return () => ws.close()
})

/** A handler that records the jobs it ran and answers with a fixed line. */
function spyHandler(): JobHandler & { ran: number[] } {
  const ran: number[] = []
  const handler = (async (_d, ctx) => { ran.push(ctx.job.id); return 'ok' }) as JobHandler & { ran: number[] }
  handler.ran = ran
  return handler
}

describe('draining the queue', () => {
  it('runs every pending job in order and stops when the queue is empty', async () => {
    const handler = spyHandler()
    const ids = [
      enqueueJob(ws.db, 'crawl', { fromId: 1, toId: 2 }).id,
      enqueueJob(ws.db, 'crawl', { fromId: 3, toId: 4 }).id,
      enqueueJob(ws.db, 'crawl', { fromId: 5, toId: 6 }).id,
    ]

    const summary = await createWorker(deps, { reporter, handlers: { crawl: handler } }).run()

    expect(handler.ran).toEqual(ids)
    expect(summary).toMatchObject({ claimed: 3, done: 3, failed: 0, stopped: 'drained' })
    expect(countJobsByStatus(ws.db)).toEqual({ pending: 0, running: 0, done: 3, failed: 0 })
  })

  it('does nothing at all, quietly, when there is nothing queued', async () => {
    const summary = await createWorker(deps, { reporter }).run()
    expect(summary).toMatchObject({ claimed: 0, done: 0, stopped: 'drained' })
  })

  it('claims only the types it was asked for', async () => {
    enqueueJob(ws.db, 'crawl', { fromId: 1, toId: 2 })
    const deep = enqueueJob(ws.db, 'deep_case', { idProcessoTrf: 5 }).id
    const handler = spyHandler()

    await createWorker(deps, { reporter, types: ['deep_case'], handlers: { deep_case: handler } }).run()

    expect(handler.ran).toEqual([deep])
    expect(countJobsByStatus(ws.db)).toEqual({ pending: 1, running: 0, done: 1, failed: 0 })
  })

  it('stops after --max-jobs, leaving the rest queued', async () => {
    for (let i = 0; i < 4; i++) enqueueJob(ws.db, 'crawl', { fromId: i + 1, toId: i + 1 })
    const handler = spyHandler()

    const summary = await createWorker(deps, { reporter, maxJobs: 2, handlers: { crawl: handler } }).run()

    expect(handler.ran).toHaveLength(2)
    expect(summary.stopped).toBe('max_jobs')
    expect(countJobsByStatus(ws.db)).toMatchObject({ pending: 2, done: 2 })
  })

  it('leaves a second worker the jobs the first did not take', async () => {
    for (let i = 0; i < 4; i++) enqueueJob(ws.db, 'crawl', { fromId: i + 1, toId: i + 1 })
    const first = spyHandler()
    const second = spyHandler()

    await createWorker(deps, { reporter, maxJobs: 2, handlers: { crawl: first } }).run()
    await createWorker(deps, { reporter, handlers: { crawl: second } }).run()

    expect([...first.ran, ...second.ran]).toHaveLength(4)
    expect(new Set([...first.ran, ...second.ran]).size).toBe(4)
  })
})

describe('a job that fails', () => {
  it('goes back in the queue while attempts remain, and the worker carries on', async () => {
    const bad = enqueueJob(ws.db, 'crawl', { fromId: 1, toId: 1 }).id
    const good = enqueueJob(ws.db, 'deep_case', { idProcessoTrf: 2 }).id
    let attempts = 0
    const handler = spyHandler()

    const summary = await createWorker(deps, {
      reporter,
      maxAttempts: 3,
      handlers: {
        crawl: async () => {
          attempts++
          if (attempts < 3) throw new Error('the portal said no')
          return 'ok on the third go'
        },
        deep_case: handler,
      },
    }).run()

    // Two failures, both of which put the job back at the head of the queue,
    // and a third attempt that worked — with the worker still going, and the
    // job behind it still run.
    expect(attempts).toBe(3)
    expect(handler.ran).toEqual([good])
    expect(summary).toMatchObject({ claimed: 4, done: 2, failed: 0, retried: 2 })
    expect(getJob(ws.db, bad)!.status).toBe('done')
    expect(getJob(ws.db, bad)!.attempts).toBe(3)
  })

  it('holds the head of the queue until its attempts are spent, then moves on', async () => {
    const bad = enqueueJob(ws.db, 'crawl', { fromId: 1, toId: 1 }).id
    const good = enqueueJob(ws.db, 'deep_case', { idProcessoTrf: 2 }).id
    const order: number[] = []

    await createWorker(deps, {
      reporter,
      maxAttempts: 2,
      handlers: {
        crawl: async (_d, ctx) => { order.push(ctx.job.id); throw new Error('the portal said no') },
        deep_case: async (_d, ctx) => { order.push(ctx.job.id); return 'ok' },
      },
    }).run()

    // A returned job is `pending` with the lowest id, so it is the very next
    // thing claimed — the queue is strictly FIFO and there is no delay
    // between attempts to schedule with.
    expect(order).toEqual([bad, bad, good])
    expect(getJob(ws.db, bad)!.status).toBe('failed')
  })

  it('does not retry a job that is simply malformed', async () => {
    // Every attempt would fail the same way, so retrying only delays the
    // queue behind it and dresses a permanent mistake up as bad luck.
    const id = enqueueJob(ws.db, 'crawl', { fron: 10 } as never).id
    const summary = await createWorker(deps, { reporter, maxAttempts: 3 }).run()

    expect(summary).toMatchObject({ claimed: 1, failed: 1, retried: 0 })
    const job = getJob(ws.db, id)!
    expect(job.status).toBe('failed')
    expect(job.attempts).toBe(1)
    expect(job.error).toMatch(/fron/)
  })

  it('is given up on once its attempts run out, without blocking the queue', async () => {
    const bad = enqueueJob(ws.db, 'crawl', { fromId: 1, toId: 1 }).id

    const summary = await createWorker(deps, {
      reporter,
      maxAttempts: 1,
      handlers: { crawl: async () => { throw new Error('malformed PDF') } },
    }).run()

    expect(summary).toMatchObject({ failed: 1, done: 0 })
    expect(getJob(ws.db, bad)!.status).toBe('failed')
    expect(countJobsByStatus(ws.db)).toEqual({ pending: 0, running: 0, done: 0, failed: 1 })
  })

  it('fails a job whose type nothing knows how to run, rather than crashing', async () => {
    // The `type` column carries no CHECK on purpose, so a row like this is
    // reachable from any enqueuer that is ahead of this worker's build.
    ws.db.prepare(`
      INSERT INTO jobs (type, payload_json, status, attempts, created_at)
      VALUES ('teleport', '{}', 'pending', 0, datetime('now'))
    `).run()

    const summary = await createWorker(deps, { reporter, maxAttempts: 1 }).run()

    expect(summary).toMatchObject({ claimed: 1, failed: 1 })
    expect(listJobs(ws.db)[0]!.error).toMatch(/teleport/)
  })
})

describe('progress', () => {
  it('reaches the job row while the job is still running, and the last count survives it', async () => {
    const id = enqueueJob(ws.db, 'crawl', { fromId: 1, toId: 3 }).id
    let midFlight: number | undefined

    await createWorker(deps, {
      reporter,
      progressIntervalMs: 0,
      handlers: {
        crawl: async (_d, ctx) => {
          ctx.publish({ done: 0, total: 300 })
          ctx.publish({ done: 217 })
          midFlight = getJob(ws.db, id)!.progress.done
          ctx.publish({ done: 300 })
          return 'ok'
        },
      },
    }).run()

    expect(midFlight).toBe(217)
    expect(getJob(ws.db, id)!.progress).toEqual({ done: 300, total: 300, totalIsEstimate: false })
  })
})

describe('watching for new work', () => {
  it('keeps polling an empty queue and picks up a job enqueued later', async () => {
    const handler = spyHandler()
    const worker = createWorker(deps, { reporter, watch: true, pollIntervalMs: 5, handlers: { crawl: handler } })
    const running = worker.run()

    await delay(30)
    const late = enqueueJob(ws.db, 'crawl', { fromId: 1, toId: 1 }).id
    await delay(50)
    worker.drain()

    const summary = await running
    expect(handler.ran).toEqual([late])
    expect(summary.stopped).toBe('interrupted')
  })

  it('stops promptly when asked, instead of sitting out the poll interval', async () => {
    const worker = createWorker(deps, { reporter, watch: true, pollIntervalMs: 60_000 })
    const running = worker.run()
    await delay(10)
    worker.drain()
    await expect(running).resolves.toMatchObject({ stopped: 'interrupted' })
  })
})

describe('an interrupted worker', () => {
  it('hands its in-flight job back to the queue without charging the attempt', async () => {
    const id = enqueueJob(ws.db, 'crawl', { fromId: 1, toId: 1 }).id
    let released: boolean | undefined
    let worker: ReturnType<typeof createWorker>

    worker = createWorker(deps, {
      reporter,
      handlers: {
        crawl: async (_d, ctx) => {
          ctx.publish({ done: 5, total: 10 })
          // Ctrl-C lands while the request is in flight.
          released = worker.abandon('Interrupted by SIGINT before this attempt finished.')
          await delay(10)
          return 'ok'
        },
      },
    })

    const summary = await worker.run()

    expect(released).toBe(true)
    const job = getJob(ws.db, id)!
    expect(job.status).toBe('pending')
    expect(job.attempts).toBe(0)
    expect(job.progress.done).toBe(0)
    expect(job.error).toMatch(/SIGINT/)
    // The handler returning afterwards must not mark the released job done.
    expect(summary).toMatchObject({ done: 0, abandoned: 1, stopped: 'interrupted' })
    expect(claimNextJob(ws.db)!.id).toBe(id)
  })

  it('does not claim anything further', async () => {
    enqueueJob(ws.db, 'crawl', { fromId: 1, toId: 1 })
    enqueueJob(ws.db, 'crawl', { fromId: 2, toId: 2 })
    const handler = spyHandler()
    let worker: ReturnType<typeof createWorker>

    worker = createWorker(deps, {
      reporter,
      handlers: {
        crawl: async (d, ctx) => {
          worker.drain()
          return handler(d, ctx)
        },
      },
    })
    await worker.run()

    expect(handler.ran).toHaveLength(1)
    expect(countJobsByStatus(ws.db)).toMatchObject({ pending: 1, done: 1 })
  })

  it('has nothing to hand back when it is between jobs', async () => {
    const worker = createWorker(deps, { reporter, watch: true, pollIntervalMs: 5 })
    const running = worker.run()
    await delay(10)
    expect(worker.abandon('SIGINT')).toBe(false)
    await running
  })
})

describe('leases', () => {
  it('frees jobs stranded by a worker that was killed, before claiming its own', async () => {
    const stranded = enqueueJob(ws.db, 'crawl', { fromId: 1, toId: 1 }).id
    claimNextJob(ws.db)
    ws.db.prepare("UPDATE jobs SET heartbeat_at = datetime('now', '-1 hour') WHERE id = ?").run(stranded)
    const handler = spyHandler()

    const summary = await createWorker(deps, {
      reporter, leaseMs: 60_000, handlers: { crawl: handler },
    }).run()

    expect(summary.reclaimed).toBe(1)
    expect(handler.ran).toEqual([stranded])
    expect(getJob(ws.db, stranded)!.status).toBe('done')
  })

  it('keeps renewing its own lease while a long job runs', async () => {
    enqueueJob(ws.db, 'crawl', { fromId: 1, toId: 1 })
    let reclaimedMidJob: number | undefined

    await createWorker(deps, {
      reporter,
      heartbeatIntervalMs: 5,
      handlers: {
        crawl: async () => {
          // Backdate the lease as though this worker had been stalled, then
          // give the heartbeat a few ticks to put it right again.
          ws.db.prepare("UPDATE jobs SET heartbeat_at = datetime('now', '-1 hour')").run()
          await delay(40)
          reclaimedMidJob = reclaimStaleJobs(ws.db, { leaseMs: 60_000 })
          return 'ok'
        },
      },
    }).run()

    expect(reclaimedMidJob).toBe(0)
  })

  it('does not mark a job done once another worker has taken it over', async () => {
    const id = enqueueJob(ws.db, 'crawl', { fromId: 1, toId: 1 }).id

    const summary = await createWorker(deps, {
      reporter,
      // No heartbeat during the job, so the lease genuinely goes cold.
      heartbeatIntervalMs: 60_000,
      handlers: {
        crawl: async () => {
          ws.db.prepare("UPDATE jobs SET heartbeat_at = datetime('now', '-1 hour')").run()
          reclaimStaleJobs(ws.db, { leaseMs: 60_000 })
          claimNextJob(ws.db)
          return 'ok'
        },
      },
    }).run()

    expect(summary).toMatchObject({ done: 0, lost: 1 })
    // Still the other worker's, still running — not silently marked done.
    const job = getJob(ws.db, id)!
    expect(job.status).toBe('running')
    expect(job.attempts).toBe(2)
  })
})
