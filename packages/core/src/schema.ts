import type Database from 'better-sqlite3'

// Not imported from `./db.ts` — that module imports `SCHEMA` from here, and
// a value-level import back would be circular. `Db` is a type-only alias
// (identical to the one `db.ts` exports), and `import type` is erased
// entirely at runtime, so this direction carries no such risk.
type Db = Database.Database

/**
 * `probes` is deliberately separate from `failures`: an id with no PDF is an
 * expected outcome (secret or unassigned), not an error. Mixing them would
 * bury genuine failures under ~15k routine misses.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS cases (
  id_processo_trf INTEGER PRIMARY KEY,
  number          TEXT NOT NULL UNIQUE,
  ca              TEXT,
  class_code      TEXT,
  class_name      TEXT,
  court           TEXT,
  panel           TEXT,
  distributed_at  TEXT,
  subjects_json   TEXT NOT NULL DEFAULT '[]',
  parties_json    TEXT NOT NULL DEFAULT '[]',
  summary_pdf_key TEXT,
  jurisdiction    TEXT,
  court_address   TEXT,
  reference_number TEXT,
  first_seen_at   TEXT NOT NULL,
  last_scraped_at TEXT NOT NULL,
  -- Where this case's movements came from: the case file's own table, or the
  -- summary PDF. Kept because the two are not equal and the better one must
  -- not be overwritten by the worse — see replaceMovementsForCase.
  movements_source TEXT
);

-- One row per participant listed in the detail page's Polo Ativo/Passivo
-- tables. Keyed only by an autoincrement id, not by any natural key: a case
-- can legitimately relist the same name (e.g. a party appearing under two
-- roles), so uniqueness is enforced procedurally instead — see
-- \`replacePartiesForCase\`, which deletes every row for a case and
-- reinserts the current list inside one transaction, rather than by an
-- ON CONFLICT upsert.
CREATE TABLE IF NOT EXISTS parties (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  id_processo_trf  INTEGER NOT NULL REFERENCES cases(id_processo_trf),
  polo             TEXT NOT NULL,
  name             TEXT NOT NULL,
  document_type    TEXT,
  document_number  TEXT,
  oab              TEXT,
  role             TEXT,
  situation        TEXT
);
CREATE INDEX IF NOT EXISTS idx_parties_case ON parties(id_processo_trf);

-- One row per entry in the "Movimentações do Processo" table, in the page's
-- own order (\`position\`). Same replace-on-rerun rule as \`parties\` — see
-- \`replaceMovementsForCase\`.
CREATE TABLE IF NOT EXISTS movements (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  id_processo_trf  INTEGER NOT NULL REFERENCES cases(id_processo_trf),
  position         INTEGER NOT NULL,
  timestamp        TEXT,
  description      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movements_case ON movements(id_processo_trf);

CREATE TABLE IF NOT EXISTS documents (
  id_processo_documento INTEGER PRIMARY KEY,
  id_processo_trf       INTEGER NOT NULL REFERENCES cases(id_processo_trf),
  id_bin                INTEGER,
  numero_documento      TEXT,
  label                 TEXT,
  doc_type              TEXT,
  doc_date              TEXT,
  pdf_key               TEXT,
  text_content          TEXT,
  downloaded_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_case ON documents(id_processo_trf);

CREATE TABLE IF NOT EXISTS probes (
  id_processo_trf INTEGER PRIMARY KEY,
  status          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 1,
  last_probed_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS failures (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,
  ref             TEXT NOT NULL,
  error           TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 1,
  last_attempt_at TEXT NOT NULL,
  resolved_at     TEXT,
  -- Which case this failure belongs to, when it belongs to one.
  --
  -- The ref names the thing that failed, and for a document that is its own
  -- id — which for an unrecognised link is a synthetic hash of the href, and
  -- so names nothing anybody can act on. Without this column a document failure
  -- could be read but not retried: the case that would fix it was known at
  -- the moment it was recorded and then thrown away. Null for a failure that
  -- is not about a case, and on rows written before this column existed.
  id_processo_trf INTEGER,
  UNIQUE (kind, ref)
);

-- The work queue: a web front end enqueues, one or more external workers
-- drain it. Distinct from \`failures\`, which is a record of what went wrong
-- during a run that already happened; this is a record of what has yet to
-- happen.
--
-- \`status\` carries a CHECK because its four values are the whole state
-- machine \`claimNextJob\`/\`completeJob\`/\`failJob\` implement — a fifth one
-- could only ever be a bug, and a job stuck in an unknown state is invisible
-- to every query the workers run. \`type\` deliberately carries no CHECK: the
-- set of job types is expected to grow, and SQLite cannot alter a CHECK
-- constraint without rebuilding the table, so encoding that list here would
-- turn "add a job type" into a migration. It is constrained in TypeScript
-- (\`JobType\`) instead, where it costs nothing to extend.
--
-- \`started_at\`/\`finished_at\` describe the *current* attempt, not the first
-- one: a retry clears them (see \`failJob\`), so "pending with attempts = 2"
-- reads as what it is.
--
-- \`progress_done\`/\`progress_total\` live here, on the job's own row, rather
-- than in a table of their own: they are one-to-one with a job, every writer
-- of them already holds that row (the worker that claimed it), and every
-- reader of them is already selecting it, so a separate table would buy a
-- join and a second lifecycle to keep in step for nothing. They describe the
-- *current* attempt and are reset whenever the job goes back to the queue.
--
-- \`heartbeat_at\` is the lease. A worker refreshes it while it works, and
-- \`reclaimStaleJobs\` uses its age to tell a job still being worked on from
-- one stranded \`running\` forever by a worker that was killed. Without it a
-- SIGKILL leaves a row no other worker will ever claim.
CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT,
  error        TEXT,
  progress_done              INTEGER NOT NULL DEFAULT 0,
  progress_total             INTEGER,
  progress_total_is_estimate INTEGER NOT NULL DEFAULT 0,
  -- What the job is doing right this second, in the engine's own words
  -- ("reading the case file"). A counter alone cannot say this: a single case
  -- spends most of its time before the first document is even known, and a row
  -- stuck at 0 with no total reads as a run that has hung. Cleared when the
  -- job stops running, because a stage is only true while it is happening.
  stage                      TEXT,
  heartbeat_at               TEXT
);

-- The index \`claimNextJob\` rides: its inner SELECT is
-- \`WHERE status = 'pending' [AND type IN (...)] ORDER BY id LIMIT 1\`, which
-- this turns into a single b-tree seek rather than a scan over a queue that
-- is mostly finished rows.
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, id);
CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type, status, id);
`

/**
 * `CREATE TABLE IF NOT EXISTS` (above) only ever helps a table that doesn't
 * exist yet — it does nothing for a database created by an older version of
 * this schema that is now missing a column `cases` has since grown
 * (`jurisdiction`, `court_address`, `reference_number`). SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so each addition is guarded by its own
 * `PRAGMA table_info` check instead; run unconditionally on every
 * `openDatabase` call, it is a no-op — same as the `CREATE TABLE`
 * statements above — once every column already exists, which makes it safe
 * to call on both a fresh database (nothing to do; `SCHEMA` already created
 * the column) and one created before this migration existed.
 */
