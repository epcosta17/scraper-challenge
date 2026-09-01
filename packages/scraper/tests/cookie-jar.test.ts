import { describe, it, expect } from 'vitest'
import { CookieJar } from '../src/http/cookie-jar.ts'

const headersWith = (...cookies: string[]) => {
  const h = new Headers()
  for (const c of cookies) h.append('set-cookie', c)
  return h
}

describe('CookieJar', () => {
  it('collects cookies and renders a Cookie header', () => {
    const jar = new CookieJar()
    jar.setFromHeaders(headersWith('JSESSIONID=abc; Path=/', 'ROUTER_ID=r1; Path=/'))
    const header = jar.header()
    expect(header).toContain('JSESSIONID=abc')
    expect(header).toContain('ROUTER_ID=r1')
  })

  it('overwrites a cookie when it is re-set', () => {
    const jar = new CookieJar()
    jar.setFromHeaders(headersWith('JSESSIONID=first; Path=/'))
    jar.setFromHeaders(headersWith('JSESSIONID=second; Path=/'))
    expect(jar.header()).toBe('JSESSIONID=second')
  })

  it('returns an empty string when no cookies are stored', () => {
    expect(new CookieJar().header()).toBe('')
  })
})
