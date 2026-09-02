// @ts-check
import { defineConfig } from 'astro/config'
import node from '@astrojs/node'

// Every route is rendered on the server: the pages read from the data layer on
// each request, so once `src/data` talks to the real SQLite file there is no
// build step to re-run to see fresh rows.
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  // v7 defaults to 'jsx', which drops the whitespace between inline elements.
  // Several rows here are built from inline spans separated by a single space.
  compressHTML: true,
  devToolbar: { enabled: false },
  vite: {
    // `better-sqlite3` is a native addon: bundling it would leave Vite trying
    // to resolve a `.node` binary as JavaScript. Marking it external keeps it
    // a plain `require` at runtime, in both `astro dev` and the built server.
    ssr: { external: ["better-sqlite3"] },
  },
})
