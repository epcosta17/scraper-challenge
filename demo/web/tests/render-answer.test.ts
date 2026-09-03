import { describe, expect, it } from 'vitest'
import { renderAnswer, referencedIn, type RenderContext } from '../src/agent/render.ts'

const REAL = '0009986-11.2026.4.05.8400'
const INVENTED = '1234567-89.2099.4.05.9999'

const ctx: RenderContext = {
  cases: new Set([REAL]),
  documents: new Map([[12102104, REAL]]),
}

describe('who gets to make a link', () => {
  /**
   * The rule this file exists for. A language model invents case numbers —
   * that is what they do — and one it invented, rendered as a link, is
   * indistinguishable from a real one until it is clicked. Wrong is
   * survivable; wrong and dressed as verified is not.
   */
  it('links a case number the acervo actually holds', () => {
    const html = renderAnswer(`Ver ${REAL}.`, ctx)
    expect(html).toContain(`href="/expedientes/${REAL}"`)
  })

  it('shows an invented case number without linking it', () => {
    const html = renderAnswer(`Ver ${INVENTED}.`, ctx)
    expect(html).not.toContain('href=')
    // Shown, not swallowed: the reader should see what was claimed.
    expect(html).toContain(INVENTED)
    expect(html).toContain('No está en el acervo')
  })

  it('never renders a link the model wrote itself', () => {
    const html = renderAnswer('Mira [aquí](https://evil.example/x) y http://otro.example', ctx)
    expect(html).not.toContain('<a')
    expect(html).not.toContain('href')
  })

  it('links a document id we hold, and leaves an unknown one plain', () => {
    // The link goes to the document inside its case file, where the viewer is
    // — not to the raw file, which is a download and not something to read.
    expect(renderAnswer('en el documento 12102104', ctx))
      .toContain(`href="/expedientes/${REAL}?documento=12102104"`)
    expect(renderAnswer('en el documento 99999999', ctx)).not.toContain('href=')
  })
})

