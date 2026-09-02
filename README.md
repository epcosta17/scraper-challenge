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

While it works, `search` names the filters it is submitting and the two
steps it takes, on stderr (`--quiet` silences that; see *Progress output*):

```
Searching the portal: number=0013201-41.2025.4.05.8202
starting a session
submitting the search form
```

`--dry-run` works here too: it prints the filters `search` would submit and
makes no request at all — as a sentence by default, as a JSON plan under
`--json` (see *Machine-readable output*).

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

While it runs, `crawl`/`daily` print a periodic progress line to **stderr**
(never stdout — see *Progress output* below): a header saying what the run
is about to do, then roughly every 2 seconds of wall-clock time a line
naming the id currently in flight, the case it turned out to be, and the
running counts:

```
Crawling 31 ids (130100-130130), 4 at a time at 2 req/s -> db /tmp/i3.db, files /tmp/i3
… 8 ids checked (at id 130107, 0010020-83.2026.4.05.8400)  stored=8 absent=0 failed=0
… 17 ids checked (at id 130116)  stored=17 absent=0 failed=0
```

A fixed time interval, not a fixed number of ids, is what bounds the silence:
throughput swings a lot with `--concurrency` and how often the portal 429s, so
counting ids can't guarantee the terminal stays quiet for only a bounded
stretch the way a wall-clock interval does. A **failed id is not left to that
interval** — it is reported the moment it fails, with its reason, rather than
only surfacing as a number in the final `Failed:` count:

```
! id 130118 failed: Transient HTTP 404 from https://pjett.trf5.jus.br/…/reportPDF.seam?idProcessoTrf=130118
```

`--verbose` trades the periodic line for one line per id (see *Progress
output*).

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
the run continues. `--dry-run` prints the plan without touching the network,
the database, or disk, exactly like `crawl` — and, under `--json`, prints it
as JSON rather than prose.

While it runs, `deep` narrates the chain on **stderr**, naming each step as
it *starts* — every one of them takes seconds, and a case that only spoke
when it finished was several seconds of silence at a time. Each line is
tagged with the case it belongs to, so `--concurrency` above 1 (the default
is 4) stays attributable; the lines below are one real run, interleaved
exactly as the four cases produced them:

```
Scraping 4 cases (ids 130107-130110), 4 at a time -> db /tmp/i1.db, files /tmp/i1
[1/4 id 130107] fetching the summary PDF
[2/4 id 130108] fetching the summary PDF
[3/4 id 130109] fetching the summary PDF
[4/4 id 130110] fetching the summary PDF
[4/4 id 130110] ! summary PDF came back HTTP 404 - retry 1 of 4
[1/4 id 130107] ! summary PDF came back HTTP 404 - retry 1 of 4
[2/4 id 130108] got 0017596-39.2026.4.05.8300 (REMESSA NECESSÁRIA CÍVEL)
[2/4 id 130108] resolving the detail key: searching by case number
[2/4 id 130108] reading the case file
[2/4 id 130108] the case file lists 4 documents
[2/4 id 130108] downloading documents: 4 of 4
[2/4 id 130108] done: 0017596-39.2026.4.05.8300 - 4 documents (4 new)
```

The retries in there are the point, not noise: the summary PDF endpoint 404s
intermittently and retries up to three more times, and the search bridge
fails on roughly one run in four and re-runs with a fresh session (see
*Findings*). Both used to be pure silence in the middle of a step that
claimed to be doing something else. A failed case is likewise reported at
its own position, with its reason, not only in the final summary:

```
[3/4 id 130109] FAILED: No summary PDF for id 130109 (unassigned or sealed).
```

A case whose documents are already downloaded says so up front
(`downloading documents: 4 already on disk, nothing to fetch`) rather than
after the fact. See *Progress output* below for `--verbose`, `--quiet` and
the stdout/stderr split.

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

**Movimentações ≠ documentos.** A case's own procedural-movement timeline
links to acts through the same endpoint an HTML document uses, but never
carries that endpoint's `idProcessoDoc` parameter — verified live, such a
timeline link only ever re-fetches an act already listed as a real document
on the same page, or a page with no act on it at all. These links are not
documents and are never stored as one; only a trigger that carries a real
`idProcessoDoc` becomes a row in `documents`.

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

