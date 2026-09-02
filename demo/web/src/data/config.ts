import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'

/**
 * Where the acervo lives.
 *
 * The two paths are the scraper's own `--db` and `--out`, under the same
 * defaults (`data/pje.db`, `data/pdfs`) — point the web at a database and you
 * point it at the PDFs that go with it. `PJE_DB` and `PJE_PDFS` override them;
 * a relative override resolves against the working directory the server was
 * started in, so `PJE_DB=./tmp/other.db npm run start` reads what you expect.
 */
export interface WebDataConfig {
  databasePath: string
  blobRoot: string
}

/**
 * The defaults hang off the repository root, not off this file and not off the
 * working directory.
 *
 * Not off this file, because `astro build` bundles it into `dist/server/` and
 * a path counted in `..`s from the source tree would land somewhere else in
 * the built server than in `astro dev`. Not off the working directory either,
 * because `npm run dev --workspace demo/web` starts in `demo/web`, and a
 * default of `data/pje.db` relative to that would quietly create an empty
 * second database next to the app instead of finding the one the scraper
 * filled.
 *
 * So it is found the way every other tool in a workspace finds it: walk up
 * until a `package.json` declares `workspaces`. If nothing does — the app
 * copied out of the repository, say — the working directory is the answer, and
 * `PJE_DB` is there for that case.
 */
export function findRepoRoot(from: string = process.cwd()): string {
  let dir = resolve(from)
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        workspaces?: unknown
      }
      if (manifest.workspaces !== undefined) return dir
    } catch {
      // No manifest here, or one that is not readable: keep climbing.
    }
    const parent = dirname(dir)
    if (parent === dir || dir === parse(dir).root) return resolve(from)
    dir = parent
  }
}

const fromEnv = (value: string | undefined, fallback: string, root: string): string => {
  const raw = value?.trim()
  if (raw === undefined || raw === '') return resolve(root, fallback)
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): WebDataConfig {
  const root = findRepoRoot()
  return {
    databasePath: fromEnv(env.PJE_DB, 'data/pje.db', root),
    blobRoot: fromEnv(env.PJE_PDFS, 'data/pdfs', root),
  }
}
