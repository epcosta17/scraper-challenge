import type { JobType } from '@pje/core'
import { HANDLERS } from '../handlers.ts'

export class ArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArgsError'
  }
}

/** Every type this build has a handler for — the same list the worker dispatches on. */
const KNOWN_TYPES = Object.keys(HANDLERS) as JobType[]

export interface WorkerArgs {
  db: string
  out: string
  /** Undefined means "whatever is next", which is the useful default for a single worker. */
  types?: JobType[]
  watch: boolean
  pollIntervalMs: number
  maxJobs?: number
  concurrency: number
  rps: number
  leaseMs: number
  maxAttempts: number
  json: boolean
  quiet: boolean
  verbose: boolean
}

/**
 * Defaults chosen to match the scraper CLI's, so the same run does the same
 * thing whichever of the two starts it: the same database, the same blob
 * root, the same 2 req/s against a portal that 429s, the same 4 workers in
 * flight inside one job.
 */
function defaults(): WorkerArgs {
  return {
    db: 'data/pje.db',
    out: 'data/pdfs',
    watch: false,
    pollIntervalMs: 1000,
    concurrency: 4,
    rps: 2,
    leaseMs: 60_000,
    maxAttempts: 3,
    json: false,
    quiet: false,
    verbose: false,
  }
}

export function parseWorkerArgs(argv: string[]): WorkerArgs {
  const out = defaults()

  const value = (flag: string, i: number): string => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new ArgsError(`${flag} requires a value.`)
    return v
  }
  // Same rule, and the same reason, as the scraper CLI's: `--concurrency 0`
  // or `--max-jobs 0` passes `Number.isFinite` and then silently turns the
  // run into a no-op that exits 0 as though it had worked.
  const positiveInt = (flag: string, raw: string): number => {
    const n = Number(raw)
    if (!Number.isInteger(n) || n <= 0) {
      throw new ArgsError(`${flag} requires a positive integer, got "${raw}".`)
    }
    return n
  }
  const positiveNumber = (flag: string, raw: string): number => {
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) {
      throw new ArgsError(`${flag} requires a positive number, got "${raw}".`)
    }
    return n
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) {
      throw new ArgsError(
        `Unexpected argument "${arg}". The worker takes no positional arguments: it runs whatever ` +
        'is in the queue, and what to run is decided by whoever enqueued it (see --help).',
      )
    }
    switch (arg) {
      case '--db': out.db = value(arg, i++); break
      case '--out': out.out = value(arg, i++); break
      case '--types': out.types = parseTypes(value(arg, i++)); break
      case '--watch': out.watch = true; break
      case '--poll-interval': out.pollIntervalMs = positiveInt(arg, value(arg, i++)); break
      case '--max-jobs': out.maxJobs = positiveInt(arg, value(arg, i++)); break
      case '--concurrency': out.concurrency = positiveInt(arg, value(arg, i++)); break
      case '--rate': out.rps = positiveNumber(arg, value(arg, i++)); break
      // Seconds on the command line, milliseconds everywhere inside: nobody
      // wants to type a lease in milliseconds, and nothing wants to do
      // arithmetic on seconds.
      case '--lease': out.leaseMs = positiveInt(arg, value(arg, i++)) * 1000; break
      case '--attempts': out.maxAttempts = positiveInt(arg, value(arg, i++)); break
      case '--json': out.json = true; break
      case '--quiet': out.quiet = true; break
      case '--verbose': out.verbose = true; break
      default: throw new ArgsError(`Unknown flag "${arg}".`)
    }
  }

  // Two dials pointing opposite ways; letting one quietly win would mean a
  // run that asked for silence getting request-level tracing, or the other
  // way round, with no way to tell from the output.
  if (out.quiet && out.verbose) {
    throw new ArgsError(
      '--quiet and --verbose are opposites: --quiet prints only the final result, ' +
      '--verbose adds per-request detail. Pass at most one.',
    )
  }

  return out
}

function parseTypes(raw: string): JobType[] {
  const names = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  if (names.length === 0) {
    throw new ArgsError(
      `--types was given no type names. Omit the flag entirely to take every type: ${KNOWN_TYPES.join(', ')}.`,
    )
  }
  // Named rather than merely rejected: a typo here is silent in the worst
  // way — the worker starts, claims nothing, and exits 0 with an empty queue
  // it never actually looked at the right part of.
  const unknown = names.filter((n) => !KNOWN_TYPES.includes(n as JobType))
  if (unknown.length > 0) {
    throw new ArgsError(
      `--types does not know ${unknown.map((n) => `"${n}"`).join(', ')}. ` +
      `This worker runs: ${KNOWN_TYPES.join(', ')}.`,
    )
  }
  return names as JobType[]
}

export function helpText(): string {
  return `pje-worker — drain the jobs queue

  The queue is filled by somebody else (the demo web app, or a script); this
  command runs what is in it. There is no scheduler and no periodic job: you
  start a worker when there is work to do.

Usage
  npm run worker -- [options]

Options
  --db <path>            SQLite database holding the queue (default data/pje.db)
  --out <dir>            where PDFs are written (default data/pdfs)
  --types <a,b>          claim only these job types (default: whatever is next)
  --watch                keep polling once the queue empties, instead of exiting
  --poll-interval <ms>   how often --watch looks again (default 1000)
  --max-jobs <n>         stop after n jobs, leaving the rest queued
  --concurrency <n>      requests in flight inside one job (default 4)
  --rate <n>             requests per second against the portal (default 2)
  --lease <seconds>      how long a job may go silent before another worker
                         may take it over (default 60)
  --attempts <n>         attempts a failing job gets before it is given up on
                         (default 3)
  --json                 print the run summary as JSON on stdout
  --quiet | --verbose    how much the run says about itself while it works
  --help | --version

Job types
  crawl          enumerate an id range, or resume from the watermark
                 payload: { fromId?, toId?, limit?, concurrency?, stopAfterMisses? }
  deep_case      one case and every document in its file
                 payload: { idProcessoTrf } or { number }
  deep_range     the same, over an id range
                 payload: { fromId, toId, concurrency? }
  refresh_case   re-read a case that is already stored
                 payload: { idProcessoTrf } or { number }
  discover       a crawl with no explicit range; an older name for one
  backfill       a crawl over an explicit range; an older name for one

Stopping
  Ctrl-C once lets the job in flight finish and then exits. Ctrl-C again hands
  that job straight back to the queue and stops — it is never left running.`
}
