import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Starts the worker from the web, because the alternative is a screen that
 * takes your job and then sits there.
 *
 * This is the "manual" in manual-only: there is no scheduler and nothing runs
 * on its own — a worker exists because somebody queued work on the page and
 * this started one to do it. What it explicitly is *not* is the web doing the
 * scraping. The child is the same `demo/worker` you can run by hand, claiming
 * through the same atomic statement; the request that spawned it does not wait
 * for it, and killing the server does not undo the work, because the worker
 * writes to SQLite as it goes.
 *
 * At most one child at a time, which is a convenience and not a lock. The
 * queue is safe against any number of workers by construction, so this is only
 * about not stacking up processes on a demo machine every time somebody
 * enqueues three things in a row: the running worker will claim them anyway.
 * A worker started in a terminal is invisible to this and that is fine — it
 * simply means the two of them share the queue.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
/** `demo/web/src/data` -> the repository root. */
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..')
const WORKER_ENTRY = resolve(REPO_ROOT, 'demo/worker/src/cli.ts')

export interface RunnerConfig {
  databasePath: string
  blobRoot: string
}

export type RunnerState =
  | { running: false; startedAt: null; lastExit: WorkerExit | null }
  | { running: true; startedAt: string; lastExit: WorkerExit | null }

export interface WorkerExit {
  at: string
  code: number | null
  signal: NodeJS.Signals | null
  /** The tail of what it said, so a failure to even start is visible on the page. */
  output: string
}

export interface Runner {
  /** Starts a worker unless one is already up. Reports which of the two happened. */
  ensureRunning(): { started: boolean; reason: string }
  state(): RunnerState
  /** Stops the worker this process started. A first stop is polite (SIGINT). */
  stop(): boolean
}

/** How much of the worker's output is kept for the page to show. */
const OUTPUT_TAIL = 4000

export function createRunner(config: RunnerConfig): Runner {
  let child: ReturnType<typeof spawn> | null = null
  let startedAt: string | null = null
  let lastExit: WorkerExit | null = null
  let output = ''

  const remember = (chunk: string): void => {
    output = (output + chunk).slice(-OUTPUT_TAIL)
  }

  return {
    ensureRunning() {
      if (child !== null) {
        return { started: false, reason: 'Ya hay un worker corriendo; tomará este trabajo también.' }
      }

      // The same runtime flag the `worker` npm script uses. Spawned with the
      // repository as cwd so the worker resolves its own imports the way it
      // does from a terminal.
      const spawned = spawn(
        process.execPath,
        ['--experimental-strip-types', '--no-warnings', WORKER_ENTRY,
         '--db', config.databasePath, '--out', config.blobRoot],
        { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
      )

      child = spawned
      startedAt = new Date().toISOString()
      output = ''

      spawned.stdout?.on('data', (b: Buffer) => remember(b.toString()))
      spawned.stderr?.on('data', (b: Buffer) => remember(b.toString()))

      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        lastExit = { at: new Date().toISOString(), code, signal, output: output.trim() }
        child = null
        startedAt = null
      }
      spawned.on('exit', finish)
      // `error` fires instead of `exit` when the process could never start at
      // all. Recording it the same way is what keeps a broken path visible on
      // the page rather than leaving a worker that is forever "starting".
      spawned.on('error', (err: Error) => {
        remember(`\n${err.message}`)
        finish(null, null)
      })

      return { started: true, reason: 'Worker arrancado; ya está tomando la cola.' }
    },

    state() {
      return child !== null && startedAt !== null
        ? { running: true, startedAt, lastExit }
        : { running: false, startedAt: null, lastExit }
    },

    stop() {
      if (child === null) return false
      // SIGINT, not SIGTERM: the worker handles it, finishing or handing back
      // the job it holds instead of abandoning it half-written.
      child.kill('SIGINT')
      return true
    },
  }
}
