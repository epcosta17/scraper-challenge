import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA, migrateSchema } from './schema.ts'

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
  // Adds columns a pre-existing database (created before this migration
  // existed) is missing — see `migrateSchema`'s own doc comment for why
  // `CREATE TABLE IF NOT EXISTS` above can't cover this by itself.
  migrateSchema(db)
  return db
}
