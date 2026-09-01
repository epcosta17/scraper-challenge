import type { SearchFilters } from '../pje/search.ts'

export type Command = 'search' | 'crawl' | 'case' | 'deep' | 'daily'
const COMMANDS: Command[] = ['search', 'crawl', 'case', 'deep', 'daily']

export class ArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArgsError'
  }
}

export interface ParsedArgs {
  command: Command
  filters: SearchFilters
  fromId?: number
  toId?: number
  limit?: number
  concurrency: number
  rps: number
  db: string
  out: string
  json: boolean
  verbose: boolean
  dryRun: boolean
  partition: boolean
  positional: string[]
}

const STRING_FLAGS: Record<string, keyof SearchFilters> = {
  '--number': 'number',
  '--from': 'from',
  '--to': 'to',
  '--class': 'class',
  '--party': 'party',
  '--lawyer': 'lawyer',
  '--document': 'document',
  '--document-type': 'documentType',
  '--oab': 'oab',
  '--oab-state': 'oabState',
  '--reference': 'reference',
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv
  if (!command || !COMMANDS.includes(command as Command)) {
    throw new ArgsError(`Unknown command "${command ?? ''}". Expected one of: ${COMMANDS.join(', ')}`)
  }

  const out: ParsedArgs = {
    command: command as Command,
    filters: {},
    concurrency: 4,
    rps: 2,
    db: 'data/pje.db',
    out: 'data/pdfs',
    json: false,
    verbose: false,
    dryRun: false,
    partition: false,
    positional: [],
  }

  const value = (flag: string, i: number): string => {
    const v = rest[i + 1]
    if (v === undefined || v.startsWith('--')) throw new ArgsError(`${flag} requires a value.`)
    return v
  }
  // `--concurrency 0`/`--limit 0`/`--from-id 1.5` etc. would otherwise pass
  // `Number.isFinite` and go on to silently disable safety (0 concurrency,
  // a no-op crawl reporting "Stored: 0" and exit 0) or reach a URL as a
  // fractional id. Both flag families are rejected outright instead.
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

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (!arg.startsWith('--')) { out.positional.push(arg); continue }

    const filterKey = STRING_FLAGS[arg]
    if (filterKey) {
      const v = value(arg, i++)
      if (filterKey === 'documentType') {
        if (v !== 'cpf' && v !== 'cnpj') throw new ArgsError('--document-type must be cpf or cnpj.')
        out.filters.documentType = v
      } else {
        out.filters[filterKey] = v as never
      }
      continue
    }

    switch (arg) {
      case '--from-id': out.fromId = positiveInt(arg, value(arg, i++)); break
      case '--to-id': out.toId = positiveInt(arg, value(arg, i++)); break
      case '--limit': out.limit = positiveInt(arg, value(arg, i++)); break
      case '--concurrency': out.concurrency = positiveInt(arg, value(arg, i++)); break
      case '--rate': out.rps = positiveNumber(arg, value(arg, i++)); break
      case '--db': out.db = value(arg, i++); break
      case '--out': out.out = value(arg, i++); break
      case '--json': out.json = true; break
      case '--verbose': out.verbose = true; break
      case '--dry-run': out.dryRun = true; break
      case '--partition': out.partition = true; break
      default: throw new ArgsError(`Unknown flag "${arg}".`)
    }
  }

  return out
}

/**
 * Cross-field, pre-flight checks that go beyond syntax and depend on which
 * command was chosen. Kept separate from `parseArgs` so that parsing itself
 * stays a pure "does this look like valid syntax" pass (in particular,
 * `--partition` must still *parse* on `search` — it's the combination that
 * is rejected, not the flag).
 *
 * Every check here runs before any network call, so a doomed request never
 * goes out. Exit code 2, like every other `ArgsError`.
 */
