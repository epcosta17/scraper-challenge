import type { JobProgressUpdate } from '@pje/core'

/** How often a running job's progress reaches SQLite, at most. */
export const DEFAULT_PROGRESS_INTERVAL_MS = 250

export interface ProgressPublisher {
  /** Report where the job has got to. May be held; see `createProgressPublisher`. */
  publish(p: JobProgressUpdate): void
  /** Write whatever is being held. Call once the job is over. */
  flush(): void
}

export interface ProgressPublisherOptions {
  write: (p: JobProgressUpdate) => void
  /** 0 writes every report. */
  minIntervalMs?: number
  now?: () => number
}

/**
 * Rate-limits progress reports on their way to the database.
 *
 * The engine reports per id and per document, so a 5,000-id crawl would
 * otherwise be 5,000 `UPDATE`s — each one a WAL commit, on the same file
 * every other worker is trying to take the write lock on to claim its next
 * job. The reports are also pure overwrite: a dashboard reading "217" has no
 * use for the fact that 216 happened, so a report overtaken inside the
 * interval is not delayed, it is *dropped*, and only the newest count is
 * ever written.
 *
 * Two rules make that safe to do:
 *  - the first report always goes out, so the total a job knows up front
 *    appears immediately rather than a quarter of a second into the run;
 *  - `flush` writes whatever is still held, so the final count is never one
 *    of the ones dropped.
 *
 * A total reported once is remembered and re-sent with every later count.
 * The engine's per-id callbacks carry no denominator — only the handler
 * knows it, and only at the start — so without this the second write would
 * silently mean "total unchanged" to `updateJobProgress` and this publisher
 * would depend on that. Carrying it explicitly keeps each write a complete
 * statement of where the job is.
 */
export function createProgressPublisher(opts: ProgressPublisherOptions): ProgressPublisher {
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS
  const now = opts.now ?? Date.now

  let held: JobProgressUpdate | null = null
  let lastWriteAt = Number.NEGATIVE_INFINITY
  let total: number | null | undefined
  let totalIsEstimate: boolean | undefined

  const send = (p: JobProgressUpdate): void => {
    held = null
    lastWriteAt = now()
    opts.write(p)
  }

  return {
    publish(p) {
      if (p.total !== undefined) total = p.total
      if (p.totalIsEstimate !== undefined) totalIsEstimate = p.totalIsEstimate
      const full: JobProgressUpdate = { done: p.done }
      if (total !== undefined) full.total = total
      if (totalIsEstimate !== undefined) full.totalIsEstimate = totalIsEstimate

      if (now() - lastWriteAt >= minIntervalMs) send(full)
      else held = full
    },

    flush() {
      if (held !== null) send(held)
    },
  }
}
