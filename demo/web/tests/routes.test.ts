import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Every link in the navigation points at a page that exists.
 *
 * The same class of failure as the tool inventory: renaming a route file is a
 * structural edit, and nothing connects a string in the nav to a filename on
 * disk. A nav entry left pointing at a page that was moved is a 404 the build
 * is perfectly happy with.
 */
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const pageExists = (href: string): boolean => {
  const name = href.replace(/^\//, '')
  return ['astro', 'ts'].some((ext) =>
    existsSync(fileURLToPath(new URL(`../src/pages/${name}.${ext}`, import.meta.url))))
    || existsSync(fileURLToPath(new URL(`../src/pages/${name}`, import.meta.url)))
    || name === ''
}

describe('the navigation', () => {
  const nav = read('../src/components/Nav.astro')
  const links = [...nav.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1]!)

  it('has the four screens', () => {
    expect(links).toEqual(['/', '/busqueda', '/procesos', '/agente'])
  })

  it.each([['/'], ['/busqueda'], ['/procesos'], ['/agente']])(
    'points %s at a page that exists', (href) => {
      expect(pageExists(href), href).toBe(true)
    })

  it('agrees with the keys the layout accepts', () => {
    const keys = [...nav.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]!)
    const base = read('../src/layouts/Base.astro')
    for (const key of keys) expect(base, key).toContain(`'${key}'`)
  })
})
