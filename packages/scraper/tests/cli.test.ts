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

describe('main — progress never touches stdout, `--json` stays the only thing there', () => {
  let dir: string
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    logSpy?.mockRestore()
    errorSpy?.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  it('crawl --json --verbose: stdout gets exactly one call, and it parses as JSON; per-id progress lands on stderr', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pje-cli-json-clean-'))
    const dbPath = join(dir, 'test.db')
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = (async () => new Response(realPdf, { status: 200 })) as unknown as typeof fetch

    const code = await main(
      [
        'crawl', '--from-id', '1', '--to-id', '1', '--concurrency', '1', '--json', '--verbose',
        '--db', dbPath, '--out', join(dir, 'pdfs'),
      ],
      { fetchImpl },
    )

    expect(code).toBe(0)
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(() => JSON.parse(logSpy.mock.calls[0]![0] as string)).not.toThrow()
    // Per-id progress (verbose) went to stderr instead, proving it never
    // shared stdout with the JSON result.
    expect(errorSpy.mock.calls.length).toBeGreaterThan(0)
  })

  it('deep --json --verbose (single target): stdout gets exactly one call, and it parses as JSON', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pje-cli-json-clean-deep-'))
    const dbPath = join(dir, 'test.db')
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = (async () => new Response(realPdf, { status: 200 })) as unknown as typeof fetch

    const code = await main(
      ['deep', '130100', '--json', '--verbose', '--db', dbPath, '--out', join(dir, 'pdfs')],
      { fetchImpl },
    )

    // This target's `ca` can't resolve with this stub (no search bridge
    // wired), so the case comes back as a recorded failure — fine here:
    // only the stdout/stderr split is under test, not the outcome.
    expect(code).toBe(1)
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(() => JSON.parse(logSpy.mock.calls[0]![0] as string)).not.toThrow()
    expect(errorSpy.mock.calls.length).toBeGreaterThan(0)
  })
})

describe('main — --dry-run under --json prints a JSON plan, not prose', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    logSpy?.mockRestore()
  })

  /** The one thing every caller of `--json` relies on: stdout parses. */
  function stdoutJson(): unknown {
    expect(logSpy).toHaveBeenCalledTimes(1)
    return JSON.parse(String(logSpy.mock.calls[0]![0]))
  }

  it('search --dry-run --json reports the filters it would submit', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn(throwingFetch())

    const code = await main(
      ['search', '--number', '0013201-41.2025.4.05.8202', '--dry-run', '--json'],
      { fetchImpl },
    )

    expect(code).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(stdoutJson()).toEqual({
      dryRun: true,
      command: 'search',
      filters: { number: '0013201-41.2025.4.05.8202' },
    })
  })

  it('crawl --dry-run --json reports the id range, with nulls for the defaults', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn(throwingFetch())

    const code = await main(['crawl', '--dry-run', '--json'], { fetchImpl })

    expect(code).toBe(0)
    expect(stdoutJson()).toEqual({ dryRun: true, command: 'crawl', fromId: null, toId: null })
  })

  it('daily --dry-run --json names the command it actually ran', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const code = await main(['daily', '--dry-run', '--json'], { fetchImpl: vi.fn(throwingFetch()) })

    expect(code).toBe(0)
    expect(stdoutJson()).toEqual({ dryRun: true, command: 'daily', fromId: null, toId: null })
  })

  it('deep <target> --dry-run --json reports the single target', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const code = await main(
      ['deep', '0013201-41.2025.4.05.8202', '--dry-run', '--json'],
      { fetchImpl: vi.fn(throwingFetch()) },
    )

    expect(code).toBe(0)
    expect(stdoutJson()).toEqual({
      dryRun: true,
      command: 'deep',
      target: '0013201-41.2025.4.05.8202',
      fromId: null,
      toId: null,
    })
  })

  it('deep --from-id/--to-id --dry-run --json reports the range', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const code = await main(
      ['deep', '--from-id', '130100', '--to-id', '130102', '--dry-run', '--json'],
      { fetchImpl: vi.fn(throwingFetch()) },
    )

    expect(code).toBe(0)
    expect(stdoutJson()).toEqual({
      dryRun: true,
      command: 'deep',
      target: null,
      fromId: 130100,
      toId: 130102,
    })
  })

  it('keeps the human-readable plan lines unchanged without --json', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn(throwingFetch())

    await main(['crawl', '--from-id', '130100', '--to-id', '130105', '--dry-run'], { fetchImpl })
    await main(['deep', '130100', '--dry-run'], { fetchImpl })
    await main(['deep', '--from-id', '1', '--to-id', '2', '--dry-run'], { fetchImpl })
    // `search` is deliberately absent here: it is the one command whose
    // default is JSON, so its prose plan needs `--text` (asserted below).
    expect(logSpy.mock.calls.map((c) => String(c[0]))).toEqual([
      'Would crawl from 130100 to 130105',
      'Would deep-fetch case 130100',
      'Would deep-fetch every case from id 1 to 2',
    ])
  })

  it('gives `search` a JSON plan by default and prose only under --text', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn(throwingFetch())

    await main(['search', '--number', '0013201-41.2025.4.05.8202', '--dry-run'], { fetchImpl })
    await main(['search', '--number', '0013201-41.2025.4.05.8202', '--dry-run', '--text'], { fetchImpl })

    const [asJson, asProse] = logSpy.mock.calls.map((c) => String(c[0]))
    expect(JSON.parse(asJson!)).toEqual({
      dryRun: true,
      command: 'search',
      filters: { number: '0013201-41.2025.4.05.8202' },
    })
    expect(asProse).toBe('Would search with filters: {"number":"0013201-41.2025.4.05.8202"}')
  })
})

