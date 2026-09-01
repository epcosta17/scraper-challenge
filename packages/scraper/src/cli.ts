#!/usr/bin/env node
import { openDatabase, FsBlobStore, listFailures } from '@pje/core'
import { HttpClient } from './http/client.ts'
import { startSession } from './pje/session.ts'
import { search, SearchValidationError } from './pje/search.ts'
import { crawl } from './crawl/enumerate.ts'
import { parseArgs, helpText, validateCommandUsage, ArgsError } from './cli/args.ts'
import { progressLine, summaryLines, cappedWarning } from './cli/format.ts'

async function main(argv: string[]): Promise<number> {
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

  const client = new HttpClient({ rps: args.rps })

  if (args.command === 'search') {
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
  const db = openDatabase(args.db)
  const blobs = new FsBlobStore(args.out)
  try {
    if (args.dryRun) {
      console.log(`Would crawl from ${args.fromId ?? '(database watermark)'} ` +
                  `to ${args.toId ?? '(until 50 consecutive misses)'}`)
      return 0
    }
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
      console.log(`\n${unresolved.length} unresolved failures recorded. Re-run to retry them.`)
    }
    return 0
  } finally {
    db.close()
  }
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code })
  .catch((err: unknown) => {
    if (err instanceof ArgsError || err instanceof SearchValidationError) {
      console.error(`error: ${err.message}`)
      process.exitCode = 2
      return
    }
    console.error(err)
    process.exitCode = 1
  })
