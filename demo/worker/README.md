# `demo/worker` — the queue drainer

The web app enqueues; this runs what is in the queue. It is a drainer and
nothing else: every job turns into one call into `@pje/scraper`, and nothing
about the scraping is reimplemented here.

**There is no scheduler.** No cron, no `node-cron`, no periodic `discover`.
You start a worker when there is work to do, and it stops when there is none.

```
npm run worker -- --db data/pje.db --out data/pdfs
```

## Draining, and `--watch`

By default the worker drains the queue and exits. That is the shape that fits
a manual model: you start it *because* something was enqueued, and a command
that ends when the work does has an exit code worth reading (`0` clean, `1`
some job failed, `2` bad flags, `130` you stopped it) and nothing to
supervise. It composes — `enqueue && npm run worker` is a script.

`--watch` keeps it polling an empty queue instead, which is what you want
while clicking around the demo app: enqueue from a page, and the worker
already running in another terminal picks it up within a second.

Running several at once is fine and needs no coordination. `claimNextJob` is
a single atomic statement (see `packages/core/src/repositories/jobs.ts`) and
nothing here wraps it in logic that could reopen the window it closes.

## Job types

| type | engine call | payload |
| --- | --- | --- |
| `crawl` | `crawl()` | `{ fromId?, toId?, limit?, concurrency?, stopAfterMisses? }` |
| `deep_case` | `deepCase()` | `{ idProcessoTrf }` or `{ number }` |
| `deep_range` | `deepRange()` | `{ fromId, toId, concurrency? }` |
| `refresh_case` | `deepCase()` | `{ idProcessoTrf }` or `{ number }` |
| `discover` | `crawl()` | an older name for a `crawl` with no explicit range |
| `backfill` | `crawl()` | an older name for a `crawl` over one |

One type per engine entry point, and the payload carries the rest. A `crawl`
with no `fromId` resumes from the stored watermark; with no `toId` it walks
on until a streak of consecutive misses ends it. `deep_range` requires both
ends, exactly as `deepRange` does — a deep run has no miss heuristic to close
an open range with, because every case costs a detail page and its documents.

`refresh_case` is `deepCase` with a precondition: the case must already be
stored. That is what makes it a separate type rather than a synonym.
Enqueuing one for an id nobody has ever captured is a mistake — most likely a
typo — and quietly turning it into a first-time capture would hide that. It
also means a case number resolves to its id straight out of SQLite, so a
refresh never pays for the search bridge.

Payloads are validated strictly, **unknown keys included**. A `crawl` whose
`fromId` was typed `fron` is still a perfectly valid `crawl`, so ignoring the
key would silently scrape a different range and exit 0 as though nothing were
wrong.

Enqueue from Node:

```js
import { openDatabase, enqueueJob } from '@pje/core'
const db = openDatabase('data/pje.db')
enqueueJob(db, 'crawl', { fromId: 130100, toId: 130140 })
enqueueJob(db, 'deep_case', { number: '0013201-41.2025.4.05.8202' })
```

## Progress

Progress lives on the job's own row, in `jobs.progress_done`,
`jobs.progress_total` and `jobs.progress_total_is_estimate` — added by the
same guarded-`ALTER` migration path `cases` already uses, so an existing
database picks them up when it is opened.

On the row rather than in a table of their own because they are one-to-one
with a job: the only writer already holds that row, every reader is already
selecting it, and a separate table would buy a join and a second lifecycle to
keep in step for nothing.

What is counted depends on what the job has a denominator for:

- `crawl`, `deep_range` — **ids**, against the size of the range. A `crawl`
  bounded only by `limit` reports that as an estimate (`totalIsEstimate`),
  since a run of misses can still end it early; a `crawl` with neither bound
  reports no total at all, because there is no honest number to divide by.
- `deep_case`, `refresh_case` — **documents**. One case is one unit at the
  job level and would only ever render 0/1, while a case file with forty
  documents is minutes with nothing to show. The total is unknown until the
  detail page has been read, so it starts null.

