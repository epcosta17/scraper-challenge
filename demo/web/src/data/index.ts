import { createFixtureDataSource } from './fixtures.ts'
import type { WebDataSource } from './source.ts'

/**
 * The single place the app decides where its data comes from.
 *
 * Connecting the real database means replacing this one expression with a
 * source backed by `@pje-trf5/core` (open the SQLite file once, keep the
 * handle here). Nothing else in `src/` needs to change: pages only ever see
 * the {@link WebDataSource} interface and the view types in `./types.ts`.
 */
export const data: WebDataSource = createFixtureDataSource()

export type { WebDataSource } from './source.ts'
export * from './types.ts'
