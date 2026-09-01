import { describe, it, expect } from 'vitest'
import { HttpClient, RateLimitedError, decodeLatin1 } from '../src/http/client.ts'

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
})

describe('decodeLatin1', () => {
  it('decodes ISO-8859-1 bytes that would be mojibake as UTF-8', () => {
    // "Inspeção" in latin1
    const bytes = Buffer.from([0x49, 0x6e, 0x73, 0x70, 0x65, 0xe7, 0xe3, 0x6f])
    expect(decodeLatin1(bytes)).toBe('Inspeção')
  })
})
