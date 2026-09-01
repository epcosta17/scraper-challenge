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

### `deep` — fetch a case and download every document in its file

Where `crawl` stops at the summary PDF, `deep` follows the whole chain to
the individual documents that make up a case's file:

```
idProcessoTrf --(reportPDF)--> summary PDF --(parse)--> case number
              --(search by number)--> ca
              --(detail page by ca)--> document list
              --(download each)--> the documents
```

The search bridge exists because the detail page only ever accepts `ca` — a
token the search results page and only the search results page hands out; the
detail page rejects the internal id outright, and `ca` cannot be derived, only
harvested. `deep` accepts either a single target or an explicit id range —
exactly one of the two, never both, never neither:

```bash
npm run scraper -- deep 0013201-41.2025.4.05.8202     # by case number
npm run scraper -- deep 130100                        # by internal id
npm run scraper -- deep --from-id 130100 --to-id 130120
```

A bare-digits argument is treated as the internal `idProcessoTrf`; anything
else is treated as a case number and resolved through the search bridge. For
a single target:

```
Case 0801438-34.2016.4.05.8102 (id 130100):
  Documents stored:  10
  Documents skipped: 0   (already downloaded)
  Documents failed:  0   (recorded in the failures table for retry)
```

For a range, the summary aggregates across every case:

```
Cases done:        20
Cases failed:       0   (recorded in the failures table for retry)
Documents stored:   142
Documents skipped:  0   (already downloaded)
Documents failed:   1   (recorded in the failures table for retry)
```

**Cost:** roughly **11 requests per case** — 1 summary PDF + 1 search (skipped
whenever a still-valid `ca` is already on file, see below) + 1 detail page +
~9 documents, based on the case used to build this feature. A single failed
document does not abort the case, and a single failed case does not abort a
range — both are recorded in `failures` (kind `deep_case` or `document`) and
the run continues. `--verbose` logs per-document progress as it happens;
`--dry-run` prints the plan without touching the network, the database, or
disk, exactly like `crawl`.

**Documents come in two shapes.** Binary documents (PDFs) are plain download
links and work cold, with no session required; each is written to
`<year>/<case-number>/documents/<date>-<type>-<id>.pdf` next to the case's own
summary PDF. HTML documents (the text of a judicial act, rendered inline
rather than as a file) carry a *second*, session-bound `ca` that only
resolves with the same cookie jar that fetched the detail page — their
content is stored directly in the `documents` table (`text_content`) rather
than as a separate file, since there's no blob worth writing. A recent case
can legitimately have zero binary documents (verified live: a 2026 case had 2
HTML documents and 0 binary ones), so that outcome is not treated as an
error. A document already downloaded in a previous run is skipped without a
request, which is what makes re-running `deep` over the same target or range
cheap.

**`ca` is a cache, not a fact.** It is stable within a time window but expires
after some hours (verified live: a `ca` captured 14 hours earlier no longer
worked). `deep` reuses whatever `ca` is already stored for a case and only
falls back to the search bridge — re-deriving `ca` and updating the stored
value — when the detail page itself reports that the cached one is stale.
There is no separate expiry timestamp to track: the detail page's own
response is the check, and it can't go out of date the way a cached
timestamp could.

### `case` — phase 2, not implemented yet

`case` (fetch one case's stored data by number or internal id, without
touching its documents) parses and validates its arguments but then exits
with **status code 2** and an explanatory message, rather than silently doing
nothing or pretending to work:

```bash
npm run scraper -- case --number 0013201-41.2025.4.05.8202
```

```
Command "case" is a phase-2 feature and is not implemented yet. Use 'search'
to find a case, or 'crawl' to enumerate cases and download summary PDFs.
```

### `daily` — advance the watermark

A `crawl` with no explicit range: it always resumes from the stored watermark
and scrapes forward from there, which makes it the natural thing to run on a
schedule. It rejects `--from-id`/`--to-id` outright (use `crawl` if you need an
explicit range) so a scheduled run can never be accidentally pointed somewhere
else:

```bash
npm run scraper -- daily
```

On a fresh database — no cases stored yet, so the watermark is `0` — `daily`
starts at id `1`. Depending on how low ids happen to be allocated, that
either stops quickly after 50 consecutive misses (see `stopAfterMisses`) or,
if low ids turn out to be assigned cases, begins a full crawl of the roughly
133,000-case corpus, which at the throughput measured in *429 handling* below
takes many hours. `daily` is meant to be run against a database that already
has a reasonably current watermark (e.g. seeded by an initial `crawl`); on a
genuinely empty one, run `crawl` with an explicit `--to-id` or `--limit`
first if a full walk from id 1 isn't what's wanted.

### How resuming works

`crawl` and `daily` need no session or checkpoint file to resume: the summary
PDF endpoint is stateless (see *Findings*), and the watermark is simply
`MAX(id_processo_trf)` already in `cases`. Restarting after an interruption —
a crash, a Ctrl-C, a scheduled run picking up where yesterday's left off — is
just running the command again with no extra bookkeeping. Ids that failed
non-permanently are kept in `failures` (see *429 handling* below); retrying
them means re-running `crawl` with an explicit `--from-id`/`--to-id` range
that covers them — a default re-run resumes from the watermark and, since
the watermark only advances past *stored* ids, will not revisit a lower id
on its own. Once a previously failed id is stored successfully, its
`failures` row is marked resolved.

