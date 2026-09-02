import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { enqueueJob, getJob, countJobsByStatus, listFailures } from '@pje/core'
import { main, createShutdownHandler } from '../src/run.ts'
import { WORKER_VERSION } from '../src/version.ts'
import type { Worker } from '../src/worker.ts'
import { tempWorkspace, recordingReporter } from './helpers.ts'

// The scraper's own captured-from-the-portal fixtures. Shared rather than
// copied on purpose: this test's whole point is that the worker drives the
// *real* engine, so it has to face the same bytes that engine was built
// against — a second, hand-written copy would drift and quietly stop proving
// anything.
const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`../../../packages/scraper/tests/fixtures/${name}`, import.meta.url)))

const realPdf = fixture('case-130100.pdf')
const CASE_NUMBER = '0013475-36.2026.4.05.0000'

function throwingFetch(): typeof fetch {
  return (async () => { throw new Error('network should not have been reached') }) as unknown as typeof fetch
}

/**
 * A stand-in for the portal covering every hop the engine makes: the summary
 * PDF endpoint, the session bootstrap, the search AJAX the detail key comes
 * from, the detail page, and the HTML document endpoint. Any id in `absent`
 * answers with the portal's real error.seam page, which is how it says "no
 * such case" — the shape a failing job needs.
 */
function fakePortal(absent: readonly number[] = []): typeof fetch {
  const detailHtml = fixture('detail-html-docs-only.html')
  const listViewSession = fixture('list-view.html')
  const errorSeam = fixture('error-seam.html')

  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    if (u.pathname.endsWith('/reportPDF.seam')) {
      const id = Number(u.searchParams.get('idProcessoTrf') ?? u.search.replace(/\D+/g, ''))
      if (absent.includes(id)) return new Response(errorSeam, { status: 200 })
      return new Response(realPdf, { status: 200 })
    }
    if (u.pathname.endsWith('/documentoSemLoginHTML.seam')) {
      return new Response(Buffer.from('<html>ato</html>', 'latin1'), { status: 200 })
    }
    if (u.pathname.endsWith('/DetalheProcessoConsultaPublica/listView.seam')) {
      return new Response(detailHtml, { status: 200 })
    }
    if (u.pathname.startsWith('/pjeconsulta/ConsultaPublica/listView.seam')) {
      if (init?.method === 'POST') {
        const xml =
          `<partial-response><meta name="Ajax-Update-Ids" content="fPP:processosGridPanel" />` +
          `<div id="fPP:processosTable:130100:j_id1">${CASE_NUMBER}` +
          `<a href="listView.seam?ca=${'ca'.repeat(24)}">detail</a></div></partial-response>`
        return new Response(Buffer.from(xml, 'latin1'), { status: 200 })
      }
      return new Response(listViewSession, { status: 200 })
    }
    throw new Error(`unexpected request in test: ${String(url)}`)
  }) as unknown as typeof fetch
}

let ws: ReturnType<typeof tempWorkspace>
let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  ws = tempWorkspace()
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  return () => { logSpy.mockRestore(); errorSpy.mockRestore(); ws.close() }
})

