import type { Db } from '../db.ts'
import type { PartyInput, StoredParty } from '../types.ts'

interface Row {
  id_processo_trf: number
  polo: string
  name: string
  document_type: string | null
  document_number: string | null
  oab: string | null
  role: string | null
  situation: string | null
}

const toStored = (r: Row): StoredParty => ({
  idProcessoTrf: r.id_processo_trf,
  polo: r.polo as StoredParty['polo'],
  name: r.name,
  documentType: r.document_type as StoredParty['documentType'],
  documentNumber: r.document_number,
  oab: r.oab,
  role: r.role,
  situation: r.situation,
})

/**
 * Replaces every party row stored for a case with `parties`, inside one
 * transaction. A case's parties have no natural per-row key — the same name
 * can legitimately appear twice (e.g. the same lawyer relisted) — so
 * "re-running a case replaces its parties rather than duplicating them" is
 * implemented as delete-then-insert instead of an `ON CONFLICT` upsert. The
 * transaction means a re-run either fully replaces the list or, if
 * interrupted, leaves the previous list intact — never a partial mix of old
 * and new rows.
 */
export function replacePartiesForCase(db: Db, idProcessoTrf: number, parties: readonly PartyInput[]): void {
  const run = db.transaction((rows: readonly PartyInput[]) => {
    db.prepare('DELETE FROM parties WHERE id_processo_trf = ?').run(idProcessoTrf)
    const insert = db.prepare(`
      INSERT INTO parties (
        id_processo_trf, polo, name, document_type, document_number, oab, role, situation
      ) VALUES (
        @idProcessoTrf, @polo, @name, @documentType, @documentNumber, @oab, @role, @situation
      )
    `)
    for (const p of rows) {
      insert.run({
        idProcessoTrf,
        polo: p.polo,
        name: p.name,
        documentType: p.documentType,
        documentNumber: p.documentNumber,
        oab: p.oab,
        role: p.role,
        situation: p.situation,
      })
    }
  })
  run(parties)
}

export function getPartiesByCase(db: Db, idProcessoTrf: number): StoredParty[] {
  const rows = db.prepare('SELECT * FROM parties WHERE id_processo_trf = ? ORDER BY id')
    .all(idProcessoTrf) as Row[]
  return rows.map(toStored)
}
