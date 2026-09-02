import { readConfig } from './config.ts'
import { createSqliteDataSource } from './sqlite/source.ts'
import type { WebDataSource } from './source.ts'

/**
 * The single place the app decides where its data comes from.
 *
 * It comes from the SQLite file the scraper writes, and from the PDF directory
 * next to it — `PJE_DB` and `PJE_PDFS` say where, defaulting to the scraper's
 * own `data/pje.db` and `data/pdfs` at the repository root (see
 * `./config.ts`). The database handle is opened once, lazily, behind this
 * value; nothing else in `src/` knows it exists. Pages only ever see the
 * {@link WebDataSource} interface and the view types in `./types.ts`.
 */
export const data: WebDataSource = createSqliteDataSource(readConfig())

export type { WebDataSource, DocumentFile } from './source.ts'
export * from './types.ts'