### Progress output

Every command that touches the network prints progress to **stderr** and its
actual result to **stdout** — so `--json` (and any other piping of the final
output) always stays clean, no matter how much progress a run prints
alongside it. How much progress there is, is one of three levels:

| Level | Flag | What lands on stderr |
|---|---|---|
| Quiet | `--quiet` | Nothing. The result still goes to stdout, as always. |
| Default | *(none)* | A header saying what the run is about to do, then every step of the work **as it starts**, plus every failure and every retry **as it happens**. |
| Verbose | `--verbose` | All of the above, plus each individual document and the HTTP requests, responses and retries underneath the narration. |

`--quiet` and `--verbose` are opposites, so passing both is rejected (exit
code 2) rather than letting one silently win.

**Steps are announced when they start, not when they finish.** Fetching a
summary PDF, resolving a detail key through the search bridge, reading a
case file and downloading its documents each take seconds; a line printed
only on completion means the terminal is silent for exactly as long as the
thing you would want to know about is happening. The same rule is what puts
retries on screen: both retrying paths in this scraper (the summary PDF's
intermittent 404s and the search bridge's `ActionNotExecutedError`, see
*Findings*) used to be silence in the middle of a step that had already
claimed to be doing something else.

**`--verbose`** adds the requests. A single case, start to finish, on a run
where the summary PDF needed one retry:

```
Scraping 1 case (id 130109) -> db /tmp/i2.db, files /tmp/i2
[1/1 id 130109] fetching the summary PDF
  → GET https://pjett.trf5.jus.br/pjeconsulta/…/reportPDF.seam?idProcessoTrf=130109
  ← 404  16.8 kB in 2472 ms
[1/1 id 130109] ! summary PDF came back HTTP 404 - retry 1 of 4
  → GET https://pjett.trf5.jus.br/pjeconsulta/…/reportPDF.seam?idProcessoTrf=130109
  ← 200  19.6 kB in 788 ms
[1/1 id 130109] got 0019122-32.2026.4.05.8400 (REMESSA NECESSÁRIA CÍVEL)
[1/1 id 130109] resolving the detail key: searching by case number
  → GET https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam
  ← 200  47.0 kB in 583 ms
  → POST https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam;jsessionid=…
  ← 200  5.8 kB in 559 ms
[1/1 id 130109] reading the case file
  → GET https://pjett.trf5.jus.br/pjeconsulta/…/listView.seam?ca=44792153139a99aa…
  ← 200  90.7 kB in 1503 ms
[1/1 id 130109] the case file lists 4 documents
[1/1 id 130109] downloading documents: 4 of 4
  → GET https://pjett.trf5.jus.br/pjeconsulta/…/documentoSemLoginHTML.seam?ca=9d14ecaf…&idProcessoDoc=12425121
  ← 200  54.6 kB in 751 ms
[1/1 id 130109]   + document id=12425121 (html) stored
…
[1/1 id 130109] done: 0019122-32.2026.4.05.8400 - 4 documents (4 new)
```

A 429 or a 5xx appears here too, before the wait rather than after it, so a
run that is about to go quiet for a minute has already said why:

```
  ↻ rate limited (HTTP 429) - waiting 2.0s before attempt 2 of 5
```

For `crawl`/`daily`, `--verbose` replaces the periodic heartbeat with one
line per id, which names the case a stored id turned out to be and the
reason a failed one failed:

```
+ id=130100  stored 0013475-36.2026.4.05.0000  (stored=1 absent=0 failed=0)
. id=130101  absent  (stored=1 absent=1 failed=0)
! id=130102  failed: Transient HTTP 404 from https://pjett.trf5.jus.br/…  (stored=1 absent=1 failed=1)
```

**`--quiet`** prints nothing at all to stderr — the case for it is a
scheduled run whose stderr nobody reads until the exit code says to:

