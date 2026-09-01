import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../src/cli/run.ts'
import { SCRAPER_VERSION } from '../src/version.ts'

const realPdf = readFileSync(fileURLToPath(new URL('./fixtures/case-130100.pdf', import.meta.url)))

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

describe('main — --version', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    logSpy?.mockRestore()
  })

  it('prints the version and exits 0 without touching the network', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn(throwingFetch())

    const code = await main(['--version'], { fetchImpl })

    expect(code).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith(SCRAPER_VERSION)
  })
})

describe('main — search --dry-run performs no network call', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    logSpy?.mockRestore()
  })

  it('prints the plan, touches no network, and exits 0', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn(throwingFetch())

    const code = await main(
      ['search', '--number', '0013201-41.2025.4.05.8202', '--dry-run'],
      { fetchImpl },
    )

    expect(code).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('main — rejects positional arguments before touching the network', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    errorSpy?.mockRestore()
  })

  it('rejects `search <bare case number>` instead of running an unfiltered search', async () => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(throwingFetch())

    const code = await main(['search', '0013201-41.2025.4.05.8202'], { fetchImpl })

    expect(code).toBe(2)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--number'))
  })
})

describe('main — deep', () => {
  let dir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    logSpy?.mockRestore()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('rejects a deep call with neither a target nor a range, before touching the network', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(throwingFetch())
    const code = await main(['deep'], { fetchImpl })
    expect(code).toBe(2)
    expect(fetchImpl).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('--dry-run prints the plan and stays off the network and disk', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pje-cli-deep-dryrun-'))
    const dbPath = join(dir, 'test.db')
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn(throwingFetch())

    const code = await main(
      ['deep', '0013201-41.2025.4.05.8202', '--dry-run', '--db', dbPath],
      { fetchImpl },
    )

    expect(code).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(existsSync(dbPath)).toBe(false)
  })

  it('runs the whole chain end to end for a bare-id target and exits 0', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pje-cli-deep-run-'))
    const dbPath = join(dir, 'test.db')
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const detailHtmlOnly = readFileSync(
      fileURLToPath(new URL('./fixtures/detail-html-docs-only.html', import.meta.url)),
    )
    const listViewSession = readFileSync(
      fileURLToPath(new URL('./fixtures/list-view.html', import.meta.url)),
    )

    // A fresh id has no stored ca, so `deep` must run the search bridge
    // before it can even reach the detail page — this fake portal covers
    // every hop of the chain: summary PDF, session bootstrap, search AJAX,
    // detail page, and the HTML document endpoint.
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      if (u.pathname.endsWith('/reportPDF.seam')) return new Response(realPdf, { status: 200 })
      if (u.pathname.endsWith('/documentoSemLoginHTML.seam')) {
        return new Response(Buffer.from('<html>ato</html>', 'latin1'), { status: 200 })
      }
      if (u.pathname.endsWith('/DetalheProcessoConsultaPublica/listView.seam')) {
        return new Response(detailHtmlOnly, { status: 200 })
      }
      if (u.pathname.startsWith('/pjeconsulta/ConsultaPublica/listView.seam')) {
        if (init?.method === 'POST') {
          const xml =
            `<partial-response><meta name="Ajax-Update-Ids" content="fPP:processosGridPanel" />` +
            `<div id="fPP:processosTable:130100:j_id1">0013475-36.2026.4.05.0000` +
            `<a href="listView.seam?ca=${'ca'.repeat(24)}">detail</a></div></partial-response>`
          return new Response(Buffer.from(xml, 'latin1'), { status: 200 })
        }
        return new Response(listViewSession, { status: 200 })
      }
      throw new Error(`unexpected request in test: ${String(url)}`)
    }) as unknown as typeof fetch

    const code = await main(
      ['deep', '130100', '--db', dbPath, '--out', join(dir, 'pdfs'), '--rate', '1000'],
      { fetchImpl },
    )

    expect(code).toBe(0)
  })
})

describe('main — crawl exit code reflects whether the run recorded failures', () => {
  let dir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    logSpy?.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  it('exits nonzero when every id in the run failed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pje-cli-exit-fail-'))
    const dbPath = join(dir, 'test.db')
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    // %PDF- magic but no recoverable case number inside: parseCaseRecord
    // throws, so the id is recorded as a failure rather than stored.
    const fetchImpl = (async () =>
      new Response('%PDF-not a real pdf', { status: 200 })) as unknown as typeof fetch

    const code = await main(
      ['crawl', '--from-id', '1', '--to-id', '1', '--concurrency', '1', '--db', dbPath, '--out', join(dir, 'pdfs')],
      { fetchImpl },
    )

    expect(code).toBe(1)
  })

  it('exits 0 when the run recorded no failures', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pje-cli-exit-ok-'))
    const dbPath = join(dir, 'test.db')
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = (async () => new Response(realPdf, { status: 200 })) as unknown as typeof fetch

    const code = await main(
      ['crawl', '--from-id', '1', '--to-id', '1', '--concurrency', '1', '--db', dbPath, '--out', join(dir, 'pdfs')],
      { fetchImpl },
    )

    expect(code).toBe(0)
  })
})