export function validateCommandUsage(args: ParsedArgs): void {
  // A bare positional — most naturally a pasted case number, e.g.
  // `scraper search 0013201-41.2025.4.05.8202` — is silently collected and
  // then ignored by every flag parser downstream, running an unfiltered
  // search (or an unbounded crawl) instead of failing loudly. Point at the
  // flag that was actually meant.
  if (
    (args.command === 'search' || args.command === 'crawl' || args.command === 'daily') &&
    args.positional.length > 0
  ) {
    const hint = args.command === 'search'
      ? ' Did you mean --number? (e.g. --number ' + JSON.stringify(args.positional[0]) + ')'
      : ''
    throw new ArgsError(
      `Unexpected argument "${args.positional[0]}" for '${args.command}'.${hint} ` +
      `'${args.command}' takes no positional arguments — everything is passed via flags ` +
      '(see --help).',
    )
  }

  if (args.command === 'search' && args.partition) {
    throw new ArgsError(
      '--partition is not implemented in this phase (automatic subdivision of a capped ' +
      "30-row result set). Use 'crawl' instead: it enumerates every case by internal id " +
      'and is not subject to the 30-row cap.',
    )
  }

  if (args.command === 'daily' && (args.fromId !== undefined || args.toId !== undefined)) {
    throw new ArgsError(
      "'daily' always resumes from the stored watermark and does not accept --from-id or " +
      "--to-id. Use 'crawl' if you need an explicit id range.",
    )
  }

  if (args.command === 'deep') {
    const hasRange = args.fromId !== undefined || args.toId !== undefined
    const hasFullRange = args.fromId !== undefined && args.toId !== undefined
    if (hasRange && !hasFullRange) {
      throw new ArgsError("'deep' requires both --from-id and --to-id together for a range.")
    }
    if (args.positional.length > 1) {
      throw new ArgsError(
        `'deep' takes exactly one positional argument (a case number or internal id), got ` +
        `${args.positional.length}.`,
      )
    }
    if (args.positional.length === 1 && hasFullRange) {
      throw new ArgsError(
        "'deep' accepts either a single case number/id or --from-id/--to-id, not both.",
      )
    }
    if (args.positional.length === 0 && !hasFullRange) {
      throw new ArgsError(
        "'deep' requires either a case number/id argument or --from-id/--to-id " +
        '(e.g. `deep 0013201-41.2025.4.05.8202` or `deep --from-id 130100 --to-id 130120`).',
      )
    }
  }
}

export function helpText(): string {
  return `pje-scraper — TRF5 public case scraper

USAGE
  scraper <command> [options]
  scraper deep <number|id>
  scraper deep --from-id <n> --to-id <n>
  scraper --version | -v      Print the installed version and exit
  scraper --help | -h         Print this message and exit

COMMANDS
  search   Query the portal's own search form (faithful to the website)
  crawl    Enumerate cases by internal id and download summary PDFs
  case     Fetch a single case by number or internal id (phase 2, not yet implemented)
  deep     Fetch a case (by number or internal id, or a --from-id/--to-id range)
           and download every document in its file, PDFs and HTML alike
  daily    Advance the watermark: scrape only cases newer than the last run

DEEP TARGET (exactly one form; see USAGE above)
  <number|id>           a case number (e.g. 0013201-41.2025.4.05.8202) or a bare
                         internal idProcessoTrf (e.g. 130100) — not both, and not
                         combined with --from-id/--to-id
  --from-id/--to-id      an explicit id range, one case per id (see CRAWL RANGE
                         below) — always given together, never alone

  A single case costs roughly 11 requests: 1 summary PDF + 1 search (skipped
  when a still-valid ca is already on file) + 1 detail page + ~9 documents.

SEARCH FILTERS (mirror the website's form)
  --number <n>          exact CNJ case number
  --from <dd/mm/yyyy>   filing date, start of range
  --to <dd/mm/yyyy>     filing date, end of range
  --class <name>        judicial class (substring, accent-insensitive)
  --party <name>        party name (at least two names required)
  --lawyer <name>       lawyer name (at least two names required)
  --document <n>        CPF or CNPJ
  --document-type <t>   cpf | cnpj  (default: cpf)
  --oab <n>             OAB number
  --oab-state <uf>      OAB state (requires --oab)
  --reference <n>       reference case number
  --partition           NOT IMPLEMENTED in this phase — see NOTE below

CRAWL RANGE (internal counter, distinct from the date filters above)
  --from-id <n>         first idProcessoTrf (default: resume from the database)
  --to-id <n>           last idProcessoTrf
  --limit <n>           stop after n ids

  'daily' always resumes from the stored watermark and rejects --from-id/--to-id;
  use 'crawl' for an explicit range.

GENERAL
  --concurrency <n>     parallel requests (default: 4)
  --rate <n>            requests per second (default: 2)
  --db <path>           SQLite file (default: data/pje.db)
  --out <path>          PDF directory (default: data/pdfs)
  --json                machine-readable output
  --verbose             per-id crawl/daily progress logging (no effect on search)
  --dry-run             plan the work without writing anything

NOTE
  The portal caps every search at 30 results and has no pagination. 'search'
  will tell you when a result set was capped. --partition (automatic
  subdivision) is NOT implemented in this phase and will fail loudly if
  passed. Use 'crawl' for complete coverage instead.
`
}