describe('main — the things that never touch a portal', () => {
  it('prints help and exits 0', async () => {
    const fetchImpl = vi.fn(throwingFetch())
    expect(await main(['--help'], { fetchImpl })).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(String(logSpy.mock.calls[0]?.[0])).toContain('drain the jobs queue')
  })

  it('prints the version and exits 0', async () => {
    expect(await main(['--version'])).toBe(0)
    expect(logSpy).toHaveBeenCalledWith(WORKER_VERSION)
  })

  it('exits 2 on a bad flag, before opening anything', async () => {
    const fetchImpl = vi.fn(throwingFetch())
    expect(await main(['--forever'], { fetchImpl })).toBe(2)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('Unknown flag')
  })

  it('exits 0 on an empty queue without making a single request', async () => {
    const fetchImpl = vi.fn(throwingFetch())
    expect(await main(['--db', ws.dbPath, '--out', `${ws.dir}/pdfs`], { fetchImpl })).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('main — draining a real queue through the real engine', () => {
  it('runs a crawl and a deep capture, records progress, and survives a job that fails', async () => {
    const crawlJob = enqueueJob(ws.db, 'crawl', { fromId: 130100, toId: 130100 }).id
    const deepJob = enqueueJob(ws.db, 'deep_case', { idProcessoTrf: 130100 }).id
    const doomed = enqueueJob(ws.db, 'deep_case', { idProcessoTrf: 999999 }).id
    const after = enqueueJob(ws.db, 'refresh_case', { number: CASE_NUMBER }).id

    const code = await main(
      ['--db', ws.dbPath, '--out', `${ws.dir}/pdfs`, '--rate', '1000', '--attempts', '1'],
      { fetchImpl: fakePortal([999999]) },
    )

    // One job failed, so the run is not clean — but every other job ran.
    expect(code).toBe(1)
    expect(getJob(ws.db, crawlJob)!.status).toBe('done')
    expect(getJob(ws.db, deepJob)!.status).toBe('done')
    expect(getJob(ws.db, doomed)!.status).toBe('failed')
    expect(getJob(ws.db, doomed)!.error).toMatch(/999999/)
    // The failure did not block the queue: the job behind it still ran.
    expect(getJob(ws.db, after)!.status).toBe('done')
    expect(countJobsByStatus(ws.db)).toEqual({ pending: 0, running: 0, done: 3, failed: 1 })

    // Progress survived each job, against the total each one knew.
    expect(getJob(ws.db, crawlJob)!.progress).toEqual({ done: 1, total: 1, totalIsEstimate: false })
    expect(getJob(ws.db, deepJob)!.progress.total).toBeGreaterThan(0)

    // The case really was captured, by the real engine.
    const stored = ws.db.prepare('SELECT number FROM cases').all() as Array<{ number: string }>
    expect(stored.map((r) => r.number)).toEqual([CASE_NUMBER])
    expect((ws.db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n).toBeGreaterThan(0)

    // And the failure is on the record where failures go, not only on the job.
    expect(listFailures(ws.db, { unresolvedOnly: true }).some((f) => f.ref === '999999')).toBe(true)
  })

  it('stops after --max-jobs and leaves the rest queued', async () => {
    enqueueJob(ws.db, 'crawl', { fromId: 130100, toId: 130100 })
    const later = enqueueJob(ws.db, 'crawl', { fromId: 130100, toId: 130100 }).id

    const code = await main(
      ['--db', ws.dbPath, '--out', `${ws.dir}/pdfs`, '--rate', '1000', '--max-jobs', '1'],
      { fetchImpl: fakePortal() },
    )

    expect(code).toBe(0)
    expect(getJob(ws.db, later)!.status).toBe('pending')
  })

  it('puts the summary on stdout as JSON, exactly once', async () => {
    enqueueJob(ws.db, 'crawl', { fromId: 130100, toId: 130100 })

    await main(
      ['--db', ws.dbPath, '--out', `${ws.dir}/pdfs`, '--rate', '1000', '--json', '--verbose'],
      { fetchImpl: fakePortal() },
    )

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({ claimed: 1, done: 1, stopped: 'drained' })
  })
})

describe('createShutdownHandler', () => {
  function fakeWorker(currentJobId: number | null) {
    const calls: string[] = []
    const worker = {
      currentJobId,
      run: async () => { throw new Error('not used') },
      drain: () => { calls.push('drain') },
      abandon: (reason: string) => { calls.push(`abandon:${reason}`); return true },
    } as unknown as Worker
    return { worker, calls }
  }

  it('lets the job in flight finish on the first signal', () => {
    const { worker, calls } = fakeWorker(7)
    const reporter = recordingReporter()
    const exit = vi.fn()

    createShutdownHandler({ worker, reporter, exit })('SIGINT')

    expect(calls).toEqual(['drain'])
    expect(exit).not.toHaveBeenCalled()
    expect(reporter.lines.join('\n')).toContain('letting job 7 finish')
  })

  it('hands the job back and stops on the second', () => {
    const { worker, calls } = fakeWorker(7)
    const reporter = recordingReporter()
    const exit = vi.fn()
    const handle = createShutdownHandler({ worker, reporter, exit })

    handle('SIGINT')
    handle('SIGINT')

    expect(calls).toEqual(['drain', expect.stringContaining('abandon:Interrupted by SIGINT')])
    expect(exit).toHaveBeenCalledWith(130)
  })

  it('says so plainly when there is nothing in flight to wait for', () => {
    const { worker, calls } = fakeWorker(null)
    const reporter = recordingReporter()

    createShutdownHandler({ worker, reporter, exit: vi.fn() })('SIGTERM')

    expect(calls).toEqual(['drain'])
    expect(reporter.lines.join('\n')).toContain('nothing in flight')
  })
})