```bash
npm run scraper -- deep --from-id 130107 --to-id 130108 --quiet --db /tmp/i5.db --out /tmp/i5
```

```
Cases done:        2
Cases failed:       0   (recorded in the failures table for retry)
Documents stored:   8
Documents skipped:  0   (already downloaded)
Documents failed:   0   (recorded in the failures table for retry)
```

(Node's own `ExperimentalWarning` about type stripping still appears on
stderr under `--quiet`: that comes from the runtime, not from this scraper.
`node --disable-warning=ExperimentalWarning` silences it.)

### Machine-readable output (`--json`)

`--json` swaps the human-readable result on stdout for a single JSON
document, and stdout carries nothing else: progress lines are on stderr
either way (see above), and the "re-run to retry" hint is suppressed
outright. Piping that output needs no further flag to stay parseable, with
one caveat that belongs to npm rather than to the scraper: `npm run` prints
its own two-line banner to stdout, so pipe from `npm run --silent scraper
-- ...`, or from `node --experimental-strip-types
packages/scraper/src/cli.ts ...` — which is exactly what the npm script
runs. The shape follows the command:

`search` — the rows the portal returned, and whether its 30-row cap was hit:

```json
{
  "rows": [
    {
      "idProcessoTrf": 129921,
      "number": "0013201-41.2025.4.05.8202",
      "ca": "76b81711e2c69f608d188fb631214485f3d19a12e7c30f6e"
    }
  ],
  "capped": false
}
```

`crawl` / `daily` — the same counters the summary prints, plus the last id
examined (the new watermark):

```json
{ "stored": 3, "absent": 0, "failed": 0, "lastId": 130105 }
```

`deep <number|id>` — one case's outcome. A case that failed is reported as
data too, not as an empty document: `{ "kind": "failed", "ref": "130101",
"error": "..." }`, where `ref` is the target as it was given.

```json
{
  "kind": "done",
  "idProcessoTrf": 130101,
  "number": "0000786-77.2026.4.05.8400",
  "documentsStored": 0,
  "documentsSkipped": 4,
  "documentsFailed": 0
}
```

`deep --from-id/--to-id` — the same counts aggregated over the whole range:

```json
{
  "casesDone": 3,
  "casesFailed": 0,
  "documentsStored": 9,
  "documentsSkipped": 0,
  "documentsFailed": 0
}
```

`--dry-run` — the plan, as data rather than as the sentence the default mode
prints. `dryRun` and `command` identify it; a bound the command would have
defaulted is `null` rather than a missing key, so "resume from the
watermark" is distinguishable from "start at id 1" without probing for
absence:

```bash
npm run scraper -- daily --dry-run --json
```

```json
{ "dryRun": true, "command": "daily", "fromId": null, "toId": null }
```

`search`'s plan carries `filters` instead, and `deep`'s carries `target`
(the single target, or `null` for a range) alongside `fromId`/`toId`.

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
| `--json` | Machine-readable output on stdout — including a `--dry-run` plan (progress, if any, stays on stderr — see *Machine-readable output*) |
| `--verbose` | Add the requests under the narration: URLs, status codes, retries, 429 backoff, plus a line per document and per crawled id (see *Progress output*) |
| `--quiet` | Print only the final result — nothing on stderr at all (see *Progress output*) |
| `--dry-run` | Plan the work without touching the network, the database, or disk (prints the plan as JSON under `--json`) |

**Top-level** (stand alone, in place of a command):

| Flag | Meaning |
|---|---|
| `--version` / `-v` | Print the installed version and exit |
| `--help` / `-h` | Print usage and exit |

## Where output lands

