import { describe, it, expect, beforeEach } from 'vitest'
import type { JobProgressUpdate } from '@pje/core'
import { enqueueJob, claimNextJob, upsertCase } from '@pje/core'
import type { CrawlOptions, DeepRangeOptions, DeepTarget, DeepOptions } from '@pje/scraper'
import { HANDLERS, type HandlerDeps } from '../src/handlers.ts'
import { JobPayloadError } from '../src/errors.ts'
import { tempWorkspace, recordingReporter, offlineClient, stubEngine } from './helpers.ts'

let ws: ReturnType<typeof tempWorkspace>
let published: JobProgressUpdate[]
let reporter: ReturnType<typeof recordingReporter>

beforeEach(() => {
  ws = tempWorkspace()
  published = []
  reporter = recordingReporter()
  return () => ws.close()
})

/** Enqueues a job, claims it, and runs the handler registered for its type. */
async function run(type: Parameters<typeof enqueueJob>[1], payload: object, engine = stubEngine()): Promise<string> {
  enqueueJob(ws.db, type, payload as Record<string, unknown>)
  const job = claimNextJob(ws.db)!
  const deps: HandlerDeps = { db: ws.db, blobs: ws.blobs, client: offlineClient(), engine }
  return HANDLERS[type](deps, {
    job,
    publish: (p) => { published.push(p) },
    reporter,
    concurrency: 4,
  })
}

const storeCase = (id: number, number: string): void => {
  upsertCase(ws.db, {
    idProcessoTrf: id, number, ca: null, className: 'C', classCode: null, court: null,
    panel: null, distributedAt: null, subjects: [], parties: [], summaryPdfKey: null,
    jurisdiction: null, courtAddress: null, referenceNumber: null,
  })
}

describe('the crawl handler', () => {
  it('passes the payload through to the engine unchanged', async () => {
    let seen: CrawlOptions | undefined
    await run('crawl', { fromId: 10, toId: 19, concurrency: 2, stopAfterMisses: 7 }, stubEngine({
      crawl: async (_d, o) => { seen = o; return { stored: 0, absent: 0, failed: 0, lastId: 19 } },
    }))
    expect(seen).toMatchObject({ fromId: 10, toId: 19, concurrency: 2, stopAfterMisses: 7 })
  })

  it('falls back to the worker concurrency when the payload names none', async () => {
    let seen: CrawlOptions | undefined
    await run('crawl', { fromId: 1, toId: 2 }, stubEngine({
      crawl: async (_d, o) => { seen = o; return { stored: 0, absent: 0, failed: 0, lastId: 2 } },
    }))
    expect(seen?.concurrency).toBe(4)
  })

  it('publishes an exact total for an explicit range, and counts ids as they resolve', async () => {
    await run('crawl', { fromId: 100, toId: 102 }, stubEngine({
      crawl: async (_d, o) => {
        for (const id of [100, 101, 102]) {
          o.onProgress?.({ id, outcome: 'stored', stored: id - 99, absent: 0, failed: 0 })
        }
        return { stored: 3, absent: 0, failed: 0, lastId: 102 }
      },
    }))
    expect(published[0]).toEqual({ done: 0, total: 3, totalIsEstimate: false })
    expect(published.map((p) => p.done)).toEqual([0, 1, 2, 3])
  })

  it('measures a watermark crawl from the stored watermark, not from zero', async () => {
    storeCase(500, '0000001-00.2020.4.05.0000')
    await run('crawl', { toId: 510 })
    // Ids 501..510 remain, not 0..510.
    expect(published[0]).toEqual({ done: 0, total: 10, totalIsEstimate: false })
  })

  it('calls a limit an estimate — a crawl can stop short of it on a run of misses', async () => {
    await run('crawl', { fromId: 1, limit: 50 })
    expect(published[0]).toEqual({ done: 0, total: 50, totalIsEstimate: true })
  })

  it('reports no total at all for an open-ended crawl', async () => {
    await run('crawl', {})
    expect(published[0]).toEqual({ done: 0, total: null, totalIsEstimate: false })
  })

  it('succeeds even when individual ids failed — those are recorded as failures, not as the job dying', async () => {
    const summary = await run('crawl', { fromId: 1, toId: 3 }, stubEngine({
      crawl: async () => ({ stored: 1, absent: 1, failed: 1, lastId: 3 }),
    }))
    expect(summary).toContain('1 failed')
  })

  it('runs discover and backfill too — both are a crawl under another name', async () => {
    await expect(run('discover', {})).resolves.toContain('stored')
    await expect(run('backfill', { fromId: 1, toId: 2 })).resolves.toContain('stored')
  })

  it('refuses a malformed payload before the engine is called at all', async () => {
    let called = false
    await expect(run('crawl', { fromId: 20, toId: 10 }, stubEngine({
      crawl: async () => { called = true; return { stored: 0, absent: 0, failed: 0, lastId: 0 } },
    }))).rejects.toThrow(JobPayloadError)
    expect(called).toBe(false)
  })
})

