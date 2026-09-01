import { describe, it, expect } from 'vitest'
import { HttpClient, RateLimitedError, decodeLatin1 } from '../src/http/client.ts'
import { CookieJar } from '../src/http/cookie-jar.ts'
import { DEFAULT_BACKOFF } from '../src/http/backoff.ts'

/** Builds a fetch stub that replays the given responses in order. */
function stubFetch(responses: Array<{ status: number; body?: string; headers?: Record<string, string> }>) {
  let i = 0
  const calls: string[] = []
  const impl = async (url: string | URL | Request) => {
    calls.push(String(url))
    const r = responses[Math.min(i++, responses.length - 1)]!
    return new Response(r.body ?? '', { status: r.status, headers: r.headers })
  }
  return { impl: impl as unknown as typeof fetch, calls, get count() { return i } }
}

const noSleep = async () => {}

describe('HttpClient', () => {
  it('returns the body as a Buffer on success', async () => {
    const f = stubFetch([{ status: 200, body: 'hello' }])
    const client = new HttpClient({ fetchImpl: f.impl, sleep: noSleep, rps: 0 })
    const res = await client.request('https://example.test/x')
    expect(res.status).toBe(200)
    expect(res.body.toString('utf8')).toBe('hello')
  })

  it('retries on 429 and succeeds when the server relents', async () => {
    const f = stubFetch([
      { status: 429 },
      { status: 429 },
      { status: 200, body: 'ok' },
    ])
    const client = new HttpClient({ fetchImpl: f.impl, sleep: noSleep, rps: 0 })
    const res = await client.request('https://example.test/x')
    expect(res.status).toBe(200)
    expect(f.count).toBe(3)
  })

  it('throws RateLimitedError after exhausting attempts', async () => {
    const f = stubFetch([{ status: 429 }])
    const client = new HttpClient({
      fetchImpl: f.impl, sleep: noSleep, rps: 0,
      backoff: { maxAttempts: 3 },
    })
    await expect(client.request('https://example.test/x')).rejects.toBeInstanceOf(RateLimitedError)
    expect(f.count).toBe(3)
  })

  it('waits for Retry-After when the server supplies it', async () => {
    const waits: number[] = []
    const f = stubFetch([
      { status: 429, headers: { 'retry-after': '7' } },
      { status: 200, body: 'ok' },
    ])
    const client = new HttpClient({
      fetchImpl: f.impl, rps: 0,
      sleep: async (ms) => { waits.push(ms) },
    })
    await client.request('https://example.test/x')
    expect(waits[0]).toBe(7000)
  })

  it('retries on 5xx but not on 404', async () => {
    const server = stubFetch([{ status: 503 }, { status: 200, body: 'ok' }])
    const c1 = new HttpClient({ fetchImpl: server.impl, sleep: noSleep, rps: 0 })
    expect((await c1.request('https://example.test/a')).status).toBe(200)

    const missing = stubFetch([{ status: 404, body: 'nope' }])
    const c2 = new HttpClient({ fetchImpl: missing.impl, sleep: noSleep, rps: 0 })
    expect((await c2.request('https://example.test/b')).status).toBe(404)
    expect(missing.count).toBe(1)
  })

  it('paces concurrent requests at the configured rate', async () => {
    const waits: number[] = []
    const f = stubFetch([{ status: 200, body: 'ok' }])
    const client = new HttpClient({
      fetchImpl: f.impl,
      rps: 10,                                  // 100 ms interval
      sleep: async (ms) => { waits.push(ms) },
    })
    await Promise.all([1, 2, 3, 4].map(() => client.request('https://example.test/x')))
    // First concurrent caller goes immediately (wait=0, doesn't sleep).
    // Subsequent callers queue with successive intervals: 100ms, 200ms, 300ms.
    expect(waits).toHaveLength(3)
    for (let i = 0; i < waits.length; i++) {
      expect(waits[i]).toBeGreaterThan(waits[i - 1] ?? -1)
    }
    expect(waits[0]).toBeGreaterThanOrEqual(90)     // ~100 ms, with clock tolerance
    expect(waits[0]).toBeLessThanOrEqual(110)
    expect(waits[2]).toBeGreaterThanOrEqual(290)    // ~300 ms, with clock tolerance
    expect(waits[2]).toBeLessThanOrEqual(310)
  })

  it('pushes the shared next slot forward on a 429 so a later worker cools off too', async () => {
    // Otherwise the other `concurrency-1` workers keep firing at full `rps`
    // while one worker sleeps off a 429 — the aggregate rate never drops.
    const waits: number[] = []
    const responses = [{ status: 429 }, { status: 200, body: 'ok' }, { status: 200, body: 'ok' }]
    let i = 0
    const impl = (async () => {
      const r = responses[Math.min(i++, responses.length - 1)]!
      return new Response(r.body ?? '', { status: r.status })
    }) as unknown as typeof fetch
    const client = new HttpClient({
      fetchImpl: impl,
      rps: 10, // 100 ms interval — dwarfed by the 5s backoff below if the fix works
      sleep: async (ms) => { waits.push(ms) },
      backoff: { baseMs: 5000, factor: 2, jitter: 0, capMs: 60_000, maxAttempts: 5 },
    })

    await client.request('https://example.test/a') // hits the 429, backs off, then succeeds
    waits.length = 0 // isolate the next, independent worker's own pacing wait
    await client.request('https://example.test/b')

    // Without the fix this would be ~100ms (just the rps interval). With the
    // fix, the shared slot was pushed out by the 429's backoff, so a later
    // worker sharing the same client also cools off.
    expect(waits[0]).toBeGreaterThan(4000)
  })

  it('caps an honoured Retry-After hint at the configured backoff cap', async () => {
    const waits: number[] = []
    const f = stubFetch([
      { status: 429, headers: { 'retry-after': '86400' } }, // 24 hours
      { status: 200, body: 'ok' },
    ])
    const client = new HttpClient({
      fetchImpl: f.impl, rps: 0,
      sleep: async (ms) => { waits.push(ms) },
    })
    await client.request('https://example.test/x')
    expect(waits[0]).toBeLessThanOrEqual(DEFAULT_BACKOFF.capMs)
  })
})

