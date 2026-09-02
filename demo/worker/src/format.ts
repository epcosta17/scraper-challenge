import type { Job } from '@pje/core'
import type { WorkerSummary } from './worker.ts'

const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`

/** `{"fromId":1,"toId":300}`, or nothing at all for a job that carries no payload. */
function payloadOf(job: Job): string {
  const json = JSON.stringify(job.payload)
  return json === '{}' ? '' : `  ${json}`
}

export function workerHeader(o: {
  db: string
  out: string
  types?: readonly string[]
  watch: boolean
  rps: number
}): string {
  const types = o.types && o.types.length > 0 ? o.types.join(', ') : 'every type'
  const mode = o.watch ? 'draining and then watching for more' : 'draining until the queue is empty'
  return `Worker ${mode} (${types}) at ${o.rps} req/s -> db ${o.db}, files ${o.out}`
}

export function reclaimedLine(n: number): string {
  return `↺ ${plural(n, 'job')} left running by a worker that died — returned to the queue`
}

export function jobStartLine(job: Job): string {
  const attempt = job.attempts > 1 ? `  (attempt ${job.attempts})` : ''
  return `▶ job ${job.id}  ${job.type}${payloadOf(job)}${attempt}`
}

export function jobDoneLine(job: Job, summary: string, ms: number): string {
  return `✓ job ${job.id}  ${job.type}: ${summary}  (${(ms / 1000).toFixed(1)}s)`
}

/**
 * Says which of the two things a failure was — another go, or the end of the
 * road — because the difference is the whole reason anyone watches this
 * line, and it is not recoverable from the message itself.
 */
export function jobFailedLine(job: Job, outcome: 'retry' | 'failed', error: string): string {
  const fate = outcome === 'retry'
    ? `back in the queue (attempt ${job.attempts} did not take)`
    : `gave up after ${plural(job.attempts, 'attempt')}`
  return `✗ job ${job.id}  ${job.type}: ${error} — ${fate}`
}

/** A job whose lease was reclaimed mid-flight; whatever it did is now somebody else's to redo. */
export function jobLostLine(job: Job): string {
  return `✗ job ${job.id}  ${job.type}: this worker lost its lease while working and another may ` +
    'have taken the job over — its result is being dropped rather than written over theirs'
}

export function jobAbandonedLine(job: Job, released: boolean): string {
  return released
    ? `↺ job ${job.id}  ${job.type} handed back to the queue, unstarted`
    : `↺ job ${job.id}  ${job.type} had already finished; nothing to hand back`
}

export function workerSummaryLines(s: WorkerSummary): string {
  const how =
    s.stopped === 'drained' ? 'queue empty'
    : s.stopped === 'max_jobs' ? 'reached --max-jobs'
    : 'interrupted'
  const parts = [
    `${plural(s.claimed, 'job')} claimed`,
    `${s.done} done`,
    `${s.retried} back in the queue`,
    `${s.failed} failed`,
  ]
  if (s.abandoned > 0) parts.push(`${s.abandoned} handed back`)
  if (s.lost > 0) parts.push(`${s.lost} lost to another worker`)
  if (s.reclaimed > 0) parts.push(`${s.reclaimed} reclaimed at start`)
  return `\n${parts.join(', ')} — ${how}`
}
