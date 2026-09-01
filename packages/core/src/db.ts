import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA } from './schema.ts'

export type Db = Database.Database

/**
 * `data/` is gitignored on purpose — it's an output location, not source —
 * so a fresh clone has no directory for the default `data/pje.db` to live
 * in, and `better-sqlite3` refuses to create one itself. Create it (and any
 * other missing parent) up front so opening the database never depends on
 * the caller (or a README) having mkdir'd it by hand first. Recursive mkdir
 * is idempotent, so this costs nothing on every subsequent run.
 *
 * Skipped for `:memory:`, which has no parent directory at all.
 */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}
