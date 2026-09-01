# pje-trf5-scraper

A command-line scraper for the public case-consultation portal of TRF5 (Tribunal
Regional Federal da 5ª Região), the federal appeals court for Brazil's Northeast
region, built on PJe (Processo Judicial Eletrônico), the CNJ's national e-filing
system. It queries the portal's own search form, enumerates cases by internal id
to get around the portal's 30-result cap, downloads each case's summary PDF, and
stores structured case data in SQLite.

The shipped scraper is **HTTP requests plus HTML/PDF parsing — no browser
automation**. A headless browser (Playwright) was used during reconnaissance to
inspect the live DOM and confirm dead ends (see *Findings* below); none of that
tooling ships in `packages/`, and nothing under `packages/` launches a browser.

## Requirements

- Node.js >= 22 (uses `node --experimental-strip-types` to run TypeScript
  directly — no build step, no transpiler).
- No other services. Storage is a local SQLite file (`better-sqlite3`) and a
  local directory of PDFs; there is nothing to provision.

## Install

```bash
npm install
```

That's the whole setup. From a clean checkout:

```bash
git clone <this repo> && cd pje-trf5-scraper
npm install
npm run scraper -- --help
```

## Running it

The CLI is invoked through the `scraper` npm script; everything after `--` is
passed to it. `npm run scraper -- <command> [options]`.

### `search` — query the portal's own search form

Faithful to the website: same fields, same validation, same 30-row cap. A
case number (or any other value) always goes through a flag — `search` takes
no bare positional arguments, so `scraper search 0013201-41.2025.4.05.8202`
is rejected outright rather than silently running an unfiltered search:

```bash
npm run scraper -- search --number 0013201-41.2025.4.05.8202
```

```
0013201-41.2025.4.05.8202  id=129921  ca=76b81711e2c69f608d188fb631214485f3d19a12e7c30f6e

1 results
```

Search by a filing-date range instead of an exact number:

```bash
npm run scraper -- search --from 01/08/2026 --to 07/08/2026
```

If a query matches more than 30 cases, the server truncates the result set and
`search` prints a warning explaining why (see *Findings*):

```
WARNING: 30 results — the server cap was reached, so there are more.
         The portal has no pagination. --partition is not implemented
         in this phase; use `crawl` for complete coverage.
```

`--dry-run` works here too: it prints the filters `search` would submit and
makes no request at all.

### `crawl` — enumerate every case by internal id

This is the tool for complete coverage, because `search` can never see past 30
rows. `crawl` walks `idProcessoTrf` (the portal's internal auto-increment
counter, unrelated to the public case number) sequentially, fetches each case's
summary PDF, parses it, and upserts the result into SQLite.

```bash
npm run scraper -- crawl --from-id 130100 --to-id 130105 --rate 1
```

```
Stored:  3
Absent:  0   (secret or unassigned ids — expected)
Failed:  0   (recorded in the failures table for retry)
Last id: 130102
```

Omit `--from-id` to resume automatically from the highest id already stored in
the database (`MAX(id_processo_trf)` — see *How resuming works* below). Omit
`--to-id` to run until 50 consecutive misses in a row, which is the crawl's
heuristic for "past the end of the assigned range." Preview a run without
touching the network, the database, or disk with `--dry-run`:

```bash
npm run scraper -- crawl --from-id 130100 --to-id 130105 --dry-run
```

```
Would crawl from 130100 to 130105
```

**Exit code:** `crawl` and `daily` exit `0` when the run recorded zero
failures and `1` when it recorded at least one (the `Failed:` count above is
nonzero). This is judged on the current run only, not on older unresolved
rows left over from a previous one — so a `daily` in cron that fails on
every id looks different from a clean run in its exit code, not just in a
log line nobody is watching. `search` and `--dry-run` runs are unaffected;
they exit `0` on success and `2` on a rejected argument, as before.

### `case` and `deep` — phase 2, not implemented yet

Both commands parse and validate their arguments but then exit with **status
code 2** and an explanatory message, rather than silently doing nothing or
pretending to work:

```bash
npm run scraper -- case --number 0013201-41.2025.4.05.8202
```

```
Command "case" is a phase-2 feature and is not implemented yet. Use 'search'
to find a case, or 'crawl' to enumerate cases and download summary PDFs.
```

`case` (fetch one case by number or internal id) and `deep` (fetch a case and
download every individual document in its file, not just the summary PDF) are
scoped for phase 2 — see *Scope* below for why.

### `daily` — advance the watermark

