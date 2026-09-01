import type { LogLevel } from './args.ts'
import type { DeepStepEvent, DeepDocumentProgress, DeepCaseOutcome } from '../crawl/deep.ts'
import type { CrawlProgress } from '../crawl/enumerate.ts'
import type { HttpEvent } from '../http/client.ts'
import {
  deepStepLine, deepDocumentProgressLine, deepCaseProgressLine,
  progressLine, crawlFailureLine, crawlPeriodicProgressLine, httpEventLine,
} from './format.ts'

/**
 * How often the default level proves a `crawl` is still alive. A fixed time
 * interval, not a fixed number of ids: throughput swings a lot with
 * `--concurrency` and how often the portal 429s, so counting ids cannot
 * bound how long the terminal stays silent the way a wall clock does.
 */
const CRAWL_HEARTBEAT_MS = 2000

export interface ReporterOptions {
  level: LogLevel
  /** Where lines go. Always stderr in production — stdout carries the result and nothing else. */
  write?: (line: string) => void
  /** Identifies the case a line belongs to; see `DeepStepEvent`. Defaults to the bare ref. */
  tagFor?: (ref: string) => string
  /** Injectable clock, so the heartbeat above is testable without waiting for it. */
  now?: () => number
}

export interface Reporter {
  /** The one line a run opens with: what it is about to do. */
  header(line: string): void
  /** A step a command narrates for itself, where there is no event type for it (see `search` in `run.ts`). */
  note(line: string): void
  /** An aside that belongs with the request-level detail: printed under `--verbose` only. */
  detail(line: string): void
  deepStep(e: DeepStepEvent): void
  deepDocument(p: DeepDocumentProgress): void
  deepCase(o: DeepCaseOutcome): void
  crawlProgress(p: CrawlProgress): void
  http(e: HttpEvent): void
}

/**
 * Turns progress events into lines, and decides which of them the chosen
 * `--quiet`/default/`--verbose` level actually prints. Every level rule
 * lives here rather than at the call sites, so "does this get printed?" is
 * answered in one place instead of once per callback in `run.ts`.
 *
 * The three levels, and what each is for:
 *  - `quiet`: nothing. A scheduled run whose stderr nobody reads until the
 *    exit code says to.
 *  - `normal`: what the run is *trying to do*, step by step, as each step
 *    starts — plus anything that failed or is being retried, at the moment
 *    it happens. Per-document and per-id chatter stays out, except failures.
 *  - `verbose`: the same, plus the individual documents and the requests
 *    underneath (URLs, status codes, backoff, 429s).
 */
export function createReporter(opts: ReporterOptions): Reporter {
  const write = opts.write ?? ((line: string) => console.error(line))
  const tagFor = opts.tagFor ?? ((ref: string) => `[${ref}]`)
  const now = opts.now ?? Date.now
  const quiet = opts.level === 'quiet'
  const verbose = opts.level === 'verbose'

  let checked = 0
  let lastBeatAt = now()

  const emit = (line: string): void => {
    if (!quiet) write(line)
  }

  return {
    header: emit,
    note: emit,

    detail(line) {
      if (verbose) emit(line)
    },

    deepStep(e) {
      emit(deepStepLine(e, tagFor(e.ref)))
    },

    deepDocument(p) {
      // A stored or skipped document is detail; a failed one is news.
      if (!verbose && p.outcome !== 'failed') return
      emit(deepDocumentProgressLine(p, tagFor(String(p.idProcessoTrf))))
    },

    deepCase(o) {
      emit(deepCaseProgressLine(o, tagFor(o.kind === 'done' ? String(o.idProcessoTrf) : o.ref)))
    },

    crawlProgress(p) {
      checked++
      if (verbose) {
        // The per-id line already carries the reason a failure failed, so a
        // separate failure line here would only say it twice.
        emit(progressLine(p))
        return
      }
      if (p.outcome === 'failed') {
        emit(crawlFailureLine(p))
        return
      }
      const at = now()
      if (at - lastBeatAt >= CRAWL_HEARTBEAT_MS) {
        lastBeatAt = at
        emit(crawlPeriodicProgressLine({ checked, id: p.id, stored: p.stored, absent: p.absent, failed: p.failed, number: p.number }))
      }
    },

    http(e) {
      if (!verbose) return
      emit(httpEventLine(e))
    },
  }
}