describe('the deep_case handler', () => {
  it('targets the case by id', async () => {
    let seen: DeepTarget | undefined
    await run('deep_case', { idProcessoTrf: 130100 }, stubEngine({
      deepCase: async (_d, t) => {
        seen = t
        return { kind: 'done', idProcessoTrf: 130100, number: 'N', documentsStored: 2, documentsSkipped: 0, documentsFailed: 0 }
      },
    }))
    expect(seen).toEqual({ kind: 'id', id: 130100 })
  })

  it('targets the case by number, for a case not yet in the acervo', async () => {
    let seen: DeepTarget | undefined
    await run('deep_case', { number: '0013475-36.2026.4.05.0000' }, stubEngine({
      deepCase: async (_d, t) => {
        seen = t
        return { kind: 'done', idProcessoTrf: 1, number: 'N', documentsStored: 0, documentsSkipped: 0, documentsFailed: 0 }
      },
    }))
    expect(seen).toEqual({ kind: 'number', number: '0013475-36.2026.4.05.0000' })
  })

  it('counts documents, which is the only granularity a single case has', async () => {
    await run('deep_case', { idProcessoTrf: 7 }, stubEngine({
      deepCase: async (_d, _t, o: DeepOptions = {}) => {
        o.onStep?.({ kind: 'documents', ref: '7', total: 3, alreadyOnDisk: 1 })
        o.onDocumentProgress?.({ idProcessoTrf: 7, idProcessoDoc: 1, docKind: 'binary', outcome: 'skipped' })
        o.onDocumentProgress?.({ idProcessoTrf: 7, idProcessoDoc: 2, docKind: 'binary', outcome: 'stored' })
        return { kind: 'done', idProcessoTrf: 7, number: 'N', documentsStored: 1, documentsSkipped: 1, documentsFailed: 0 }
      },
    }))
    expect(published[0]).toEqual({ done: 0, total: null, totalIsEstimate: false })
    // The stage is cleared as the total arrives: from here on the count says
    // more than any phrase, and a stage rewritten per document would flicker.
    expect(published[1]).toEqual({ done: 0, total: 3, stage: null })
    expect(published.map((p) => p.done)).toEqual([0, 0, 1, 2])
  })

  it('names the step it is on, for the stretch before any document is known', async () => {
    await run('deep_case', { idProcessoTrf: 7 }, stubEngine({
      deepCase: async (_d, _t, o: DeepOptions = {}) => {
        // The real order for one case. Everything up to `documents` happens
        // with the counter at zero and no total, which is exactly the stretch
        // that reads as a hung job when nothing says otherwise.
        o.onStep?.({ kind: 'summary_pdf', ref: '7' })
        o.onStep?.({ kind: 'summary_pdf_retry', ref: '7', attempt: 2, of: 3, status: 429 })
        o.onStep?.({ kind: 'detail_key', ref: '7', source: 'search' })
        o.onStep?.({ kind: 'case_file', ref: '7' })
        o.onStep?.({ kind: 'case_file_ok', ref: '7', documentCount: 3 })
        return { kind: 'done', idProcessoTrf: 7, number: 'N', documentsStored: 0, documentsSkipped: 0, documentsFailed: 0 }
      },
    }))
    expect(published.map((p) => p.stage)).toEqual([
      undefined,
      'fetching the summary PDF',
      // A retry says so rather than looking like a stall: still working, and
      // the wait has a reason.
      'retrying the summary PDF (2 of 3, HTTP 429)',
      'resolving the detail key through the search bridge',
      'reading the case file',
      'the case file lists 3 documents',
    ])
  })

  it('fails the job when the case failed — one case is the whole job', async () => {
    await expect(run('deep_case', { idProcessoTrf: 9 }, stubEngine({
      deepCase: async () => ({ kind: 'failed', ref: '9', error: 'no summary PDF for id 9' }),
    }))).rejects.toThrow(/no summary PDF for id 9/)
  })
})

describe('the deep_range handler', () => {
  it('counts cases against the size of the range', async () => {
    const summary = await run('deep_range', { fromId: 10, toId: 14 }, stubEngine({
      deepRange: async (_d, o: DeepRangeOptions) => {
        for (const id of [10, 11]) {
          o.onCaseProgress?.({ kind: 'done', idProcessoTrf: id, number: 'N', documentsStored: 1, documentsSkipped: 0, documentsFailed: 0 })
        }
        o.onCaseProgress?.({ kind: 'failed', ref: '12', error: 'boom' })
        return { casesDone: 2, casesFailed: 1, documentsStored: 2, documentsSkipped: 0, documentsFailed: 0 }
      },
    }))
    expect(published[0]).toEqual({ done: 0, total: 5, totalIsEstimate: false })
    expect(published.map((p) => p.done)).toEqual([0, 1, 2, 3])
    // A range job is done once the range is walked; the failed case is
    // recorded in `failures`, exactly as it is for a `crawl`.
    expect(summary).toContain('1 failed')
  })
})

describe('the refresh_case handler', () => {
  it('re-reads a case that is already stored', async () => {
    storeCase(4242, '0000042-00.2020.4.05.0000')
    let seen: DeepTarget | undefined
    await run('refresh_case', { idProcessoTrf: 4242 }, stubEngine({
      deepCase: async (_d, t) => {
        seen = t
        return { kind: 'done', idProcessoTrf: 4242, number: 'N', documentsStored: 0, documentsSkipped: 3, documentsFailed: 0 }
      },
    }))
    expect(seen).toEqual({ kind: 'id', id: 4242 })
  })

  it('resolves a case number to the id already on file, with no search bridge needed', async () => {
    storeCase(4242, '0000042-00.2020.4.05.0000')
    let seen: DeepTarget | undefined
    await run('refresh_case', { number: '0000042-00.2020.4.05.0000' }, stubEngine({
      deepCase: async (_d, t) => {
        seen = t
        return { kind: 'done', idProcessoTrf: 4242, number: 'N', documentsStored: 0, documentsSkipped: 0, documentsFailed: 0 }
      },
    }))
    expect(seen).toEqual({ kind: 'id', id: 4242 })
  })

  it('refuses a case it has never stored, rather than quietly capturing it for the first time', async () => {
    await expect(run('refresh_case', { idProcessoTrf: 99 })).rejects.toThrow(/not stored/i)
  })
})
