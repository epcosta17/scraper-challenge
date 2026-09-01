import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase, FsBlobStore, getMaxCaseId, listFailures, getProbedIds } from '@pje/core'
import { HttpClient } from '../src/http/client.ts'
import { crawl, pdfKeyFor } from '../src/crawl/enumerate.ts'

const realPdf = readFileSync(fileURLToPath(new URL('./fixtures/case-130100.pdf', import.meta.url)))
const errorHtml = Buffer.from('<html>error.seam</html>')

/** Serves a PDF for ids in `present`, HTML otherwise; 429 for ids in `limited`. */
function fakeServer(present: Set<number>, limited = new Set<number>()) {
  const impl = (async (url: string | URL) => {
    const id = Number(new URL(String(url)).searchParams.get('idProcessoTrf'))
    if (limited.has(id)) return new Response('', { status: 429 })
    const body = present.has(id) ? realPdf : errorHtml
    const r = new Response(body, { status: 200 })
    Object.defineProperty(r, 'url', { value: present.has(id) ? 'https://x/document.seam' : 'https://x/error.seam' })
    return r
  }) as unknown as typeof fetch
  return new HttpClient({ fetchImpl: impl, sleep: async () => {}, rps: 0, backoff: { maxAttempts: 2 } })
}

let dir: string
let db: ReturnType<typeof openDatabase>
let blobs: FsBlobStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pje-crawl-'))
  db = openDatabase(join(dir, 'test.db'))
  blobs = new FsBlobStore(join(dir, 'pdfs'))
  return () => { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

describe('pdfKeyFor', () => {
  it('derives a descriptive, collision-free key from the case number', () => {
    expect(pdfKeyFor({ number: '0013475-36.2026.4.05.0000' }))
      .toBe('2026/0013475-36.2026.4.05.0000/summary.pdf')
  })
})

describe('crawl', () => {
  it('stores cases whose id yields a PDF', async () => {
    const client = fakeServer(new Set([1, 2]))
    const summary = await crawl({ client, db, blobs }, { fromId: 1, toId: 1, concurrency: 1 })
    expect(summary.stored).toBe(1)
    expect(getMaxCaseId(db)).toBe(1)
  })

  it('records misses as probes, not failures', async () => {
    const client = fakeServer(new Set())
    await crawl({ client, db, blobs }, { fromId: 10, toId: 12, concurrency: 1 })
    expect(getProbedIds(db)).toEqual(new Set([10, 11, 12]))
    expect(listFailures(db)).toHaveLength(0)
  })

  it('records a persistent 429 as a failure and keeps going', async () => {
    const client = fakeServer(new Set([21]), new Set([20]))
    const summary = await crawl({ client, db, blobs }, { fromId: 20, toId: 21, concurrency: 1 })
    expect(summary.failed).toBe(1)
    const failures = listFailures(db, { unresolvedOnly: true })
    expect(failures[0]!.ref).toBe('20')
    expect(summary.stored).toBe(1) // continued past the failure
  })

  it('writes the PDF to the blob store', async () => {
    const client = fakeServer(new Set([1]))
    await crawl({ client, db, blobs }, { fromId: 1, toId: 1, concurrency: 1 })
    expect(await blobs.exists('2026/0013475-36.2026.4.05.0000/summary.pdf')).toBe(true)
  })

  it('stops after N consecutive misses when no explicit end is given', async () => {
    const client = fakeServer(new Set())
    const summary = await crawl({ client, db, blobs }, { fromId: 1, stopAfterMisses: 3, concurrency: 1 })
    expect(summary.absent).toBe(3)
    expect(summary.lastId).toBe(3)
  })

  it('resumes from the stored watermark when no start is given', async () => {
    const client = fakeServer(new Set([1]))
    await crawl({ client, db, blobs }, { fromId: 1, toId: 1, concurrency: 1 })
    const before = getMaxCaseId(db)
    const summary = await crawl({ client, db, blobs }, { stopAfterMisses: 2, concurrency: 1 })
    expect(before).toBe(1)
    expect(summary.lastId).toBe(3)
  })

  it('reports progress for every id examined', async () => {
    const seen: string[] = []
    const client = fakeServer(new Set([1]))
    await crawl({ client, db, blobs }, {
      fromId: 1, toId: 2, concurrency: 1,
      onProgress: (p) => seen.push(p.outcome),
    })
    expect(seen).toEqual(['stored', 'absent'])
  })

  it('keeps the consecutive-miss streak faithful to id order, not completion order, under concurrency', async () => {
    // Only id 2 is a hit; ids 1, 3, 4, 5 are misses. The hit does real work
    // the miss path doesn't (PDF parse + an async blob write), so it
    // reliably resolves LAST among these five even though it was dispatched
    // second — completion order is 1, 3, 4, 5, 2, not id order.
    //
    // A streak counter that updates at *completion* time would see misses
    // 1, 3, 4 land back-to-back (the hit hasn't reset it yet) and stop
    // after id 4 — one id early, never even requesting id 5. The true
    // id-order streak — broken by the hit at 2 — is only 3, 4, 5, so the
    // crawl must stop after id 5, with the hit still counted.
    //
    // `limit: 5` is a test-only safety net, not part of what's under test:
    // the id-ordered frontier can't tell the streak is broken until id 2
    // resolves, so — as documented on `crawl`'s `outcomes`/`frontier` — it
    // will keep dispatching ids past 5 for as long as id 2 is outstanding.
    // That's bounded by nothing but id 2's latency, so without a cap this
    // test would be at the mercy of how fast this machine's disk is.
    const client = fakeServer(new Set([2]))
    const seen: string[] = []
    const summary = await crawl({ client, db, blobs }, {
      fromId: 1, concurrency: 2, stopAfterMisses: 3, limit: 5,
      onProgress: (p) => seen.push(`${p.id}:${p.outcome}`),
    })
    // Confirms the scenario actually exercises out-of-order completion —
    // id 2's outcome is reported after id 3's, not before.
    expect(seen.indexOf('2:stored')).toBeGreaterThan(seen.indexOf('3:absent'))
    expect(summary).toEqual({ stored: 1, absent: 4, failed: 0, lastId: 5 })
  })
})
