import { openDatabase, enqueueJob, getAcervoTotals } from '../packages/core/src/index.ts'

/**
 * Queues the container's first capture, once.
 *
 * A queued job rather than a scrape run here and now, for one reason: the
 * queue screen is part of what there is to see. A reviewer who opens the page
 * thirty seconds after `docker run` finds a job in flight, with its stage, its
 * progress and its failures — which says more about the system than the same
 * cases appearing silently in a table.
 *
 * Skipped when the acervo already holds cases, so restarting a container with
 * its volume does not queue the same range on top of what it captured last
 * time.
 *
 *   node docker/seed.ts <db> <from-to>
 */
const [dbPath, range] = process.argv.slice(2)

if (dbPath === undefined || range === undefined) {
  console.error('uso: seed.ts <ruta-db> <desde-hasta>')
  process.exit(2)
}

const parsed = /^(\d+)\s*[-–]\s*(\d+)$/.exec(range.trim())
if (parsed === null) {
  console.error(`seed: "${range}" no es un rango de ids (130100-130140)`)
  process.exit(2)
}

const fromId = Number(parsed[1])
const toId = Number(parsed[2])
if (fromId > toId) {
  console.error(`seed: el rango va al revés (${fromId} > ${toId})`)
  process.exit(2)
}

const db = openDatabase(dbPath)
const held = getAcervoTotals(db).caseCount

if (held > 0) {
  console.log(`seed: el acervo ya tiene ${held} expedientes; no se encola nada`)
  process.exit(0)
}

const job = enqueueJob(db, 'deep_range', { fromId, toId })
console.log(`seed: encolado el trabajo #${job.id} — captura profunda de ids ${fromId}–${toId}`)