Ids that were confirmed absent are recorded in `probes`, but purely for
visibility — `crawl` never consults that table to skip an id, so a re-run
over the same range re-probes every previously-absent id again rather than
treating the earlier miss as permanent. This is intentional, not an
oversight: unlike a stored case, "absent" is not a stable fact about an id.
A case can be placed under judicial secrecy after being public, or a
previously sealed case can later become public, so treating an old miss as
permanently settled would mean never noticing either transition.

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
| `--verbose` | Per-id progress logging during `crawl`/`daily` — no effect on `search` |
| `--dry-run` | Plan the work without touching the network, the database, or disk |

**Top-level** (stand alone, in place of a command):

| Flag | Meaning |
|---|---|
| `--version` / `-v` | Print the installed version and exit |
| `--help` / `-h` | Print usage and exit |

## Where output lands

- **`data/pje.db`** — a SQLite database with `cases`, `documents` (one row per
  document `deep` has downloaded — a binary document's `pdf_key` into the
  blob store, or an HTML document's content directly in `text_content`),
  `probes` (confirmed-absent ids), and `failures` (retryable errors).
- **`data/pdfs/`** — one summary PDF per case at
  `<filing-year>/<case-number>/summary.pdf`, and, once `deep` has run for
  that case, its binary documents alongside it at
  `<filing-year>/<case-number>/documents/<date>-<type>-<id>.pdf`, e.g.

  ```
  data/pdfs/2016/0801438-34.2016.4.05.8102/
    summary.pdf
    documents/
      24-07-2025_20-30-45-Despacho-12284583.pdf
      03-06-2022_12-15-47-Despacho-12284566.pdf
      ...
  ```

  HTML documents have no file here — their content lives only in the
  database (see above).

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

The offline suite — everything `npm test` runs by default — runs entirely
against fixtures and never makes a network call, which is what makes it safe
to run in CI and safe to run repeatedly while developing. (Its exact test
count drifts as the suite grows; run `npm test` for the current number
rather than trusting a figure written down here.)

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

**Success is decided by the response body, never the status code alone.**
Both an absent id (unassigned or out of range) and a sealed case ("segredo
de justiça") return **HTTP 200** with a specific, recognised HTML error page
(matched by its redirect URL or a diagnostic marker in the body — see
`looksLikeErrorSeam`), never a 404. Classification checks the body in order:
`%PDF-` as the first five bytes means success; failing that, an HTTP 200
response that actually looks like the known error page means absent;
anything else — an intermittent non-200 status (observed live as an
intermittent HTTP 404 from one unhealthy backend node behind the load
balancer), or an HTTP 200 with an *unrecognised* body (a maintenance page, a
bot-manager interstitial, a login redirect, or any other portal-wide shape
change) — is *transient*. The three must never be conflated.
`fetchReportPdf` retries a bounded number of times before giving up as
transient, and the two failure outcomes are recorded differently: an absent
id is recorded in `probes`, and a transient failure is recorded in
`failures` and is retried on a later `crawl` run. Absence is not treated as
permanent — see *How resuming works* above: `crawl` re-probes a
previously-absent id on every re-run instead of skipping it, since a case
under seal can later become public. Treating a transient failure as an
absent case would silently and permanently lose a case that actually
exists; treating an absent case as transient would mean retrying roughly
15% of the entire crawl forever, for no gain.

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
2, ±25% jitter, up to 5 attempts total), honouring a server-supplied
`Retry-After` header (either delay-seconds or an HTTP-date) in preference to
the computed backoff when one is present. The delay is **capped at 60s per
attempt** either way — the same cap bounds both the computed backoff and an
honoured `Retry-After`, so a server sending `Retry-After: 86400` sleeps a
worker for at most 60s, not 24 hours. A `429` also pushes every worker's next
request out by that delay, not just the one that got rejected — otherwise
the other `concurrency-1` workers would keep firing at full `--rate` and the
crawl's aggregate rate would never actually drop under a real rate limit. A
request that exhausts every retry raises `RateLimitedError`; inside `crawl`,
that surfaces as a recorded row in the `failures` table (kind `summary_pdf`,
keyed by id) rather than aborting the run, so one persistently rate-limited
id doesn't stop the crawl from covering the rest of the range — a later run
retries it.

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
  building, response parsing, case detail parsing, document download
  (`src/pje/`) — the PDF parser (`src/pdf/`), the id-enumeration crawl engine
  and the deep (case-to-documents) engine (`src/crawl/`), and the CLI itself
  (`src/cli/`).

## Scope

Phase 1 built the crawl engine and the CLI surface: every case reachable via
`idProcessoTrf` enumeration, each with its summary PDF and the structured
data parsed out of it (number, class, court, panel, distribution date,
subjects). Phase 2 added `deep`: the chain from a case to the PDFs (and HTML
documents) of every document in its file — see *`deep`* above for the chain,
the two document shapes, and the `ca`-expiry handling. `case` (fetch one
case's already-stored data by number or internal id, with no network calls)
remains unimplemented and still exits 2 rather than pretending to work, as
does the search-side `--partition` (automatic subdivision of a capped
30-result search).

The corpus is roughly 133,000 cases by `idProcessoTrf`. At the sustainable
throughput measured above (a few requests/second) a full crawl takes many
hours. The challenge explicitly does not require a complete run — `crawl`'s
`--from-id`/`--to-id`/`--limit` flags exist to demonstrate the engine at
whatever scale is convenient (a few hundred cases is enough to exercise
resuming, retries, and the absent/transient/stored classification), not to
mandate running it to completion.
