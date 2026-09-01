import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/cli.ts'

// `main` accepts `fetchImpl` purely as a test seam: production always goes
// through the real `fetch`, but a test needs a way to prove a code path
// never reaches the network at all — a fetch stub that throws is the
// simplest way to turn "a request went out" into a loud, immediate failure.
function throwingFetch(): typeof fetch {
  return (async () => {
    throw new Error('network should not have been reached')
  }) as unknown as typeof fetch
}

describe('main — search validates before touching the network', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    errorSpy?.mockRestore()
  })

  it('rejects an invalid --party filter without making any request', async () => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(throwingFetch())

    const code = await main(['search', '--party', 'SILVA'], { fetchImpl })

    expect(code).toBe(2)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('--party requires at least two names'),
    )
  })
})

describe('main — crawl --dry-run stays off disk', () => {
  let dir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    logSpy?.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not create the database file for a dry run', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pje-cli-dryrun-'))
    const dbPath = join(dir, 'dryrun-check.db')
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const code = await main(['crawl', '--dry-run', '--db', dbPath])

    expect(code).toBe(0)
    expect(existsSync(dbPath)).toBe(false)
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
  })
})
