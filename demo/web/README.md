# `@pje-trf5/web` — Consulta Procesal

The five screens of `web.pen`, as a server-rendered Astro app over the SQLite
file the scraper writes. Spanish interface, Portuguese court data — the same
border the design draws.

## Running it

From the repository root:

```sh
npm install
npm run scraper -- deep --from-id 130103 --to-id 130112   # fill data/pje.db
npm run dev --workspace demo/web                          # http://localhost:4321
```

Production:

```sh
npm run build --workspace demo/web
npm run start --workspace demo/web     # node ./dist/server/entry.mjs
```

`npm run typecheck --workspace demo/web` type-checks the data layer and the
helpers; `npm test` from the root runs `demo/web/tests` alongside the packages'.
(`astro check` is not wired up: it resolves the repo's TypeScript 7 and its
language server cannot run on it. `astro build` still fails on anything that
does not compile.)

## Where the data comes from

| Variable | Default | What it is |
| --- | --- | --- |
| `PJE_DB` | `data/pje.db` | the SQLite file, the scraper's `--db` |
| `PJE_PDFS` | `data/pdfs` | the blob store, the scraper's `--out` |

The defaults hang off the **repository root** — found by walking up to the
`package.json` that declares `workspaces` — not off the working directory:
`npm run dev --workspace demo/web` starts in `demo/web`, and a default relative
to that would quietly create an empty second database next to the app. An
override that is relative resolves against the directory the server was started
in.

If the file is not there, is empty, or will not open, every screen says so at
the top and answers with real zeroes. Nothing is ever created on the app's way
past: an empty database at the wrong path looks exactly like a court with no
cases in it.

## Routes

| Route | Screen |
| --- | --- |
| `/` | `01 Expedientes` — the acervo, paginated |
| `/expedientes/:numero` | `02 Ficha del expediente` |
| `/expedientes/:numero/resumen.pdf` | the portal's summary PDF for the case |
| `/chat` | `03 Chat` — the same index, asked in prose |
| `/procesos` | `04 Procesos` — the queue, and the only place that writes |
| `/busqueda` | `05 Búsqueda` — the portal's eight criteria, plus full text, over the acervo |
| `/documentos/:id` | one stored document, inline or `?descargar` |

`/procesos` is not in the design's nav, which carries only Expedientes,
Búsqueda and Chat on all five screens. It is reached from the sync pill in the
top right: that pill *is* the capture status, so it links to the screen that
explains it.

## The data layer

Everything the app knows about storage lives in `src/data/`:

- `types.ts` — the view types the templates render.
- `source.ts` — the `WebDataSource` interface.
- `config.ts` — which database and which PDF directory.
- `sqlite/` — the implementation over `@pje/core`'s repositories.
- `index.ts` — **the seam.** One expression picks the implementation.

No page opens a database and no storage row shape reaches a template. Every
method is `async` so a synchronous better-sqlite3 implementation and a remote
one are both drop-ins, and none of them throws for a missing acervo.

## Four things that are not decoration

**Completeness.** `Coverage` (`{ captured, declared }`) is the type behind every
count the portal also declares a total for. The declared totals are not columns:
when a list comes back short the scraper files a `failures` row and puts both
numbers in its message, and `sqlite/declared.ts` is what reads them back out. So
`0024885-29.2005.4.05.0000` renders as `11 / 41` in the warning colour, the
capture panel flips to *Incompleto*, a notice says how many rows are missing and
why, and the scraper's own account of the gap is printed underneath. A truncated
list is never presented as a complete one.

**The 30-row cap.** The portal cuts every query at 30 rows *in the server-side
query*, so no parameter and no page number gets past it. That is still true, and
it is exactly why `/busqueda` searches the captured acervo instead: the crawl is
what buys coverage the public form cannot give. The banner says so in words.

**A control that cannot filter is not drawn.** `/busqueda` carries the eight
criteria of the portal's own form — number, distribution date range, class,
party, lawyer, CPF/CNPJ, OAB, reference — because every one of them is a column
the acervo stores, and `searchAcervo` in `@pje/core` answers them in the same
statement as the text query, so the ranking and the total describe the same
rows. Where the acervo and the portal differ, the screen says so instead of
pretending: the date field is labelled *distribución*, which is the date a case
file prints, not the *autuación* the portal filters on; the class control offers
the classes the acervo holds, with their counts, not the CNJ's 132; and the OAB
state offers the UFs actually captured. The portal's two-name minimum on party
and lawyer is not enforced, because it is a rule of its server and not of this
index.

**No invented progress.** `jobs` records what a job is and what has happened to
it — attempts, when the current attempt started, when it ended, why it failed —
and nothing writes "217 of 300" anywhere. The queue shows the columns that
exist and says, in a line under the table, that the progress column does not.

## What writes

Exactly one thing: the "Encolar proceso" form on `/procesos`, which inserts one
row into `jobs` through `enqueueJob` and redirects. An external worker claims it
and does the capturing. The payload shapes the two halves agree on are written
down in `src/data/sqlite/jobs.ts`.

## No client framework

There is none, and nothing needs one. Pagination, the movement "ver todos"
toggle and the document links are links; search and chat are plain GET forms;
the queue is a POST form whose segmented control is four radio inputs. The
acervo's three column filters (Clase, Órgano, Periodo) are the only controls
still rendered `disabled` — they need query surface that does not exist yet, and
a dead control is more honest than one wired to nothing.

## Responsive

The design is drawn at 1440. Degrading, in order:

- **≥1080px** — as drawn: two-column screens keep their fixed aside
  (520 / 460 / 440px) beside a fluid column.
- **1080px** — the asides unstack and become full-width blocks below (or above,
  for the search form, which is the input to what follows).
- **1120px** — the acervo table stops being a table. Each case becomes a block
  with its number on top and the rest labelled, because six columns of legal
  metadata cannot shrink honestly.
- **900 / 560px** — the 48px gutter steps down to 28 and then 18.
- Below that, the party, movement, job and result rows drop to a single column
  in the same way, and the nav wraps brand → links → status.

Titles are `clamp()`ed rather than stepped, so type scales continuously instead
of snapping at a breakpoint.
