import type { Db } from '../db.ts'
import type { ProbeStatus } from '../types.ts'

export function recordProbe(db: Db, id: number, status: ProbeStatus): void {
  db.prepare(`
    INSERT INTO probes (id_processo_trf, status, attempts, last_probed_at)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(id_processo_trf) DO UPDATE SET
      status = excluded.status,
      attempts = probes.attempts + 1,
      last_probed_at = datetime('now')
  `).run(id, status)
}

export function getProbedIds(db: Db): Set<number> {
  const rows = db.prepare('SELECT id_processo_trf AS id FROM probes').all() as { id: number }[]
  return new Set(rows.map((r) => r.id))
}
