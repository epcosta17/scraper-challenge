import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findRepoRoot, readConfig } from '../src/data/config.ts'

let root: string
let workspace: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pje-root-'))
  workspace = join(root, 'demo', 'web')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['demo/*'] }))
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: '@pje-trf5/web' }))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('finding the acervo', () => {
  it('climbs out of the workspace to the root that declares it', () => {
    // `npm run dev --workspace demo/web` starts here; the database is two
    // directories up, and a default relative to the working directory would
    // create an empty one next to the app instead.
    expect(findRepoRoot(workspace)).toBe(resolve(root))
  })

  it('stops at the working directory when nothing declares a workspace', () => {
    const orphan = mkdtempSync(join(tmpdir(), 'pje-orphan-'))
    expect(findRepoRoot(orphan)).toBe(resolve(orphan))
    rmSync(orphan, { recursive: true, force: true })
  })

  it('defaults to the scraper\'s own paths', () => {
    const config = readConfig({} as NodeJS.ProcessEnv)
    expect(config.databasePath.endsWith(join('data', 'pje.db'))).toBe(true)
    expect(config.blobRoot.endsWith(join('data', 'pdfs'))).toBe(true)
  })

  it('takes an absolute override as it is given', () => {
    const config = readConfig({ PJE_DB: '/srv/acervo.db', PJE_PDFS: '/srv/pdfs' } as NodeJS.ProcessEnv)
    expect(config).toEqual({ databasePath: '/srv/acervo.db', blobRoot: '/srv/pdfs' })
  })

  it('resolves a relative override against the directory the server was started in', () => {
    const config = readConfig({ PJE_DB: './tmp/other.db' } as NodeJS.ProcessEnv)
    expect(config.databasePath).toBe(resolve(process.cwd(), 'tmp/other.db'))
  })

  it('ignores a blank override rather than reading the current directory', () => {
    const blank = readConfig({ PJE_DB: '   ' } as NodeJS.ProcessEnv)
    expect(blank.databasePath).toBe(readConfig({} as NodeJS.ProcessEnv).databasePath)
  })
})
