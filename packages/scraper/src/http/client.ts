import { CookieJar } from './cookie-jar.ts'
import { backoffDelay, retryAfterMs, DEFAULT_BACKOFF, type BackoffOptions } from './backoff.ts'

export interface HttpResponse {
  status: number
  /** Final URL after redirects — used to detect error.seam landings. */
  url: string
  headers: Headers
  body: Buffer
}

export interface HttpClientOptions {
  /** Requests per second; 0 disables pacing (used in tests). */
  rps?: number
  backoff?: Partial<BackoffOptions>
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  userAgent?: string
  jar?: CookieJar
}

export class RateLimitedError extends Error {
  readonly attempts: number

  constructor(url: string, attempts: number) {
    super(`Rate limited by the server after ${attempts} attempts: ${url}`)
    this.name = 'RateLimitedError'
    this.attempts = attempts
  }
}

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0 Safari/537.36'

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function decodeLatin1(b: Buffer): string {
  return new TextDecoder('iso-8859-1').decode(b)
}

export function decodeUtf8(b: Buffer): string {
  return new TextDecoder('utf-8').decode(b)
}

/**
 * The single network chokepoint. Everything that touches the PJe portal goes
 * through here so rate limiting, retries and 429 handling exist in one place.
 */
export class HttpClient {
  readonly jar: CookieJar
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly minIntervalMs: number
  private readonly backoff: Partial<BackoffOptions>
  private readonly userAgent: string
  private nextSlot = 0
  private attemptCount = 0

  constructor(o: HttpClientOptions = {}) {
    this.jar = o.jar ?? new CookieJar()
    this.fetchImpl = o.fetchImpl ?? fetch
    this.sleep = o.sleep ?? defaultSleep
    this.minIntervalMs = o.rps && o.rps > 0 ? 1000 / o.rps : 0
    this.backoff = o.backoff ?? {}
    this.userAgent = o.userAgent ?? DEFAULT_UA
  }

  get attempts(): number {
    return this.attemptCount
  }

  private async pace(): Promise<void> {
    if (this.minIntervalMs === 0) return
    const now = Date.now()
    const wait = Math.max(0, this.nextSlot - now)
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs
    if (wait > 0) await this.sleep(wait)
  }

  async request(url: string, init: RequestInit = {}): Promise<HttpResponse> {
    const maxAttempts = this.backoff.maxAttempts ?? DEFAULT_BACKOFF.maxAttempts

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.pace()
      this.attemptCount++

      const cookie = this.jar.header()
      const headers = new Headers(init.headers)
      headers.set('User-Agent', this.userAgent)
      if (cookie) headers.set('Cookie', cookie)

      let res: Response
      try {
        res = await this.fetchImpl(url, { ...init, headers, redirect: 'follow' })
      } catch (err) {
        // Transport failure: retry on the same ladder as a 5xx.
        if (attempt === maxAttempts - 1) throw err
        await this.sleep(backoffDelay(attempt, this.backoff))
        continue
      }

      this.jar.setFromHeaders(res.headers)

      if (res.status === 429) {
        if (attempt === maxAttempts - 1) throw new RateLimitedError(url, maxAttempts)
        const hinted = retryAfterMs(res.headers.get('retry-after'))
        await this.sleep(hinted ?? backoffDelay(attempt, this.backoff))
        continue
      }

      if (res.status >= 500 && attempt < maxAttempts - 1) {
        await this.sleep(backoffDelay(attempt, this.backoff))
        continue
      }

      return {
        status: res.status,
        url: res.url,
        headers: res.headers,
        body: Buffer.from(await res.arrayBuffer()),
      }
    }

    throw new RateLimitedError(url, maxAttempts)
  }
}
