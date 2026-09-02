/**
 * `demo/worker` as a library: the queue drainer, its handlers, and the
 * pieces around them. `cli.ts` is the program; nothing here has a side
 * effect at import time.
 */
export { createWorker, DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS } from './worker.ts'
export type { Worker, WorkerDeps, WorkerOptions, WorkerSummary } from './worker.ts'

export { HANDLERS, REAL_ENGINE } from './handlers.ts'
export type { Engine, HandlerContext, HandlerDeps, JobHandler } from './handlers.ts'

export { parseCrawlPayload, parseDeepCasePayload, parseDeepRangePayload } from './payloads.ts'
export type { CrawlSpec, DeepRangeSpec } from './payloads.ts'

export { PermanentJobError, JobPayloadError, UnknownJobTypeError } from './errors.ts'

export { createProgressPublisher, DEFAULT_PROGRESS_INTERVAL_MS } from './progress.ts'
export type { ProgressPublisher, ProgressPublisherOptions } from './progress.ts'

export { main, createShutdownHandler } from './run.ts'
export type { MainOptions } from './run.ts'
export { parseWorkerArgs, helpText, ArgsError } from './cli/args.ts'
export type { WorkerArgs } from './cli/args.ts'
export { WORKER_VERSION } from './version.ts'
