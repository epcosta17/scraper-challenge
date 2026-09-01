import { openDatabase, FsBlobStore, listFailures } from '@pje/core'
import { HttpClient } from '../http/client.ts'
import { startSession } from '../pje/session.ts'
import { search, validateFilters, SearchValidationError } from '../pje/search.ts'
import { crawl } from '../crawl/enumerate.ts'
import { deepCase, deepRange, type DeepTarget } from '../crawl/deep.ts'
import { parseArgs, helpText, validateCommandUsage, ArgsError } from './args.ts'
import {
  progressLine, summaryLines, cappedWarning,
  deepDocumentProgressLine, deepCaseOutcomeLines, deepRangeSummaryLines,
  deepCaseProgressLine, deepStepLine, crawlPeriodicProgressLine,
  dryRunPlanLine, type DryRunPlan,
} from './format.ts'
import { SCRAPER_VERSION } from '../version.ts'

export interface MainOptions {
  /** Overrides the network transport — the seam tests use to prove no request went out. */
  fetchImpl?: typeof fetch
}

/** A bare integer is an internal idProcessoTrf; anything else is a case number, as typed. */
function deepTargetFrom(positional: string): DeepTarget {
  return /^\d+$/.test(positional) ? { kind: 'id', id: Number(positional) } : { kind: 'number', number: positional }
}

/**
 * Prints a `--dry-run` plan in whichever mode the run asked for. `--json`
 * means stdout carries JSON and nothing else — a plan printed as prose there
 * breaks the very pipeline the flag exists for — so the plan is data first
 * and a sentence only when no machine is reading.
 */
function emitDryRunPlan(plan: DryRunPlan, json: boolean): number {
  console.log(json ? JSON.stringify(plan, null, 2) : dryRunPlanLine(plan))
  return 0
}

/**
 * Prints the same "re-run to retry" hint `crawl` prints, worded for
 * `command`. Skipped entirely under `--json`: it's prose, not part of the
 * machine-readable result, and stdout must carry nothing else in that mode.
 */
function reportUnresolvedFailures(db: Parameters<typeof listFailures>[0], command: string, json: boolean): void {
  if (json) return
  const unresolved = listFailures(db, { unresolvedOnly: true })
  if (unresolved.length === 0) return
  console.log(
    `\n${unresolved.length} unresolved failure(s) recorded. Re-run '${command}' over the same ` +
    'target(s) to retry — already-downloaded documents are skipped, so a retry only redoes the work that failed.',
  )
}

/**
 * The whole CLI, importable and side-effect-free at module scope so tests
 * can drive it directly. `cli.ts` is the only thing that invokes this, and
 * it does so unconditionally — there is no "am I the entry point?" guard
 * here, deliberately: a guard comparing `process.argv[1]` against
 * `import.meta.url` is fragile in ways that fail silently (an npm `bin`
 * shim, a symlinked entry point, a case-insensitive filesystem all defeat a
 * strict comparison, and the failure mode is a no-op that exits 0 as if
 * nothing was wrong). Splitting the importable module from the executable
 * one removes the need for that comparison entirely.
 */