A `crawl` with no explicit range: it always resumes from the stored watermark
and scrapes forward from there, which makes it the natural thing to run on a
schedule. It rejects `--from-id`/`--to-id` outright (use `crawl` if you need an
explicit range) so a scheduled run can never be accidentally pointed somewhere
else:

```bash
npm run scraper -- daily
```

### How resuming works

`crawl` and `daily` need no session or checkpoint file to resume: the summary
PDF endpoint is stateless (see *Findings*), and the watermark is simply
`MAX(id_processo_trf)` already in `cases`. Restarting after an interruption —
a crash, a Ctrl-C, a scheduled run picking up where yesterday's left off — is
just running the command again with no extra bookkeeping. Ids that failed
non-permanently are kept in `failures` (see *429 handling* below) and are
retried by re-running `crawl` over the same range; ids that were confirmed
absent are kept in `probes` and are not retried, since they are an expected,
stable outcome rather than a transient one.

## Flags

**Search filters** (mirror the website's form; used by `search`):

| Flag | Meaning |
|---|---|
| `--number <n>` | Exact CNJ case number |
| `--from <dd/mm/yyyy>` | Filing (autuação) date, start of range |
| `--to <dd/mm/yyyy>` | Filing (autuação) date, end of range |
| `--class <name>` | Judicial class (substring match, accent-insensitive) |
| `--party <name>` | Party name — the server requires at least two tokens |
| `--lawyer <name>` | Lawyer name — same two-token requirement |
| `--document <n>` | CPF or CNPJ |
| `--document-type <t>` | `cpf` or `cnpj` (default: `cpf`) |
| `--oab <n>` | OAB (bar) number |
| `--oab-state <uf>` | OAB state — has no effect without `--oab` |
| `--reference <n>` | Reference case number |
| `--partition` | **Not implemented in this phase** — see *Scope* |

**Crawl range** (used by `crawl`; an internal counter, not a date — do not
confuse with `--from`/`--to` above):

| Flag | Meaning |
|---|---|
| `--from-id <n>` | First `idProcessoTrf` to try (default: resume from the database) |
| `--to-id <n>` | Last `idProcessoTrf` to try (default: stop after 50 consecutive misses) |
| `--limit <n>` | Stop after examining `n` ids |

`--from`/`--to` are **filing dates** understood by the portal's own search
form and only apply to `search`. `--from-id`/`--to-id` are the **internal
`idProcessoTrf` counter** walked by `crawl`, unrelated to any date, and have
no effect on `search`. `daily` accepts neither — it always resumes from the
stored watermark.

**General** (apply to every command that touches the network or disk):

| Flag | Meaning |
|---|---|
| `--concurrency <n>` | Parallel requests during `crawl`/`daily` (default: 4) |
| `--rate <n>` | Requests per second (default: 2) |
| `--db <path>` | SQLite file (default: `data/pje.db`) |
| `--out <path>` | PDF directory (default: `data/pdfs`) |
| `--json` | Machine-readable output |
| `--verbose` | Per-request progress logging |
| `--dry-run` | Plan the work without touching the network, the database, or disk |

## Where output lands

- **`data/pje.db`** — a SQLite database with `cases`, `documents` (schema
  reserved for phase 2), `probes` (confirmed-absent ids), and `failures`
  (retryable errors).
- **`data/pdfs/`** — one summary PDF per case, keyed descriptively and
  collision-free as `<filing-year>/<case-number>/summary.pdf`, e.g.
  `data/pdfs/2026/0013475-36.2026.4.05.0000/summary.pdf`.

Both paths are created on demand under the current working directory and can
be overridden with `--db`/`--out` — including every parent directory, so
there is nothing to set up by hand even on a fresh clone (`data/` is
gitignored and does not exist until the first run creates it). `--db`'s
directory is created when the database is opened; `--out`'s directory tree
is created as PDFs are written.

## Tests

```bash
npm test                    # offline suite — no network access, fully deterministic
PJE_LIVE=1 npm test          # also runs the three network-gated tests below
npm run typecheck            # tsc --noEmit over both packages — no emitted output
npm run check:runtime        # imports packages/core with Node's own TS stripping,
                              #   catching anything the type checker allows but the
                              #   runtime can't actually execute (e.g. TS syntax that
                              #   survives type-only stripping, like parameter properties)
```

The offline suite (109 tests) runs entirely against fixtures and never makes a
network call — that's what makes it safe to run in CI and safe to run
repeatedly while developing.

`packages/scraper/tests/live.test.ts` is gated behind `PJE_LIVE=1` and hits the
real TRF5 portal at a low rate (1 request/second). It is skipped by default so
`npm test` stays deterministic and offline; run it explicitly to confirm
against the live site:

```bash
PJE_LIVE=1 npm test
```

It covers three things:

1. **Regression control.** Searching the known case
   `0013201-41.2025.4.05.8202` must return exactly one row with
   `idProcessoTrf === 129921`. The real search "submit" parameter is a
   JSF-generated id read from the page at runtime (see *Findings*) and can
   change on a portal redeploy. If the client ever failed to pick up a new
   value, every search would silently return zero results with no error —
   this test is what turns that into an immediate, loud failure instead.
2. **Cold PDF fetch.** `fetchReportPdf` against a known id, with no prior
   session or cookies, returns a PDF that parses to a well-formed case
   number — proof the endpoint really is stateless end to end.
3. **Out-of-range classification.** An id far past the observed counter
   range (999999999) is classified `'absent'`, not `'transient'` — see
   *Findings* for why conflating those two would be a real bug, not a
   cosmetic one.

## Findings

The challenge asks the candidate to discover, by exploration, how this portal
actually behaves — not just to script the happy path. Here is what that
exploration turned up.

**There is no pagination.** The portal hard-caps every result set at 30 rows
and says so in its own response text ("Sua consulta retornou muitos processos
e somente os 30 primeiros serão exibidos"). The cap lives in the query layer
(a `setMaxResults(30)` applied before serialization, not a view-layer limit),
so no request parameter can defeat it. Seven independent approaches were
tried and every one of them was ruled out: there are no sortable column
headers to reorder the result set into a new 30; RichFaces' own
`DataScroller` component isn't present anywhere in the page bundle; the
`<div title="Paginação">` pagination container is empty even when the result
set is capped; none of the page's 66 links lead to an alternative entry
point (they're all external, to CNJ or TRF5 itself); the case-number field
accepts no partial or wildcard match, only an exact number; and posting
forged RichFaces view parameters or Seam page parameters
(`firstResult`/`maxResults`/`page`/`pageSize`) all returned the identical 30
rows, byte for byte. Results are ordered by the case number's filing year,
ascending, and that ordering key has no range filter exposed anywhere in the
form or the request, so keyset pagination is not available either — there is
no cursor to advance. This is the entire reason `crawl` exists as a separate
command: enumerating `idProcessoTrf` directly is the only path that reaches
100% of the corpus.

**How the PDFs are reached.** Each case's summary PDF lives at
`DetalheProcessoConsultaPublica/reportPDF.seam?idProcessoTrf=N`, keyed by the
internal counter rather than the public case number. Critically, this
endpoint works **cold** — no cookies, no session, no prior visit to the search
page or the case's own detail page. Every request is therefore
self-contained, which is what makes `crawl` trivially resumable (no session
to re-establish after a restart) and safely parallelizable (no shared session
state for concurrent workers to race on).

**Success is decided by the response body, never the status code.** Both an
absent id (unassigned or out of range) and a sealed case ("segredo de
justiça") return **HTTP 200** with an HTML error page — never a 404. The only
reliable discriminator is the first five bytes of the body: `%PDF-` means
success, anything else means it wasn't a PDF. Separately, and this is the
correction that matters most for correctness: a *transient* server failure
(observed live as an intermittent HTTP 404 from one unhealthy backend node
behind the load balancer) returns a **non-200** status with an HTML body that
looks superficially like the absent case. The two must never be conflated.
`fetchReportPdf` retries a bounded number of times before giving up on a
non-200 response, and the two outcomes are recorded differently: an absent id
is an expected, permanent miss recorded in `probes` and never retried again;
a transient failure is recorded in `failures` and is retried on a later
`crawl` run. Treating a transient failure as an absent case would silently
and permanently lose a case that actually exists; treating an absent case as
transient would mean retrying roughly 15% of the entire crawl forever, for no
gain.

**The search form fails silently in six separate ways, and the client
defeats every one of them.** First, the "Pesquisar" button's own `onclick`
handler is dead code: it reads `return executarReCaptcha();` — the bare
`return` short-circuits before the `A4J.AJAX.Submit(...)` call that follows
it on the same line ever runs, so the parameters embedded in that dead call
are a red herring. The real submit happens from a different function,
`executarPesquisa()`, defined inline in the page, and its submit parameter is
a JSF-generated id (`fPP:j_id244` at the time of writing) that must be read
from the page at runtime rather than hardcoded, because it can change on any
redeploy — this is exactly what the live regression test above guards
against. Second, both `*InputCurrentDate` calendar fields (RichFaces'
internal month/year state for its date pickers) must always be populated
with a valid `MM/YYYY`, even when no date filter is being applied at all; if
either is left empty, the calendar component fails to decode, and JSF
silently drops the date filter from the query instead of raising an error,
which reads as "search ignored my dates" with no diagnostic. Third, party and
lawyer names both require at least two space-separated tokens — a single
name is silently rejected by the server with a validation message the client
surfaces before ever sending the request. Fourth, an OAB state selected
without an OAB number is simply ignored by the server, so the client refuses
that combination up front rather than sending a query that quietly drops
half of what was asked for. Fifth, a normal AJAX response always carries an
`Ajax-Update-Ids` header naming which page region changed; when the button's
dead-code path is accidentally exercised, that header comes back as
`fPP:j_id248` (the message panel) instead of `fPP:processosGridPanel` (the
results table) — meaning the search action never actually ran. That is a
fundamentally different situation from a query that legitimately matched
zero rows, and the parser raises `ActionNotExecutedError` rather than
reporting zero results in either case, since silently reporting zero would
be indistinguishable from a real empty result. Sixth, and easy to miss
entirely: the request body must be encoded as `ISO-8859-1`, matching the
`charset=ISO-8859-1` this portal declares in its `Content-Type`, but
JavaScript's built-in `URLSearchParams` always percent-encodes as UTF-8
regardless of what charset you tell the server you're using. With that
mismatch, the server decodes UTF-8 bytes as Latin-1 and silently returns
wrong, truncated results — measured live, an accented name search returned
6 rows under `URLSearchParams`' UTF-8 encoding versus the correct 30 rows
under a proper ISO-8859-1 encoder.

## 429 handling

The HTTP client is the single chokepoint every request passes through, so
rate limiting and retry policy live in one place (`packages/scraper/src/http/client.ts`).
On a `429` response it backs off exponentially with jitter (base 1s, factor
2, ±25% jitter, capped at 60s per attempt, up to 5 attempts total), honouring
a server-supplied `Retry-After` header (either delay-seconds or an HTTP-date)
in preference to the computed backoff when one is present. A request that
exhausts every retry raises `RateLimitedError`; inside `crawl`, that surfaces
as a recorded row in the `failures` table (kind `summary_pdf`, keyed by id)
rather than aborting the run, so one persistently rate-limited id doesn't
stop the crawl from covering the rest of the range — a later run retries it.

Stated honestly: a `429` was never actually reproduced while testing this
scraper, up to 16 concurrent workers against the live `reportPDF.seam`
endpoint. Throughput saturates at roughly 3 requests/second past about 8
workers — the server absorbs added concurrency by slowing individual
responses down rather than rejecting requests outright. So the 429 handling
above is implemented in full because the challenge names it as a
requirement and because a long, sustained production run is exactly the
scenario most likely to eventually trigger it — but it is unverified against
an actual `429` response from this portal.

## Architecture

Two workspace packages, dependencies pointing one way (`scraper` depends on
`core`; `core` knows nothing about `scraper`):

- **`packages/core`** — storage. The SQLite schema (`cases`, `documents`,
  `probes`, `failures`), typed repositories over each table, and a
  filesystem-backed blob store for PDFs (`BlobStore`, swappable for e.g.
  cloud storage without touching callers).
- **`packages/scraper`** — everything that talks to the portal and to the
  user. The rate-limited/retrying HTTP client and cookie jar
  (`src/http/`), the PJe protocol client — session bootstrap, search payload
  building, response parsing (`src/pje/`) — the PDF parser
  (`src/pdf/`), the id-enumeration crawl engine (`src/crawl/`), and the CLI
  itself (`src/cli/`).

## Scope

This is phase 1: the crawl engine and the CLI surface. It covers every case
via `idProcessoTrf` enumeration and stores each case's summary PDF plus the
structured data parsed out of it (number, class, court, panel, distribution
date, subjects). Downloading each individual document within a case's file
(`case`/`deep`, and the search-side `--partition`) is phase 2 — the `documents`
table is already reserved in the schema for it, but the routes that populate
it are not implemented, and both commands say so explicitly rather than
pretending to work (exit code 2).

The corpus is roughly 133,000 cases by `idProcessoTrf`. At the sustainable
throughput measured above (a few requests/second) a full crawl takes many
hours. The challenge explicitly does not require a complete run — `crawl`'s
`--from-id`/`--to-id`/`--limit` flags exist to demonstrate the engine at
whatever scale is convenient (a few hundred cases is enough to exercise
resuming, retries, and the absent/transient/stored classification), not to
mandate running it to completion.
