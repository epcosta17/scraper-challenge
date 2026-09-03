import type { APIRoute } from 'astro'
import { data, runner } from '../data/index.ts'

/**
 * What the queue looks like right now, for the pages that poll while a worker
 * is running.
 *
 * It exists because the alternative is a screen that goes quiet the moment it
 * matters: a capture takes minutes, the worker reports its progress into the
 * job row as it goes, and a server-rendered page would show none of that until
 * somebody thought to reload. So the markup is still rendered on the server —
 * this only refreshes the few numbers that move.
 *
 * Read-only, and cheap on purpose: a handful of rows and their counters, no
 * document text, nothing that grows with the size of the acervo.
 */
export const GET: APIRoute = async () => {
  const overview = await data.captureOverview()
  const worker = runner.state()

  return new Response(
    JSON.stringify({
      // Whether anything is still moving. The page stops polling when this is
      // false, so a finished queue costs nothing to sit in front of.
      active: worker.running || overview.jobs.some((j) => j.state === 'running' || j.state === 'queued'),
      worker: {
        // A job in flight means *a* worker is draining the queue, whether or
        // not this server is the one that started it. In the container the
        // worker is a sibling process and never ours, so reporting only what
        // we spawned had the screen saying "Sin worker" over a queue that was
        // visibly moving.
        running: worker.running || overview.jobs.some((j) => j.state === 'running'),
        ours: worker.running,
        startedAt: worker.startedAt,
        lastExit: worker.lastExit,
      },
      counts: {
        running: overview.runningJobs,
        queued: overview.queuedJobs,
        casesToday: overview.casesToday,
        documentsToday: overview.documentsToday,
        openFailures: overview.openFailures,
      },
      jobs: overview.jobs.map((j) => ({
        id: j.id,
        kind: j.kind,
        target: j.target,
        state: j.state,
        attempts: j.attempts,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
        error: j.error,
        progress: j.progress,
        stage: j.stage,
      })),
    }),
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        // A poll must never be answered from a cache, or the screen freezes
        // while the work carries on behind it.
        'cache-control': 'no-store',
      },
    },
  )
}
