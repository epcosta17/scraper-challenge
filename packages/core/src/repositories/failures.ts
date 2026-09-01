import type { Db } from '../db.ts'
import type { Failure } from '../types.ts'

export function recordFailure(db: Db, kind: string, ref: string, error: string): void {
  db.prepare(`
    INSERT INTO failures (kind, ref, error, attempts, last_attempt_at)
    VALUES (?, ?, ?, 1, datetime('now'))
    ON CONFLICT(kind, ref) DO UPDATE SET
      error = excluded.error,
      attempts = failures.attempts + 1,
      last_attempt_at = datetime('now'),
      resolved_at = NULL
  `).run(kind, ref, error)
}

export function listFailures(db: Db, opts: { unresolvedOnly?: boolean } = {}): Failure[] {
  const sql = opts.unresolvedOnly
    ? 'SELECT * FROM failures WHERE resolved_at IS NULL ORDER BY id'
    : 'SELECT * FROM failures ORDER BY id'
  const rows = db.prepare(sql).all() as Array<{
    id: number; kind: string; ref: string; error: string
    attempts: number; last_attempt_at: string; resolved_at: string | null
  }>
  return rows.map((r) => ({
    id: r.id, kind: r.kind, ref: r.ref, error: r.error,
    attempts: r.attempts, lastAttemptAt: r.last_attempt_at, resolvedAt: r.resolved_at,
  }))
}

export function resolveFailure(db: Db, kind: string, ref: string): void {
  db.prepare(`UPDATE failures SET resolved_at = datetime('now') WHERE kind = ? AND ref = ?`)
    .run(kind, ref)
}