describe('withJar', () => {
  // Motivated by a real bug found live: `deep`'s search bridge (session
  // GET + search POST) and its per-document downloads shared one
  // `HttpClient`, and so one cookie jar, across an entire range. A
  // concurrent, unrelated request for a DIFFERENT case landing in between
  // could overwrite the jar's session cookie underneath a case's own
  // multi-request sequence, breaking it with no indication anything about
  // that case itself was wrong. `withJar` gives one logical sequence
  // (one case's whole `deep` chain) an isolated jar without losing the
  // pacing/backoff coordination that keeps the aggregate rate across every
  // worker — see `deep.ts`'s per-case `caseClient`.
  it('shares pacing state with the parent client, not a fresh clock', async () => {
    const waits: number[] = []
    const f = stubFetch([{ status: 200, body: 'a' }, { status: 200, body: 'b' }])
    const parent = new HttpClient({ fetchImpl: f.impl, rps: 10, sleep: async (ms) => { waits.push(ms) } })
    const child = parent.withJar(new CookieJar())

    await parent.request('https://example.test/a')
    await child.request('https://example.test/b')

    // If the child had its own independent pacing clock (e.g. from
    // constructing a brand-new HttpClient), this second request would fire
    // immediately (wait 0, no sleep call at all) instead of queuing behind
    // the parent's first request at the shared ~100ms interval.
    expect(waits).toHaveLength(1)
    expect(waits[0]).toBeGreaterThanOrEqual(90)
    expect(waits[0]).toBeLessThanOrEqual(110)
  })

  it('gives the derived client its own cookie jar, independent of the parent', async () => {
    const f = stubFetch([{ status: 200, body: 'ok', headers: { 'set-cookie': 'JSESSIONID=parent-session' } }])
    const parent = new HttpClient({ fetchImpl: f.impl, sleep: noSleep, rps: 0 })
    await parent.request('https://example.test/a')
    expect(parent.jar.header()).toContain('JSESSIONID=parent-session')

    const child = parent.withJar(new CookieJar())
    expect(child.jar.header()).toBe('')
    expect(child.jar).not.toBe(parent.jar)
  })

  it('lets the derived client accumulate its own cookies without touching the parent\'s', async () => {
    const f = stubFetch([{ status: 200, body: 'ok', headers: { 'set-cookie': 'JSESSIONID=child-session' } }])
    const parent = new HttpClient({ fetchImpl: f.impl, sleep: noSleep, rps: 0 })
    const child = parent.withJar(new CookieJar())
    await child.request('https://example.test/a')
    expect(child.jar.header()).toContain('JSESSIONID=child-session')
    expect(parent.jar.header()).toBe('')
  })
})

describe('decodeLatin1', () => {
  it('decodes ISO-8859-1 bytes that would be mojibake as UTF-8', () => {
    // "Inspeção" in latin1
    const bytes = Buffer.from([0x49, 0x6e, 0x73, 0x70, 0x65, 0xe7, 0xe3, 0x6f])
    expect(decodeLatin1(bytes)).toBe('Inspeção')
  })
})
