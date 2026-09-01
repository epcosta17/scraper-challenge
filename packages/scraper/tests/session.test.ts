import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseSessionFromHtml, startSession } from '../src/pje/session.ts'
import { HttpClient } from '../src/http/client.ts'

const html = readFileSync(fileURLToPath(new URL('./fixtures/list-view.html', import.meta.url)), 'latin1')
const htmlBuffer = readFileSync(fileURLToPath(new URL('./fixtures/list-view.html', import.meta.url)))

describe('parseSessionFromHtml', () => {
  it('extracts the form action URL including the jsessionid path segment', () => {
    const s = parseSessionFromHtml(html)
    expect(s.actionUrl).toContain('/pjeconsulta/ConsultaPublica/listView.seam')
    expect(s.actionUrl).toContain(';jsessionid=')
    expect(s.actionUrl.startsWith('https://')).toBe(true)
  })

  it('extracts the submit param from executarPesquisa, not from the button', () => {
    // The Pesquisar button's own onclick is dead code: `return executarReCaptcha();`
    // short-circuits before its A4J.AJAX.Submit. Using it yields 0 results forever.
    const s = parseSessionFromHtml(html)
    expect(s.submitParam).toMatch(/^fPP:j_id\d+$/)
    expect(s.submitParam).not.toBe('fPP:searchProcessos')
  })

  it('throws a clear error when the page shape changes', () => {
    expect(() => parseSessionFromHtml('<html><body>nothing</body></html>'))
      .toThrow(/could not locate/i)
  })
})

describe('startSession', () => {
  // Found live: a JSESSIONID already sitting in the jar (e.g. planted by an
  // unrelated prior request on the same client, such as a summary PDF fetch)
  // makes the server stop URL-rewriting the session into the form's action —
  // the resulting actionUrl carries no `;jsessionid=` at all, and the search
  // that follows fails with ActionNotExecutedError. "Start a session" must
  // mean start a NEW one.
  it('clears a jar that already carries a cookie before fetching the session', async () => {
    let sentCookieHeader: string | null = null
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      sentCookieHeader = new Headers(init?.headers).get('cookie')
      return new Response(htmlBuffer, { status: 200 })
    }) as unknown as typeof fetch
    const client = new HttpClient({ fetchImpl, sleep: async () => {}, rps: 0 })
    client.jar.setFromHeaders(new Headers({ 'set-cookie': 'JSESSIONID=stale-from-a-prior-request' }))

    const session = await startSession(client)

    // The GET for the session page itself must not carry the stale cookie...
    expect(sentCookieHeader).toBeNull()
    // ...and the jar stays clean afterwards too (nothing in the fixture response re-sets it).
    expect(client.jar.header()).not.toContain('stale-from-a-prior-request')
    expect(session.actionUrl).toContain(';jsessionid=')
  })

  it('still works normally from a clean jar', async () => {
    const fetchImpl = (async () => new Response(htmlBuffer, { status: 200 })) as unknown as typeof fetch
    const client = new HttpClient({ fetchImpl, sleep: async () => {}, rps: 0 })

    const session = await startSession(client)

    expect(session.actionUrl).toContain(';jsessionid=')
    expect(session.submitParam).toMatch(/^fPP:j_id\d+$/)
  })
})