describe('what the model is allowed to write', () => {
  it('escapes markup rather than rendering it', () => {
    const html = renderAnswer('<script>alert(1)</script>', ctx)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('renders a table, which is what a count looks like', () => {
    const html = renderAnswer(
      ['| Clase | Expedientes |', '| --- | --- |', '| APELAÇÃO CÍVEL | 58 |'].join('\n'),
      ctx,
    )
    expect(html).toContain('<table')
    expect(html).toContain('<th>Clase</th>')
    expect(html).toContain('<td>58</td>')
  })

  it('renders lists, quotes and emphasis', () => {
    expect(renderAnswer('- uno\n- dos', ctx)).toContain('<li>uno</li>')
    expect(renderAnswer('> texto citado', ctx)).toContain('<blockquote')
    expect(renderAnswer('esto es **importante**', ctx)).toContain('<strong>importante</strong>')
  })

  it('links a case number inside code instead of leaving it as code', () => {
    // This asserted the opposite until the backtick bug was found. Leaving a
    // backticked number alone sounded careful — "do not link it twice" — but
    // the system prompt asked the model for backticks around every case number
    // and id, so in practice nothing in an answer ever became a link. The rule
    // that matters is the other one: a number links when the acervo has it.
    const html = renderAnswer(`el número \`${REAL}\``, ctx)
    expect(html).toContain(`href="/expedientes/${REAL}"`)
    expect(html.match(/<a /g) ?? []).toHaveLength(1)
  })

  it('has no headings, because the thread supplies its own structure', () => {
    expect(renderAnswer('# Título', ctx)).not.toContain('<h1')
  })
})

describe('finding what an answer refers to', () => {
  it('collects the numbers and ids the caller has to verify', () => {
    const found = referencedIn(`Ver ${REAL} y ${INVENTED}, documento 12102104.`)
    expect(found.cases).toEqual([REAL, INVENTED])
    expect(found.documents).toEqual([12102104])
  })

  it('reports each one once, however often it is mentioned', () => {
    expect(referencedIn(`${REAL} y otra vez ${REAL}`).cases).toEqual([REAL])
  })
})

describe('identifiers the model wrapped in backticks', () => {
  const ctx = {
    cases: new Set(['0005425-26.2026.4.05.8308']),
    documents: new Map([[12101537, '0005425-26.2026.4.05.8308'], [546, REAL]]),
  }

  /**
   * The bug that survived three separate fixes to the patterns.
   *
   * `inline` lifts code spans out before the linkers run, so an identifier in
   * backticks was invisible to them — and the system prompt was asking the
   * model for backticks around exactly these. Nothing ever linked.
   */
  it('links a case number written inside backticks', () => {
    const html = renderAnswer('del expediente `0005425-26.2026.4.05.8308`.', ctx)
    expect(html).toContain('href="/expedientes/0005425-26.2026.4.05.8308"')
    expect(html).not.toContain('<code')
  })

  it('links a document id written inside backticks', () => {
    const html = renderAnswer('con id `12101537`, de mayo.', ctx)
    expect(html).toContain('href="/expedientes/0005425-26.2026.4.05.8308?documento=12101537"')
  })

  it('reports the same references the renderer links', () => {
    // These two must never disagree: one decides what gets verified, the other
    // what gets linked, and a mismatch shows as a link that was never checked.
    const md = 'expediente `0005425-26.2026.4.05.8308`, id `12101537`.'
    expect(referencedIn(md)).toEqual({
      cases: ['0005425-26.2026.4.05.8308'],
      documents: [12101537],
    })
  })

  it('still renders real code spans as code', () => {
    const html = renderAnswer('El campo `ca` cambia en cada petición.', ctx)
    expect(html).toContain('<code class="mono">ca</code>')
  })

  it('accepts the shapes the model actually writes for an id', () => {
    for (const text of ['Id: 546', 'documento 546', 'doc. 546', 'con id 546,']) {
      expect(referencedIn(text).documents, text).toEqual([546])
    }
  })

  it('does not invent a document out of a bare number', () => {
    expect(referencedIn('en 2024 hubo 15 casos').documents).toEqual([])
  })
})

describe('lines that open no block', () => {
  const ctx = { cases: new Set<string>(), documents: new Map<number, string>() }

  /**
   * The freeze. The block branches want a space after the marker (`- `, `1. `)
   * and a table wants its separator; the paragraph guard rejected the marker
   * on its own. A line both refused — `**Bold**` at the start of a line, which
   * a model writes constantly — advanced nothing, and the loop spun forever
   * with the browser tab locked up.
   *
   * Each of these asserts termination as much as output: if the parser regresses
   * these do not fail, they hang.
   */
  it.each([
    ['bold opening a line', '**Aquí tienes un documento**', '<strong>'],
    ['a dash with no space', '-sin espacio', '<p>-sin espacio</p>'],
    ['italics opening a line', '*cursiva* al inicio', '<em>cursiva</em>'],
    ['a pipe that is not a table', '| esto no es tabla', '<p>| esto no es tabla</p>'],
    ['a number with no space', '1.sin espacio', '<p>1.sin espacio</p>'],
  ])('renders %s instead of hanging', (_name, markdown, expected) => {
    expect(renderAnswer(markdown, ctx)).toContain(expected)
  })

  it('still reads a real table, list and quote', () => {
    expect(renderAnswer('| a | b |\n| - | - |\n| 1 | 2 |', ctx)).toContain('<table')
    expect(renderAnswer('- uno\n- dos', ctx)).toContain('<li>uno</li>')
    expect(renderAnswer('> citado', ctx)).toContain('<blockquote')
  })

  it('consumes every line of a mixed answer exactly once', () => {
    const html = renderAnswer('**Título**\n- uno\n| suelto\ntexto final', ctx)
    expect(html).toContain('<strong>Título</strong>')
    expect(html).toContain('<li>uno</li>')
    expect(html).toContain('| suelto')
    expect(html).toContain('texto final')
  })
})

describe('labels in bold', () => {
  const CASE = '0004831-11.1999.4.05.8000'
  const ctx = { cases: new Set([CASE]), documents: new Map([[698889, CASE]]) }

  /**
   * `**ID del documento:** 698889` is how the model labels things nearly every
   * time, and it linked nothing: by the time the document pattern ran, the
   * bold had already become `<strong>`, so a tag sat between the keyword and
   * its number.
   */
  it('links a document behind a bold label', () => {
    expect(renderAnswer('**ID del documento:** 698889', ctx))
      .toContain(`href="/expedientes/${CASE}?documento=698889"`)
    expect(referencedIn('**ID del documento:** 698889').documents).toEqual([698889])
  })

  it('wraps the number only, leaving the tags well formed', () => {
    const html = renderAnswer('**ID del documento:** 698889', ctx)
    // Wrapping the whole match crossed the tags: `<strong>… <a>…</strong>…</a>`.
    expect(html).toContain('<strong>ID del documento:</strong>')
    expect(html).toContain('>698889</a>')
  })

  it('opens citations in a new tab, so the thread survives the click', () => {
    for (const html of [renderAnswer(`el ${CASE}`, ctx), renderAnswer('documento 698889', ctx)]) {
      expect(html).toContain('target="_blank"')
      expect(html).toContain('rel="noopener"')
    }
  })
})

describe('the way an id actually gets written', () => {
  const CASE = '0004831-11.1999.4.05.8000'
  const ctx = { cases: new Set([CASE]), documents: new Map([[45020, CASE], [33, CASE]]) }

  /**
   * Asked for "the link", the agent answered `45020` and nothing linked — the
   * prompt told it the number was the link, and the renderer only ever
   * recognised a number with its keyword in front. Natural phrasing failed
   * too: "el documento es el 45020" puts two words in between.
   */
  it.each([
    'El documento es el 45020.',
    'documento nº 45020',
    'el doc es 45020',
    '**ID del documento:** 45020',
    'documento 45020',
  ])('links %s', (markdown) => {
    expect(referencedIn(markdown).documents).toEqual([45020])
    expect(renderAnswer(markdown, ctx)).toContain(`documento=45020`)
  })

  it.each([
    '45020',
    'en 2024 hubo 15 casos',
    'Corto — 1.024 tokens',
    'el expediente es el 45020',
  ])('leaves %s alone', (markdown) => {
    // A bare number stays a number. Linking one because the acervo happens to
    // hold a document with that id would dress an accident as a checked fact.
    expect(referencedIn(markdown).documents).toEqual([])
  })
})
