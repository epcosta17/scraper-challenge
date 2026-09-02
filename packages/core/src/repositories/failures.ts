import type { Db } from '../db.ts'
import type { Failure } from '../types.ts'

/**
 * Records that something went wrong, or that it went wrong again.
 *
 * `idProcessoTrf` is what makes a failure actionable rather than merely
 * readable. `ref` names the thing that failed — for a document, its own id,
 * which for an unrecognised link is a synthetic hash and names nothing anybody
 * can retry. The case is known at the moment of recording; keeping it is the
 * difference between a list of complaints and a list of jobs to re-run.
 */
export function recordFailure(
  db: Db,
  kind: string,
  ref: string,
  error: string,
  idProcessoTrf?: number,
): void {
  db.prepare(`
    INSERT INTO failures (kind, ref, error, attempts, last_attempt_at, id_processo_trf)
    VALUES (?, ?, ?, 1, datetime('now'), ?)
    ON CONFLICT(kind, ref) DO UPDATE SET
      error = excluded.error,
      attempts = failures.attempts + 1,
      last_attempt_at = datetime('now'),
      resolved_at = NULL,
      -- Kept when the new write does not know it: a retry that fails for a
      -- reason with no case attached should not erase the case the first
      -- attempt did know.
      id_processo_trf = COALESCE(excluded.id_processo_trf, failures.id_processo_trf)
  `).run(kind, ref, error, idProcessoTrf ?? null)
}

export function listFailures(db: Db, opts: { unresolvedOnly?: boolean } = {}): Failure[] {
  const sql = opts.unresolvedOnly
    ? 'SELECT * FROM failures WHERE resolved_at IS NULL ORDER BY id'
    : 'SELECT * FROM failures ORDER BY id'
  const rows = db.prepare(sql).all() as Array<{
    id: number; kind: string; ref: string; error: string
    attempts: number; last_attempt_at: string; resolved_at: string | null
    id_processo_trf: number | null
  }>
  return rows.map((r) => ({
    id: r.id, kind: r.kind, ref: r.ref, error: r.error,
    attempts: r.attempts, lastAttemptAt: r.last_attempt_at, resolvedAt: r.resolved_at,
    idProcessoTrf: r.id_processo_trf,
  }))
}

export function resolveFailure(db: Db, kind: string, ref: string): void {
  db.prepare(`UPDATE failures SET resolved_at = datetime('now') WHERE kind = ? AND ref = ?`)
    .run(kind, ref)
}
