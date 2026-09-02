import { describe, expect, it } from 'vitest'
import { actPage } from '../src/data/sqlite/act-page.ts'

describe('the page a judicial act is read in', () => {
  it('escapes what came off the court server rather than trusting it', () => {
    const page = actPage('Sentença', '0005204-98.2002.4.05.8400', 'a < b & <script>alert(1)</script>')
    expect(page).not.toContain('<script>alert(1)</script>')
    expect(page).toContain('&lt;script&gt;')
    expect(page).toContain('a &lt; b &amp;')
  })

  it('escapes the label and case number too, not only the body', () => {
    const page = actPage('<b>Decisão</b>', '<x>', 'texto')
    expect(page).toContain('&lt;b&gt;Decisão&lt;/b&gt;')
    expect(page).toContain('&lt;x&gt;')
  })

  it('breaks the act into paragraphs where blank lines already do', () => {
    const page = actPage('Sentença', 'N', 'Primeiro.\n\nSegundo.\n\nTerceiro.')
    // Three, not four: the case number's own <p> carries a class and is not
    // one of the act's paragraphs.
    expect(page.match(/<p>/g)).toHaveLength(3)
  })

  it('falls back to the numbered clauses these documents are written in', () => {
    // The extractor joins the act's blocks with no separator, so the text
    // arrives as one line. Rendering that as a single paragraph is the wall
    // of text this page exists to stop being.
    const run = 'SENTENÇA01. Cuida-se de execução fiscal.02. Após medidas.03. É o relatório.'
    const page = actPage('Sentença', 'N', run)
    expect(page.match(/<p>/g)!.length).toBeGreaterThan(2)
    expect(page).toContain('02. Após medidas.')
  })

  it('never leaves the body empty for text it could not split', () => {
    const page = actPage('Despacho', 'N', 'Uma frase sola sin cláusulas.')
    expect(page).toContain('Uma frase sola sin cláusulas.')
  })
})

describe('what the portal leaves at the foot of an act', () => {
  const SIGNED = [
    'Pelo exposto, julgo extinta a execução.',
    '',
    'Assinado eletronicamente por:',
    'MANOEL DE OLIVEIRA ERHARDT08/09/2025 16:12:15',
    '',
    'https://pjett.trf5.jus.br/pjeconsulta/Processo/ConsultaDocumento/listView.seam',
    'ID do documento:',
    '2779136',
    '',
    'Imprimir',
    '',
    'Gerar PDF',
  ].join('\n')

  it('drops the buttons the extractor swept up with the text', () => {
    // They are text on the portal's page, so the extractor keeps them. Left
    // in, a judgment ends with two buttons nobody can press.
    const page = actPage('Sentença', 'N', SIGNED)
    expect(page).not.toContain('Gerar PDF')
    expect(page).not.toContain('>Imprimir<')
    expect(page).toContain('Pelo exposto')
  })

  it('keeps the signature and the document id, which are part of the record', () => {
    const page = actPage('Sentença', 'N', SIGNED)
    expect(page).toContain('Assinado eletronicamente por:')
    expect(page).toContain('2779136')
  })

  it('leaves an act that merely talks about printing alone', () => {
    const page = actPage('Despacho', 'N', 'Determino imprimir os autos e juntar.')
    expect(page).toContain('Determino imprimir os autos e juntar.')
  })
})
