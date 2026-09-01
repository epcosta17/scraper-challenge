import type { Db } from '../db.ts'
import type { MovementInput, StoredMovement } from '../types.ts'

interface Row {
  id_processo_trf: number
  position: number
  timestamp: string | null
  description: string
}

const toStored = (r: Row): StoredMovement => ({
  idProcessoTrf: r.id_processo_trf,
  position: r.position,
  timestamp: r.timestamp,
  description: r.description,
})

/**
 * Replaces every movement row stored for a case with `movements`, inside one
 * transaction — same delete-then-insert re-run rule as
 * `replacePartiesForCase`, and for the same reason: a movement's own text is
 * not a stable key (the log can repeat an identical line, e.g. two
 * "Recebidos os autos" entries seconds apart), so `position` — the page's
 * own ordering — is what a re-run trusts, not an upsert key.
 */
export function replaceMovementsForCase(db: Db, idProcessoTrf: number, movements: readonly MovementInput[]): void {
  const run = db.transaction((rows: readonly MovementInput[]) => {
    db.prepare('DELETE FROM movements WHERE id_processo_trf = ?').run(idProcessoTrf)
    const insert = db.prepare(`
      INSERT INTO movements (id_processo_trf, position, timestamp, description)
      VALUES (@idProcessoTrf, @position, @timestamp, @description)
    `)
    for (const m of rows) {
      insert.run({ idProcessoTrf, position: m.position, timestamp: m.timestamp, description: m.description })
    }
  })
  run(movements)
}

export function getMovementsByCase(db: Db, idProcessoTrf: number): StoredMovement[] {
  const rows = db.prepare('SELECT * FROM movements WHERE id_processo_trf = ? ORDER BY position')
    .all(idProcessoTrf) as Row[]
  return rows.map(toStored)
}