function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((r) => r.name === column)
}

/**
 * Every column added to a table after that table first shipped, with the
 * `ALTER` that adds it. Guarded one by one against `PRAGMA table_info`, so
 * running the whole list on a database that already has them is a no-op.
 * SQLite accepts `NOT NULL` in an `ADD COLUMN` as long as a default comes
 * with it — which is what backfills the existing rows.
 */
const COLUMN_MIGRATIONS: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
  { table: 'cases', column: 'jurisdiction', ddl: 'ALTER TABLE cases ADD COLUMN jurisdiction TEXT' },
  { table: 'cases', column: 'court_address', ddl: 'ALTER TABLE cases ADD COLUMN court_address TEXT' },
  { table: 'cases', column: 'reference_number', ddl: 'ALTER TABLE cases ADD COLUMN reference_number TEXT' },
  { table: 'jobs', column: 'progress_done', ddl: 'ALTER TABLE jobs ADD COLUMN progress_done INTEGER NOT NULL DEFAULT 0' },
  { table: 'jobs', column: 'progress_total', ddl: 'ALTER TABLE jobs ADD COLUMN progress_total INTEGER' },
  { table: 'jobs', column: 'progress_total_is_estimate', ddl: 'ALTER TABLE jobs ADD COLUMN progress_total_is_estimate INTEGER NOT NULL DEFAULT 0' },
  { table: 'jobs', column: 'heartbeat_at', ddl: 'ALTER TABLE jobs ADD COLUMN heartbeat_at TEXT' },
  { table: 'jobs', column: 'stage', ddl: 'ALTER TABLE jobs ADD COLUMN stage TEXT' },
  { table: 'failures', column: 'id_processo_trf', ddl: 'ALTER TABLE failures ADD COLUMN id_processo_trf INTEGER' },
  { table: 'cases', column: 'movements_source', ddl: "ALTER TABLE cases ADD COLUMN movements_source TEXT" },
]

export function migrateSchema(db: Db): void {
  for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
    if (!hasColumn(db, table, column)) db.exec(ddl)
  }
}
