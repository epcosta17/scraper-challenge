import {
  HttpClient, search, startSession, validateFilters,
  SearchValidationError, ActionNotExecutedError, RateLimitedError,
  type SearchFilters,
} from '@pje/scraper'

/**
 * The search screen's other half: the portal's own form, queried live.
 *
 * This is the one place in the demo that talks to the TRF5 while a person
 * waits. Everything else reads the acervo, and that is the division worth
 * keeping in mind — the main screen answers "what have we captured?", this
 * answers "what does the court have?", and they are different questions with
 * different answers.
 *
 * What comes back is thin on purpose, because that is all the portal's AJAX
 * response carries: a case number, its internal id and the `ca` token. No
 * class, no parties, no dates. So a result is an *address*, and what the page
 * does with it is either open the case we already hold or offer to capture it.
 */

/** A row as the portal returned it, plus what we know about it locally. */
export interface PortalHit {
  idProcessoTrf: number
  number: string
  /**
   * What the portal's own result row shows, carried through rather than
   * discarded. It costs no extra request, and it is the difference between a
   * search result that is a list of numbers and one a person can read.
   */
  className?: string
  subject?: string
  parties?: string
  lastMovement?: { description: string; timestamp?: string }
}

export type PortalSearchOutcome =
  | {
      ok: true
      hits: PortalHit[]
      /**
       * The portal said it cut the result set off. Not a paging hint: there
       * is no next page to ask for — the limit lives in the server's own
       * query, so the only way past it is a narrower search.
       */
      capped: boolean
      /** How long the round trip took, for a screen that just made somebody wait. */
      elapsedMs: number
    }
  | { ok: false; kind: PortalFailure; error: string }

/**
 * Why a search did not happen, kept apart from *what* went wrong, because the
 * page says something different for each. A rejected filter is the user's to
 * fix; an unreachable portal is nobody's; a stale action is ours.
 */
export type PortalFailure = 'invalid' | 'unreachable' | 'rate_limited' | 'portal'

/**
 * The portal's own rules, said in the interface's language and about the
 * fields on screen.
 *
 * `validateFilters` phrases its refusals for the CLI, in English and naming
 * flags (`--party`) that do not exist here. The rule is the portal's and is
 * worth enforcing exactly as it does; only the wording is the CLI's, so only
 * the wording is replaced. Anything unrecognised falls through unchanged
 * rather than being flattened into a generic sentence — a rule this does not
 * know about is still better read in English than not read at all.
 */
const RULE_SAID: ReadonlyArray<readonly [RegExp, string]> = [
  [/--party requires at least two names/,
   'El nombre de la parte necesita al menos dos palabras: con una sola, el servidor del portal rechaza la consulta.'],
  [/--lawyer requires at least two names/,
   'El nombre del abogado necesita al menos dos palabras: con una sola, el servidor del portal rechaza la consulta.'],
  [/--oab-state has no effect without --oab/,
   'El estado de la OAB no filtra nada por sí solo: el portal lo ignora en silencio, así que aquí se exige también el número.'],
  [/--from must be dd\/mm\/yyyy, got "([^"]*)"/,
   'La fecha inicial va en formato dd/mm/aaaa — por ejemplo 17/08/2026.'],
  [/--to must be dd\/mm\/yyyy, got "([^"]*)"/,
   'La fecha final va en formato dd/mm/aaaa — por ejemplo 17/08/2026.'],
]

const inSpanish = (message: string): string => {
  for (const [pattern, said] of RULE_SAID) {
    if (pattern.test(message)) return said
  }
  return message
}

export interface PortalSearch {
  run(filters: SearchFilters): Promise<PortalSearchOutcome>
}

/**
 * Requests per second against the portal from the web. Deliberately gentler
 * than the CLI's default: a search is one form submission a person is waiting
 * on, not a crawl, so there is nothing to gain from going faster and a shared
 * demo should not be the reason the court starts answering 429.
 */
const WEB_RPS = 1

export function createPortalSearch(): PortalSearch {
  return {
    async run(filters) {
      // Validated before a session is even started, so a filter the server
      // would silently ignore never costs a request. `search()` re-validates
      // internally; this is only about failing early and saying why.
      try {
        validateFilters(filters)
      } catch (err) {
        if (err instanceof SearchValidationError) {
          return { ok: false, kind: 'invalid', error: inSpanish(err.message) }
        }
        throw err
      }

      // A fresh client per search, which also means a fresh cookie jar. That
      // is not incidental: fetching a report PDF poisons the jar for the next
      // `startSession`, and a long-lived shared client here would eventually
      // hand this screen a session whose actionUrl has lost its jsessionid.
      const client = new HttpClient({ rps: WEB_RPS })
      const startedAt = Date.now()

      try {
        const session = await startSession(client)
        const outcome = await search(client, session, filters)
        return {
          ok: true,
          hits: outcome.rows.map((r) => ({
            idProcessoTrf: r.idProcessoTrf,
            number: r.number,
            className: r.className,
            subject: r.subject,
            parties: r.parties,
            lastMovement: r.lastMovement,
          })),
          capped: outcome.capped,
          elapsedMs: Date.now() - startedAt,
        }
      } catch (err) {
        return { ok: false, ...classify(err) }
      }
    },
  }
}

/**
 * Names the failure, because "something went wrong" is the one answer this
 * screen must never give. A search that returns nothing and a search that
 * never ran look identical on a results page unless the page is told which
 * happened — and quietly rendering "0 results" for a portal that is down is
 * the same silent lie the scraper is built to refuse everywhere else.
 */
function classify(err: unknown): { kind: PortalFailure; error: string } {
  if (err instanceof SearchValidationError) {
    return { kind: 'invalid', error: inSpanish(err.message) }
  }
  if (err instanceof RateLimitedError) {
    return {
      kind: 'rate_limited',
      error: 'El portal está limitando las peticiones (HTTP 429). Espera un momento y repite la consulta.',
    }
  }
  if (err instanceof ActionNotExecutedError) {
    // The form re-rendered without running the action. Zero rows would be the
    // wrong reading of that: the search did not happen at all.
    return {
      kind: 'portal',
      error: 'El portal recibió el formulario pero no ejecutó la búsqueda. ' +
        'Suele significar que su parámetro de envío cambió; el scraper lo relee en cada sesión, así que reintentar suele bastar.',
    }
  }

  const message = err instanceof Error ? err.message : String(err)
  // Node's fetch reports every transport failure — DNS, refused, timed out,
  // a VPN that is down — as this one flat string.
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|UND_ERR|network/i.test(message)) {
    return {
      kind: 'unreachable',
      error: 'No se pudo alcanzar el portal del TRF5. Comprueba la conexión (o la VPN) y repite la consulta.',
    }
  }
  return { kind: 'portal', error: message }
}
