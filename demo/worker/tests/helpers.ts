import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, FsBlobStore, type Db, type BlobStore } from '@pje/core'
import { HttpClient, type Reporter } from '@pje/scraper'
import type { Engine } from '../src/handlers.ts'

/** A temporary database and blob root, torn down by the returned callback. */
export function tempWorkspace(): { dir: string; dbPath: string; db: Db; blobs: BlobStore; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pje-worker-'))
  const dbPath = join(dir, 'jobs.db')
  const db = openDatabase(dbPath)
  return {
    dir,
    dbPath,
    db,
    blobs: new FsBlobStore(join(dir, 'pdfs')),
    close: () => { db.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

/** A reporter that keeps its lines instead of printing them. */
export function recordingReporter(): Reporter & { lines: string[] } {
  const lines: string[] = []
  const keep = (line: string): void => { lines.push(line) }
  return {
    lines,
    header: keep,
    note: keep,
    detail: keep,
    deepStep: (e) => keep(`step ${e.kind} ${e.ref}`),
    deepDocument: (p) => keep(`doc ${p.idProcessoDoc} ${p.outcome}`),
    deepCase: (o) => keep(`case ${o.kind}`),
    crawlProgress: (p) => keep(`crawl ${p.id} ${p.outcome}`),
    http: (e) => keep(`http ${e.kind}`),
  }
}

/** An `HttpClient` whose transport fails loudly — nothing here should reach a network. */
export function offlineClient(): HttpClient {
  return new HttpClient({
    rps: 0,
    fetchImpl: (async () => { throw new Error('no request should have been made') }) as unknown as typeof fetch,
  })
}

/** An engine whose three entry points are stubs, so a handler can be driven without a portal. */
export function stubEngine(overrides: Partial<Engine> = {}): Engine {
  return {
    crawl: async () => ({ stored: 0, absent: 0, failed: 0, lastId: 0 }),
    deepCase: async () => ({ kind: 'done', idProcessoTrf: 1, number: 'n', documentsStored: 0, documentsSkipped: 0, documentsFailed: 0 }),
    deepRange: async () => ({ casesDone: 0, casesFailed: 0, documentsStored: 0, documentsSkipped: 0, documentsFailed: 0 }),
    ...overrides,
  }
}
