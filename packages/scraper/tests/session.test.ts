import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseSessionFromHtml } from '../src/pje/session.ts'

const html = readFileSync(fileURLToPath(new URL('./fixtures/list-view.html', import.meta.url)), 'latin1')

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
