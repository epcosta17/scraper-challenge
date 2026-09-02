import { openDatabase, FsBlobStore, listFailures, searchCases, SearchQueryError, type SearchResults } from '@pje/core'
import { HttpClient } from '../http/client.ts'
import { startSession } from '../pje/session.ts'
import { search, validateFilters, SearchValidationError } from '../pje/search.ts'
import { crawl } from '../crawl/enumerate.ts'
import { deepCase, deepRange, type DeepTarget } from '../crawl/deep.ts'
import { parseArgs, helpText, validateCommandUsage, logLevelOf, ArgsError, type ParsedArgs } from './args.ts'
import { createReporter, type Reporter } from './reporter.ts'
import {
  summaryLines, cappedWarning, deepCaseOutcomeLines, deepRangeSummaryLines,
  deepRunHeader, crawlRunHeader, searchRunHeader,
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
 * How each narrated line is attributed to the case that produced it. A
 * `deep` range runs several cases at once, so a line has to say which of
 * them it belongs to *and* where that case sits in the range; anything else
 * (a single target, a crawl) has only one thing in flight worth naming.
 */
function tagForCommand(args: ParsedArgs): ((ref: string) => string) | undefined {
  if (args.command !== 'deep' || args.fromId === undefined || args.toId === undefined) return undefined
  const total = args.toId - args.fromId + 1
  return (ref: string) => {
    const position = Number(ref) - args.fromId! + 1
    return Number.isFinite(position) ? `[${position}/${total} id ${ref}]` : `[${ref}]`
  }
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
 * The "re-run to retry" hint, worded for `command`. Goes to stderr with
 * every other piece of commentary: it is advice about the run, not the
 * run's result, and stdout carries only the result.
 */
function reportUnresolvedFailures(db: Parameters<typeof listFailures>[0], reporter: Reporter, hint: string): void {
  const unresolved = listFailures(db, { unresolvedOnly: true })
  if (unresolved.length === 0) return
  reporter.note(`\n${unresolved.length} unresolved failure(s) recorded. ${hint}`)
}

/**
 * Renders `find` results for a terminal. Deliberately here rather than in
 * `format.ts`: `find` exists to exercise the search from a shell, and one
 * local helper is the smallest thing that does that.
 *
 * One block per case — the identifying line, the class and court, then the
 * matching document and its highlighted fragment. The trailing line reports
 * the full match count, not the page's, so a capped page never reads as the
 * whole answer.
 */
function findResultLines(results: SearchResults): string {
  const blocks = results.hits.map((hit) => {
    const lines = [
      `${hit.number}  id=${hit.idProcessoTrf}  score=${hit.score.toFixed(2)}  [${hit.matchedIn.join('+')}]`,
      `  ${[hit.className, hit.court].filter(Boolean).join(' — ')}`,
    ]
    if (hit.snippet) {
      lines.push(`  ${hit.snippet.label}`)
      // Snippets are extracted from PDF text and can carry newlines; a
      // result block that spills over several lines loses the shape.
      lines.push(`    ${hit.snippet.text.replace(/\s+/g, ' ').trim()}`)
    }
    return lines.join('\n')
  })

  const shown = results.hits.length
  const first = results.offset + 1
  const tail = results.total === 0
    ? '0 results'
    : `${shown} of ${results.total} results (showing ${first}-${results.offset + shown})`
  return [...blocks, '', tail].join('\n')
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
 *
 * Everything this prints while working goes to stderr through `reporter`;
 * stdout is written exactly once, at the end, with the run's result.
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

    // Purely local: `find` reads the database this scraper filled and never
    // contacts the portal, which is why it is handled before the HttpClient
    // below is even constructed.
    if (args.command === 'find') {
      const db = openDatabase(args.db)
      try {
        const results = searchCases(db, args.positional[0]!, { limit: args.limit, offset: args.offset })
        console.log(args.json ? JSON.stringify(results, null, 2) : findResultLines(results))
        return 0
      } finally {
        db.close()
      }
    }

    if (args.command === 'case') {
      console.error(
        `Command "${args.command}" is a phase-2 feature and is not implemented yet. ` +
        "Use 'search' to find a case, or 'crawl' to enumerate cases and download summary PDFs.",
      )
      return 2
    }

    const reporter = createReporter({ level: logLevelOf(args), tagFor: tagForCommand(args) })
    const client = new HttpClient({
      rps: args.rps,
      fetchImpl: opts.fetchImpl,
      // Request-level detail is `--verbose`'s job; the reporter drops these
      // entirely at every other level, so this costs nothing when unused.
      onEvent: (e) => reporter.http(e),
    })

    if (args.command === 'search') {
      // Validated here, before `startSession` fires the session GET, so a
      // bad filter is rejected without touching the portal at all.
      // `search()` below re-validates internally — cheap, idempotent, and
      // worth keeping as a defence for any other caller of `search()`.
      validateFilters(args.filters)
      if (args.dryRun) {
        return emitDryRunPlan({ dryRun: true, command: 'search', filters: args.filters }, args.json)
      }
      reporter.header(searchRunHeader(args.filters))
      reporter.note('starting a session')
      const session = await startSession(client)
      reporter.note('submitting the search form')
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
      reporter.header(deepRunHeader({
        target: isRange ? undefined : args.positional[0]!,
        fromId: args.fromId,
        toId: args.toId,
        concurrency: args.concurrency,
        db: args.db,
        out: args.out,
      }))
      const onStep = (e: Parameters<Reporter['deepStep']>[0]) => reporter.deepStep(e)
      const onDocumentProgress = (p: Parameters<Reporter['deepDocument']>[0]) => reporter.deepDocument(p)
      const retryHint =
        "Re-run 'deep' over the same target(s) to retry — already-downloaded documents are " +
        'skipped, so a retry only redoes the work that failed.'
      try {
        if (isRange) {
          const summary = await deepRange({ client, db, blobs }, {
            fromId: args.fromId!,
            toId: args.toId!,
            concurrency: args.concurrency,
            onDocumentProgress,
            onStep,
            onCaseProgress: (o) => reporter.deepCase(o),
          })
          console.log(args.json ? JSON.stringify(summary, null, 2) : deepRangeSummaryLines(summary))
          reportUnresolvedFailures(db, reporter, retryHint)
          return summary.casesFailed > 0 || summary.documentsFailed > 0 ? 1 : 0
        }

        const outcome = await deepCase({ client, db, blobs }, deepTargetFrom(args.positional[0]!), { onDocumentProgress, onStep })
        console.log(args.json ? JSON.stringify(outcome, null, 2) : deepCaseOutcomeLines(outcome))
        reportUnresolvedFailures(db, reporter, retryHint)
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
    reporter.header(crawlRunHeader({
      command: args.command,
      fromId: args.fromId,
      toId: args.toId,
      limit: args.limit,
      concurrency: args.concurrency,
      rps: args.rps,
      db: args.db,
      out: args.out,
    }))
    try {
      const summary = await crawl({ client, db, blobs }, {
        fromId: args.fromId,
        toId: args.toId,
        limit: args.limit,
        concurrency: args.concurrency,
        onProgress: (p) => reporter.crawlProgress(p),
        // One id retrying its summary PDF is normal enough (see
        // `report.ts`'s TRANSIENT_RETRIES) that it belongs with the other
        // per-request detail, not in the default narration.
        onRetry: (r) => reporter.detail(`↻ id ${r.id}: summary PDF came back HTTP ${r.status} - retry ${r.attempt} of ${r.of}`),
      })
      console.log(args.json ? JSON.stringify(summary, null, 2) : summaryLines(summary))
      // A default re-run resumes from `MAX(id_processo_trf)` and so never
      // revisits a lower id on its own — the range has to be given again
      // explicitly, or these rows stay unresolved forever.
      reportUnresolvedFailures(
        db, reporter,
        "Re-run 'crawl' with an --from-id/--to-id range covering them to retry — a default " +
        're-run resumes from the watermark and will not revisit them on its own.',
      )
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
    // SearchQueryError is the same class of mistake as a bad flag — the
    // query as typed cannot be run — so it exits 2 like the rest of them.
    if (err instanceof ArgsError || err instanceof SearchValidationError || err instanceof SearchQueryError) {
      console.error(`error: ${err.message}`)
      return 2
    }
    console.error(err)
    return 1
  }
}