- **`data/pje.db`** — a SQLite database with:
  - **`cases`** — one row per case. Alongside number, class, court, panel,
    distribution date and subjects (parsed from the summary PDF, by both
    `crawl` and `deep`), three more columns come only from the case detail
    page (`deep` only, once it has fetched that page): `jurisdiction`
    (`TRF5` for every case observed so far), `court_address` (the deciding
    court's postal address) and `reference_number` (a related case number,
    when the page cites one). An existing database gains these columns
    automatically on its next open — see *Schema migrations* below.
  - **`parties`** — one row per participant listed on the detail page's Polo
    Ativo/Passivo tables (`deep` only): case id, `polo` (`ativo`/`passivo`),
    name, `document_type` (`cpf`/`cnpj`) and number, OAB registration,
    procedural role, and situation, each split out of the page's single
    free-text line. Both lists are paginated by the portal (a
    Richfaces.Datascroller, never driven by this scraper); when the parsed
    count disagrees with the page's own stated total, that's recorded as a
    `parties`-kind row in `failures` rather than silently stored as if the
    list were complete — the case itself still succeeds, with whatever rows
    *were* parsed kept. Re-running a case replaces its parties rather than
    duplicating them.
  - **`movements`** — one row per entry in the case's procedural log:
    case id, `position` (the log's own order), `timestamp`, `description`.
    There are two sources, and they are not equal.

    `deep` reads the case file's own "Movimentações do Processo" table, page
    by page — fifteen rows at a time, driven through the RichFaces number
    slider that pages it. `crawl` and `daily` have no case file in hand, so
    they parse the log out of the summary PDF every case already downloads,
    at no extra request.

    The table is the better one. Measured on case 0000292-82.2007.4.05.8400,
    whose page declares 4,182 movements: the table returns exactly that, the
    PDF returns 4,200. The eighteen extra are not movements — a hearing reads
    *"Audiência Instrução Realizada para 26/05/2008 17:11:00 Sala de
    Audiências."*, with a timestamp inside its own text, and the PDF parser
    delimits movements by timestamps, so it cuts there and invents a second
    entry saying only "Sala de Audiências.". Every case with a hearing has
    this. The PDF's text is dirtier too: *"Não- acolhidos"*, carrying the
    hyphen and space of a line wrap.

    So the PDF's version can never overwrite the table's. That rule lives in
    `replaceMovementsForCase`, not in its callers, because it is an invariant
    about the data: without it a `crawl` passing over an already-deep-scraped
    id silently degrades the case — 21 movements down to 19 — and `crawl`
    never loads the page it would need to notice. A same-or-better source
    always writes, so a second crawl still refreshes a case that only ever had
    the PDF's version.

    Paging costs one request per fifteen movements beyond the first: nothing
    at all for 85% of a real acervo, 2.6 on average, and 279 for the one case
    with 4,182 of them. The page size is not negotiable — `rows` is fixed in
    the server's own XHTML, and asking for a hundred returns fifteen.

    `deep` still cross-checks the stored count against the page's stated total
    and records a `movements`-kind `failures` row if they disagree. Re-running
    a case replaces its movements rather than duplicating them.
  - **`documents`** — one row per document `deep` has downloaded: a binary
    document's `pdf_key` into the blob store *and* its own `text_content`
    (extracted from the PDF itself — the same stream-walking extractor the
    summary PDF uses), or an HTML document's content directly in
    `text_content` with no blob at all.
  - **`probes`** (confirmed-absent ids) and **`failures`** (retryable or
    otherwise notable errors — including the parties/movements truncation
    checks above).
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

### Schema migrations

New tables are free (`CREATE TABLE IF NOT EXISTS`), but new *columns* on an
existing table are not — SQLite has no `ADD COLUMN IF NOT EXISTS`, and a
database from an older version of this project won't grow one on its own.
`openDatabase` runs a small, idempotent migration step on every open
(`migrateSchema` in `packages/core/src/schema.ts`): it checks each column
this project has ever added to `cases` via `PRAGMA table_info` and issues an
`ALTER TABLE ... ADD COLUMN` only for the ones actually missing. This makes
no difference to a fresh database (`SCHEMA` already created the columns, so
every check finds them present) and requires no separate migration command
to run against an existing one — just open it, the normal way any command
in this CLI already does.

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
  (`src/cli/`: argument parsing, pure formatters that turn a progress event
  into a line, and `reporter.ts`, which decides which of those lines the
  chosen `--quiet`/default/`--verbose` level actually prints — one place
  rather than a per-level branch at every call site).

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
