/**
 * One worker process for the concurrent-claiming test in `jobs.test.ts`.
 * Drains the queue at the given database path as fast as it can and prints
 * the ids it managed to claim, as JSON, on stdout.
 *
 * Deliberately a separate process: the point of the test is the SQLite write
 * lock between connections, which two calls inside one process would never
 * exercise.
 *
 * The ready/go handshake exists so the processes actually overlap. Node
 * takes long enough to boot and load `better-sqlite3` that, left to
 * themselves, the first worker can drain a small queue before the last one
 * has opened the file — which would make the test pass without ever putting
 * two claims in flight at once. Each worker announces itself by creating
 * `readyPath`, then spins until the parent creates `goPath`; only then does
 * it touch the queue.
 *
 * Usage: claim-worker.ts <db-path> <ready-path> <go-path>
 */
import { existsSync, writeFileSync } from 'node:fs'
import { openDatabase, claimNextJob, completeJob } from '../../src/index.ts'

const [dbPath, readyPath, goPath] = process.argv.slice(2)
if (!dbPath || !readyPath || !goPath) {
  throw new Error('usage: claim-worker.ts <db-path> <ready-path> <go-path>')
}

const db = openDatabase(dbPath)

writeFileSync(readyPath, '')
// Synchronous spin — this process has nothing else to do, and a busy wait
// keeps the start of the race as tight as the filesystem allows.
const sleeper = new Int32Array(new SharedArrayBuffer(4))
while (!existsSync(goPath)) Atomics.wait(sleeper, 0, 0, 1)

const claimed: number[] = []
try {
  for (;;) {
    const job = claimNextJob(db)
    if (!job) break
    claimed.push(job.id)
    completeJob(db, job.id)
    // A beat between claims, standing in for the work a real worker would
    // be doing. Without it SQLite's write lock is not handed round fairly:
    // one process reacquires it every time and drains the whole queue before
    // the others get a turn, and a test where only one worker ever claimed
    // anything proves nothing about concurrency.
    Atomics.wait(sleeper, 0, 0, 1)
  }
} finally {
  db.close()
}

process.stdout.write(JSON.stringify(claimed))
