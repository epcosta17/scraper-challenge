/// <reference types="vite/client" />

/**
 * Vite's `?url` import suffix, which hands back the built asset's path instead
 * of its contents. `vite/client` declares it, and this file is what tells the
 * standalone typecheck (`tsconfig.check.json`, which compiles `src` without
 * Astro's generated types) that those declarations exist — otherwise the
 * pdf.js worker import reads as a missing module.
 */
