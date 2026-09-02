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
/**
 * Where a set of movements came from. Ranked, because they are not equal.
 *
 * `table` is the case file's own "Movimentações do Processo", read page by
 * page. `pdf` is the summary PDF's log, which `crawl` has and the case file's
 * table it does not.
 *
 * Measured on 0000292-82.2007.4.05.8400, whose page declares 4,182: the table
 * gives exactly that, the PDF gives 4,200. The eighteen extra are not
 * movements — a hearing reads "Audiência Instrução Realizada para 26/05/2008
 * 17:11:00 Sala de Audiências.", with a timestamp inside the text, and the
 * PDF parser delimits by timestamps, so it cuts there and invents a second
 * movement saying only "Sala de Audiências.". Its text is dirtier too:
 * "Não- acolhidos", carrying the hyphen and space of a line wrap.
 */
export type MovementSource = 'pdf' | 'table'

const RANK: Record<MovementSource, number> = { pdf: 1, table: 2 }

/**
 * Replaces a case's movements, unless what is already stored came from a
 * better source.
 *
 * The guard lives here rather than in the callers because it is an invariant
 * about the data, not about who happens to be writing. `crawl` has only the
 * PDF and passes over ids it has already deep-scraped; left to overwrite, it
 * degrades a case from 21 movements to 19 with nothing recorded — silently,
 * because `crawl` never fetches the page it would need to notice. A `daily`
 * run would do that every night.
 *
 * A same-or-better source always writes, so a second crawl still refreshes a
 * case that only ever had the PDF's version.
 */
export function replaceMovementsForCase(
  db: Db,
  idProcessoTrf: number,
  movements: readonly MovementInput[],
  source: MovementSource = 'table',
): void {
  const stored = (db.prepare('SELECT movements_source AS s FROM cases WHERE id_processo_trf = ?')
    .get(idProcessoTrf) as { s: string | null } | undefined)?.s
  if (stored === 'pdf' || stored === 'table') {
    if (RANK[source] < RANK[stored]) return
  }

  const run = db.transaction((rows: readonly MovementInput[]) => {
    db.prepare('DELETE FROM movements WHERE id_processo_trf = ?').run(idProcessoTrf)
    const insert = db.prepare(`
      INSERT INTO movements (id_processo_trf, position, timestamp, description)
      VALUES (@idProcessoTrf, @position, @timestamp, @description)
    `)
    for (const m of rows) {
      insert.run({ idProcessoTrf, position: m.position, timestamp: m.timestamp, description: m.description })
    }
    db.prepare('UPDATE cases SET movements_source = ? WHERE id_processo_trf = ?')
      .run(source, idProcessoTrf)
  })
  run(movements)
}

export function getMovementsByCase(db: Db, idProcessoTrf: number): StoredMovement[] {
  const rows = db.prepare('SELECT * FROM movements WHERE id_processo_trf = ? ORDER BY position')
    .all(idProcessoTrf) as Row[]
  return rows.map(toStored)
}