describe('main — log levels', () => {
  let dir: string
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    logSpy?.mockRestore()
    errorSpy?.mockRestore()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /** A portal that answers the summary PDF and nothing else: enough to narrate the first steps. */
  const pdfOnlyPortal = (async () => new Response(realPdf, { status: 200 })) as unknown as typeof fetch

  it('narrates the run by default: a header, then each step as it starts', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pje-cli-narration-'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['crawl', '--from-id', '1', '--to-id', '1', '--concurrency', '1', '--db', join(dir, 'test.db'), '--out', join(dir, 'pdfs')],
      { fetchImpl: pdfOnlyPortal },
    )

    const stderr = errorSpy.mock.calls.map((c) => String(c[0]))
    expect(stderr[0]).toContain('Crawling 1 id (1-1)')
    expect(stderr[0]).toContain(`db ${join(dir, 'test.db')}`)
    // The result itself is still the only thing on stdout.
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Stored:  1')
  })

  it('--quiet leaves stderr empty and stdout carrying the result alone', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pje-cli-quiet-'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const code = await main(
      ['crawl', '--from-id', '1', '--to-id', '1', '--concurrency', '1', '--quiet', '--db', join(dir, 'test.db'), '--out', join(dir, 'pdfs')],
      { fetchImpl: pdfOnlyPortal },
    )

    expect(code).toBe(0)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(String(logSpy.mock.calls[0]![0])).toContain('Stored:  1')
  })

  it('--verbose adds the requests underneath the narration', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pje-cli-verbose-http-'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['crawl', '--from-id', '1', '--to-id', '1', '--concurrency', '1', '--verbose', '--db', join(dir, 'test.db'), '--out', join(dir, 'pdfs')],
      { fetchImpl: pdfOnlyPortal },
    )

    const stderr = errorSpy.mock.calls.map((c) => String(c[0]))
    expect(stderr.some((l) => l.includes('→ GET https://'))).toBe(true)
    expect(stderr.some((l) => l.startsWith('  ← 200'))).toBe(true)
    expect(stderr.some((l) => l.startsWith('+ id=1'))).toBe(true)
  })

  it('rejects --quiet --verbose before doing any work', async () => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(throwingFetch())

    const code = await main(['crawl', '--quiet', '--verbose'], { fetchImpl })

    expect(code).toBe(2)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