export async function main(argv: string[], opts: MainOptions = {}): Promise<number> {
  try {
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
      console.log(helpText())
      return 0
    }

    if (argv[0] === '--version' || argv[0] === '-v') {
      console.log(SCRAPER_VERSION)
      return 0
    }

    const args = parseArgs(argv)
    // Cross-field, pre-flight checks (never a silent no-op, never a silent
    // misinterpretation) — all before any network call.
    validateCommandUsage(args)

    if (args.command === 'case') {
      console.error(
        `Command "${args.command}" is a phase-2 feature and is not implemented yet. ` +
        "Use 'search' to find a case, or 'crawl' to enumerate cases and download summary PDFs.",
      )
      return 2
    }

    const client = new HttpClient({ rps: args.rps, fetchImpl: opts.fetchImpl })

    if (args.command === 'search') {
      // Validated here, before `startSession` fires the session GET, so a
      // bad filter is rejected without touching the portal at all.
      // `search()` below re-validates internally — cheap, idempotent, and
      // worth keeping as a defence for any other caller of `search()`.
      validateFilters(args.filters)
      if (args.dryRun) {
        return emitDryRunPlan({ dryRun: true, command: 'search', filters: args.filters }, args.json)
      }
      const session = await startSession(client)
      const outcome = await search(client, session, args.filters)
      if (args.json) {
        console.log(JSON.stringify(outcome, null, 2))
      } else {
        for (const row of outcome.rows) {
          console.log(`${row.number}  id=${row.idProcessoTrf}  ca=${row.ca}`)
        }
        console.log(`\n${outcome.rows.length} results`)
        if (outcome.capped) console.log(cappedWarning())
      }
      return 0
    }

    if (args.command === 'deep') {
      // validateCommandUsage already guaranteed exactly one form: a single
      // positional, or a full --from-id/--to-id range.
      const isRange = args.fromId !== undefined && args.toId !== undefined
      if (args.dryRun) {
        return emitDryRunPlan({
          dryRun: true,
          command: 'deep',
          target: isRange ? null : args.positional[0]!,
          fromId: isRange ? args.fromId! : null,
          toId: isRange ? args.toId! : null,
        }, args.json)
      }

      const db = openDatabase(args.db)
      const blobs = new FsBlobStore(args.out)
      // Progress goes to stderr, unconditionally — never stdout, so `--json`
      // (and any other piping of the final result) stays uncontaminated.
      // Beyond that split, `--verbose` controls only how MUCH is printed:
      // per-step and per-document lines instead of one line per case.
      const onDocumentProgress = args.verbose
        ? (p: Parameters<typeof deepDocumentProgressLine>[0]) => console.error(deepDocumentProgressLine(p))
        : undefined
      const onStep = args.verbose ? (e: Parameters<typeof deepStepLine>[0]) => console.error(deepStepLine(e)) : undefined
      try {
        if (isRange) {
          const total = args.toId! - args.fromId! + 1
          let position = 0
          const summary = await deepRange({ client, db, blobs }, {
            fromId: args.fromId!,
            toId: args.toId!,
            concurrency: args.concurrency,
            onDocumentProgress,
            onStep,
            // Default: one line per case as it finishes, with a running
            // position — the whole point being that a multi-minute range is
            // never silent for more than one case's worth of work. Verbose
            // trades that summary line for the fuller per-case breakdown it
            // already printed, now on stderr like everything else here.
            onCaseProgress: args.verbose
              ? (o) => console.error(deepCaseOutcomeLines(o))
              : (o) => { position++; console.error(deepCaseProgressLine(position, total, o)) },
          })
          console.log(args.json ? JSON.stringify(summary, null, 2) : deepRangeSummaryLines(summary))
          reportUnresolvedFailures(db, 'deep', args.json)
          return summary.casesFailed > 0 || summary.documentsFailed > 0 ? 1 : 0
        }

        const outcome = await deepCase({ client, db, blobs }, deepTargetFrom(args.positional[0]!), { onDocumentProgress, onStep })
        console.log(args.json ? JSON.stringify(outcome, null, 2) : deepCaseOutcomeLines(outcome))
        reportUnresolvedFailures(db, 'deep', args.json)
        return outcome.kind === 'failed' || outcome.documentsFailed > 0 ? 1 : 0
      } finally {
        db.close()
      }
    }

    // args.command is 'crawl' | 'daily' here — 'daily' is a crawl with no
    // explicit id range, resuming from the stored watermark (validated above:
    // it can never reach here carrying --from-id/--to-id).
    if (args.dryRun) {
      // Print the plan and stop before opening the database or the blob
      // store — a dry run must not touch disk at all.
      return emitDryRunPlan({
        dryRun: true,
        command: args.command,
        fromId: args.fromId ?? null,
        toId: args.toId ?? null,
      }, args.json)
    }

    const db = openDatabase(args.db)
    const blobs = new FsBlobStore(args.out)
    try {
      // `crawl`/`daily` walk far more ids, far faster, than `deep` — a line
      // per id would be noise at the default level. Instead, print a line
      // to stderr every ~2s of wall-clock time (not every N ids: throughput
      // varies a lot with concurrency and how often the server 429s, so a
      // fixed id-count interval can't bound how long the terminal stays
      // silent the way a time interval directly does) with the running
      // position and counts. `--verbose` keeps the existing per-id lines
      // instead, unchanged apart from moving to stderr.
      let checked = 0
      let lastReportAt = Date.now()
      const PERIODIC_INTERVAL_MS = 2000
      const summary = await crawl({ client, db, blobs }, {
        fromId: args.fromId,
        toId: args.toId,
        limit: args.limit,
        concurrency: args.concurrency,
        onProgress: args.verbose
          ? (p) => console.error(progressLine(p))
          : (p) => {
              checked++
              const now = Date.now()
              if (now - lastReportAt >= PERIODIC_INTERVAL_MS) {
                lastReportAt = now
                console.error(crawlPeriodicProgressLine({ checked, id: p.id, stored: p.stored, absent: p.absent, failed: p.failed }))
              }
            },
      })
      console.log(args.json ? JSON.stringify(summary, null, 2) : summaryLines(summary))
      const unresolved = args.json ? [] : listFailures(db, { unresolvedOnly: true })
      if (unresolved.length > 0) {
        // A default re-run resumes from `MAX(id_processo_trf)` and so never
        // revisits a lower id on its own — the range has to be given again
        // explicitly, or these rows stay unresolved forever.
        console.log(
          `\n${unresolved.length} unresolved failures recorded. Re-run 'crawl' with an ` +
          '--from-id/--to-id range covering them to retry — a default re-run resumes from ' +
          'the watermark and will not revisit them on its own.',
        )
      }
      // A run where every id failed must not look like a clean one: a
      // `daily` in cron with a 100% failure rate is otherwise indistinguishable
      // from a normal night with nothing to do. Nonzero exactly when this run
      // itself recorded at least one failure (not merely when older,
      // still-unresolved failures exist from a previous run).
      return summary.failed > 0 ? 1 : 0
    } finally {
      db.close()
    }
  } catch (err) {
    if (err instanceof ArgsError || err instanceof SearchValidationError) {
      console.error(`error: ${err.message}`)
      return 2
    }
    console.error(err)
    return 1
  }
}
