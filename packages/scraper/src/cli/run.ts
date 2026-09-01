import { openDatabase, FsBlobStore, listFailures } from '@pje/core'
import { HttpClient } from '../http/client.ts'
import { startSession } from '../pje/session.ts'
import { search, validateFilters, SearchValidationError } from '../pje/search.ts'
import { crawl } from '../crawl/enumerate.ts'
import { parseArgs, helpText, validateCommandUsage, ArgsError } from './args.ts'
import { progressLine, summaryLines, cappedWarning } from './format.ts'

export interface MainOptions {
  /** Overrides the network transport — the seam tests use to prove no request went out. */
  fetchImpl?: typeof fetch
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

    const args = parseArgs(argv)
    // Cross-field, pre-flight checks (never a silent no-op, never a silent
    // misinterpretation) — all before any network call.
    validateCommandUsage(args)

    if (args.command === 'case' || args.command === 'deep') {
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
        console.log(`Would search with filters: ${JSON.stringify(args.filters)}`)
        return 0
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

    // args.command is 'crawl' | 'daily' here — 'daily' is a crawl with no
    // explicit id range, resuming from the stored watermark (validated above:
    // it can never reach here carrying --from-id/--to-id).
    if (args.dryRun) {
      // Print the plan and stop before opening the database or the blob
      // store — a dry run must not touch disk at all.
      console.log(`Would crawl from ${args.fromId ?? '(database watermark)'} ` +
                  `to ${args.toId ?? '(until 50 consecutive misses)'}`)
      return 0
    }

    const db = openDatabase(args.db)
    const blobs = new FsBlobStore(args.out)
    try {
      const summary = await crawl({ client, db, blobs }, {
        fromId: args.fromId,
        toId: args.toId,
        limit: args.limit,
        concurrency: args.concurrency,
        onProgress: args.verbose ? (p) => console.log(progressLine(p)) : undefined,
      })
      console.log(args.json ? JSON.stringify(summary, null, 2) : summaryLines(summary))
      const unresolved = listFailures(db, { unresolvedOnly: true })
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
