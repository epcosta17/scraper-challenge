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
