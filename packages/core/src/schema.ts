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
  first_seen_at   TEXT NOT NULL,
  last_scraped_at TEXT NOT NULL
);

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