Reports are coalesced to one write every 250ms. They are pure overwrite — a
dashboard reading `217` has no use for the fact that `216` happened — so a
report overtaken inside that window is dropped rather than queued, and the
final count is flushed when the job ends.

`progress_done` describes the *current* attempt: it resets whenever the job
goes back into the queue, so a pending job never renders as part-finished. A
job that fails terminally keeps its count, which is the opposite call for the
opposite reason — "failed after 217 of 300" is the most useful thing that row
can still say, and no further attempt is coming to overwrite it.

## Stopping without leaving anything behind

Neither `crawl` nor `deepCase` takes an abort signal, so a stop is a choice
between two honest behaviours and you make it:

- **Ctrl-C once** — stop claiming, let the job in flight finish normally.
  Nothing wasted, nothing half-done.
- **Ctrl-C again** — hand the running job straight back to the queue and go.
  The request in flight is abandoned mid-air, but the job is not lost:
  `releaseJob` has committed it back to `pending` before the process exits,
  with its attempt refunded (an operator's interrupt says nothing about the
  job) and its progress reset. Both engines are resumable and skip what is
  already stored, so redoing it costs far less than the whole job.

The one thing that must never happen is a job left `running` with nobody
working on it. For the kill that cannot be caught — `SIGKILL`, an OOM, a
pulled cable — there is a lease: the worker stamps `jobs.heartbeat_at` when
it claims and renews it every 5s while it works, and any worker sweeps
cold leases when it starts (and, under `--watch`, on every idle poll).

```
↺ 1 job left running by a worker that died — returned to the queue
▶ job 1  crawl  {"fromId":130100,"toId":130140}  (attempt 2)
```

Unlike an interrupt, a reclaim does **not** refund the attempt: nothing
proves the job innocent of whatever killed the worker holding it, and it
applies the same attempt budget `failJob` does, so a job that reliably takes
workers down reaches `failed` instead of looping forever. A worker also
refuses to write the outcome of a job whose lease it has lost — the attempt
number it was claimed with is what tells its own attempt from a successor's.

## Failure

A failed job goes back to `pending` while attempts remain (`--attempts`,
default 3) and to `failed` once they are spent. The worker carries on either
way; a failure never takes it down.

Which failures fail the *job* is partitioned by whether the work has a part
worth keeping:

- **A single-target job is its one case.** `deep_case` and `refresh_case`
  fail when the case fails — there is no partial success to preserve, and a
  job reported `done` for a case that was never captured is a lie the queue
  then cannot retry.
- **A range is not.** `crawl` and `deep_range` walk past individual
  failures, which are recorded in the `failures` table for a later run over
  the same ids. Failing the job over 1 bad id in 300 would mean redoing 299
  that worked.
- **A malformed job fails at once**, attempts unspent. A bad payload or an
  unknown type fails identically on every attempt, and a returned job is
  `pending` with the lowest id — so it is the very next thing claimed, and
  retrying it would only block the queue behind it while dressing a permanent
  mistake up as bad luck.

## Options

```
--db <path>            SQLite database holding the queue (default data/pje.db)
--out <dir>            where PDFs are written (default data/pdfs)
--types <a,b>          claim only these job types (default: whatever is next)
--watch                keep polling once the queue empties, instead of exiting
--poll-interval <ms>   how often --watch looks again (default 1000)
--max-jobs <n>         stop after n jobs, leaving the rest queued
--concurrency <n>      requests in flight inside one job (default 4)
--rate <n>             requests per second against the portal (default 2)
--lease <seconds>      how long a job may go silent before another worker may
                       take it over (default 60)
--attempts <n>         attempts a failing job gets before it is given up on
                       (default 3)
--json                 print the run summary as JSON on stdout
--quiet | --verbose    how much the run says about itself while it works
```

`--types` is how you split a queue across machines — one worker on
`deep_case,deep_range`, another on `crawl` — without either of them
interfering with the other's claims.

Everything printed while working goes to stderr; stdout carries the run
summary exactly once, at the end, so `--json` stays pipeable.
