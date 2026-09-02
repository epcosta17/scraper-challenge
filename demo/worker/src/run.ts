import { openDatabase, FsBlobStore } from '@pje/core'
import { HttpClient, createReporter, type Reporter } from '@pje/scraper'
import { createWorker, type Worker } from './worker.ts'
import { parseWorkerArgs, helpText, ArgsError } from './cli/args.ts'
import { workerHeader, workerSummaryLines } from './format.ts'
import { WORKER_VERSION } from './version.ts'

export interface MainOptions {
  /** Overrides the network transport — the seam a test uses to stand in for the portal. */
  fetchImpl?: typeof fetch
}

/** How long the second Ctrl-C waits for its own last line to reach the terminal before exiting. */
const GOODBYE_MS = 100

/**
 * The two-stage Ctrl-C, and why it is two.
 *
 * Neither `crawl` nor `deepCase` can be cancelled — they take no abort
 * signal, and the requests they have in flight will finish when the portal
 * decides they finish. So a stop is a choice between two honest behaviours,
 * and the operator makes it:
 *
 *  - Once: stop claiming anything new and let the job in flight finish
 *    normally. Nothing is wasted and nothing is left half-done. On a `deep`
 *    of a forty-document case that can take a while, which is why there is
 *    a second stage at all.
 *  - Again: hand the running job straight back to the queue and go. The
 *    request in flight is abandoned mid-air, but the *job* is not lost —
 *    `releaseJob` has already committed it back to `pending` before the
 *    process exits, with its attempt refunded, so the next worker picks it
 *    up from the start. Both engines are resumable and skip what is already
 *    stored, so redoing it costs far less than the whole job.
 *
 * The one thing that must never happen is the job being left `running` with
 * nobody working on it, which is what a plain `process.exit` would do.
 *
 * `exit` is injected so the sequencing above can be tested without actually
 * ending the test runner.
 */
export function createShutdownHandler(o: {
  worker: Worker
  reporter: Reporter
  exit: (code: number) => void
}): (signal: string) => void {
  let count = 0
  return (signal) => {
    count++
    const jobId = o.worker.currentJobId

    if (count === 1) {
      o.reporter.note(
        jobId === null
          ? `\n${signal} — nothing in flight; stopping.`
          : `\n${signal} — letting job ${jobId} finish first. ` +
            'Press Ctrl-C again to hand it back to the queue and stop now.',
      )
      o.worker.drain()
      return
    }

    o.worker.abandon(`Interrupted by ${signal}; the attempt did not finish.`)
    o.reporter.note(`${signal} again — stopping now.`)
    o.exit(130)
  }
}

/**
 * The worker as a program. Importable and side-effect-free at module scope
 * so a test can drive it directly — `cli.ts` is the only thing that invokes
 * it, for the same reason the scraper CLI is split that way.
 *
 * Everything printed while working goes to stderr through the reporter;
 * stdout is written exactly once, at the end, with the run's summary.
 */
export async function main(argv: string[], opts: MainOptions = {}): Promise<number> {
  try {
    if (argv[0] === '--help' || argv[0] === '-h') {
      console.log(helpText())
      return 0
    }
    if (argv[0] === '--version' || argv[0] === '-v') {
      console.log(WORKER_VERSION)
      return 0
    }

    const args = parseWorkerArgs(argv)
    const reporter = createReporter({
      level: args.quiet ? 'quiet' : args.verbose ? 'verbose' : 'normal',
    })

    const db = openDatabase(args.db)
    const blobs = new FsBlobStore(args.out)
    const client = new HttpClient({
      rps: args.rps,
      fetchImpl: opts.fetchImpl,
      onEvent: (e) => reporter.http(e),
    })

    const worker = createWorker({ db, blobs, client }, {
      types: args.types,
      watch: args.watch,
      pollIntervalMs: args.pollIntervalMs,
      maxJobs: args.maxJobs,
      concurrency: args.concurrency,
      maxAttempts: args.maxAttempts,
      leaseMs: args.leaseMs,
      reporter,
    })

    const onSignal = createShutdownHandler({
      worker,
      reporter,
      // A ref'd timer, not a bare `process.exit`: the line above may still
      // be in stderr's buffer (writes to a pipe are asynchronous), and the
      // request in flight keeps the loop alive long enough for this to fire.
      exit: (code) => { setTimeout(() => process.exit(code), GOODBYE_MS) },
    })
    const sigint = () => onSignal('SIGINT')
    const sigterm = () => onSignal('SIGTERM')
    process.on('SIGINT', sigint)
    process.on('SIGTERM', sigterm)

    reporter.header(workerHeader({
      db: args.db, out: args.out, types: args.types, watch: args.watch, rps: args.rps,
    }))

    try {
      const summary = await worker.run()
      console.log(args.json ? JSON.stringify(summary, null, 2) : workerSummaryLines(summary))
      // An interrupted run is not a clean one even when nothing failed: 130
      // is what a shell expects back from a command it stopped, and it keeps
      // "you stopped it" distinguishable from "it finished the queue".
      if (summary.stopped === 'interrupted') return 130
      return summary.failed > 0 ? 1 : 0
    } finally {
      process.off('SIGINT', sigint)
      process.off('SIGTERM', sigterm)
      db.close()
    }
  } catch (err) {
    if (err instanceof ArgsError) {
      console.error(`error: ${err.message}`)
      return 2
    }
    console.error(err)
    return 1
  }
}
