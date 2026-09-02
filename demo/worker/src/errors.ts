/**
 * A failure that a retry cannot fix.
 *
 * The queue's default answer to a failed job is another go, which is right
 * for the failures this scraper actually sees — a 429 that outlasted its
 * backoff, a detail page that came back stale, a portal node having a
 * moment. It is exactly wrong for a job that is *malformed*: a payload with
 * a misspelled key, or a type no build of this worker has a handler for,
 * will fail identically on every attempt, and retrying it only delays the
 * queue behind it (a returned job is `pending` with the lowest id, so it is
 * the very next thing claimed) while telling whoever is watching a story
 * about transient trouble that is not true.
 *
 * Anything thrown out of a handler that is one of these goes straight to
 * `failed`, with its attempts unspent.
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentJobError'
  }
}

/**
 * A queued job asked for something this worker cannot make sense of. Thrown
 * before any request goes out, so a malformed payload costs the portal
 * nothing and the job's `error` column says exactly what was wrong with it.
 */
export class JobPayloadError extends PermanentJobError {
  constructor(message: string) {
    super(message)
    this.name = 'JobPayloadError'
  }
}

/** No handler is registered for the job's `type`. See `PermanentJobError`. */
export class UnknownJobTypeError extends PermanentJobError {
  constructor(type: string, known: readonly string[]) {
    super(`No handler for job type "${type}". This worker knows: ${known.join(', ')}.`)
    this.name = 'UnknownJobTypeError'
  }
}
