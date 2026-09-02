import { readConfig } from './config.ts'
import { createSqliteDataSource } from './sqlite/source.ts'
import { createRunner } from './runner.ts'
import type { WebDataSource } from './source.ts'

const config = readConfig()

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
export const data: WebDataSource = createSqliteDataSource(config)

/**
 * The worker this server starts when somebody queues work.
 *
 * It is deliberately beside the data source rather than inside it: reading the
 * acervo and running a capture are different powers, and only the two routes
 * that enqueue reach for this one. Pointed at the same database and the same
 * PDF directory the pages read, so what the worker writes is what they show.
 */
export const runner = createRunner(config)

export type { WebDataSource, DocumentFile } from './source.ts'
export * from './types.ts'
