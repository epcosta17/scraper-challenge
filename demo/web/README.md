# `@pje-trf5/web` — Consulta Procesal

The five screens of `web.pen`, as a server-rendered Astro app. Spanish
interface, Portuguese court data — the same border the design draws.

## Running it

From the repository root:

```sh
npm install
npm run dev --workspace demo/web       # http://localhost:4321
```

Production:

```sh
npm run build --workspace demo/web
npm run start --workspace demo/web     # node ./dist/server/entry.mjs
```

`npm run typecheck --workspace demo/web` type-checks the data layer and the
helpers. (`astro check` is not wired up: it resolves the repo's TypeScript 7 and
its language server cannot run on it. `astro build` still fails on anything that
does not compile.)

## Routes

| Route | Screen |
| --- | --- |
| `/` | `01 Expedientes` — the acervo, paginated |
| `/expedientes/:numero` | `02 Ficha del expediente` |
| `/chat` | `03 Chat` |
| `/procesos` | `04 Procesos` — capture queue and failures |
| `/busqueda` | `05 Búsqueda` — the portal's public form |

`/procesos` is not in the design's nav, which carries only Expedientes,
Búsqueda and Chat on all five screens. It is reached from the sync pill in the
top right: that pill *is* the capture status, so it links to the screen that
explains it.

## Where the real database plugs in

Everything the app knows about storage lives in `src/data/`:

- `types.ts` — the view types the templates render.
- `source.ts` — the `WebDataSource` interface. Six async methods, nothing else.
- `fixtures.ts` — today's implementation: the sample rows lifted from the design.
- `index.ts` — **the seam.** One expression picks the implementation.

Connecting SQLite means writing a source over `@pje-trf5/core`'s repositories
and changing that one line in `index.ts`. No page opens a database, no page
imports `fixtures.ts`, and no storage row shape reaches a template.

Every method is `async` so a synchronous `better-sqlite3` implementation and a
remote one are both drop-ins.

## Two things that are not decoration

**Completeness.** `Coverage` (`{ captured, declared }`) is the type behind every
count the portal also declares a total for. When they disagree — the detail
page's Datascroller only ever paints ten parties, a document download 429s out —
the number renders as `10 / 41` in the warning colour, the capture panel flips to
*Incompleto*, and a notice above the list says how many rows are missing and
why. A truncated list is never presented as a complete one. See
`0024885-29.2005.4.05.0000` (parties) and `0800245-51.2020.4.05.8002`
(documents).

**The 30-row cap.** `searchPortal` returns `rowLimit` and `capped` alongside the
hits. The portal cuts every query at 30 rows *in the server-side query*, so no
parameter and no page number gets past it — which is why the screen has no
pagination. The banner says that in words; it is not reduced to an icon.

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

## No client framework

There is none, and nothing needs one. Pagination and the movement "ver todos"
toggle are links; the portal search is a plain GET form. The controls the mock-up
cannot honour yet (acervo filters, "refrescar expediente", "encolar proceso") are
rendered `disabled` rather than wired to nothing.
