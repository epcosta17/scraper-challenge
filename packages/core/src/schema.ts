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
  last_scraped_at TEXT NOT NULL
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
  error        TEXT
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

const CASE_COLUMN_MIGRATIONS: ReadonlyArray<{ column: string; ddl: string }> = [
  { column: 'jurisdiction', ddl: 'ALTER TABLE cases ADD COLUMN jurisdiction TEXT' },
  { column: 'court_address', ddl: 'ALTER TABLE cases ADD COLUMN court_address TEXT' },
  { column: 'reference_number', ddl: 'ALTER TABLE cases ADD COLUMN reference_number TEXT' },
]

export function migrateSchema(db: Db): void {
  for (const { column, ddl } of CASE_COLUMN_MIGRATIONS) {
    if (!hasColumn(db, 'cases', column)) db.exec(ddl)
  }
}
