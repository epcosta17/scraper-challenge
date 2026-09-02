import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'

/**
 * Renders a PDF into a page of our own, rather than handing it to the
 * browser's built-in viewer.
 *
 * The built-in one came with a dark control bar and an unfolded rail of
 * thumbnails in the middle of a light interface, and neither is themeable —
 * `#toolbar=0&navpanes=0` could hide them, but the grey it paints around the
 * page stayed, and Safari and Firefox drew something different again. Here
 * every pixel around the document is ours and looks the same everywhere.
 *
 * The reason worth more than the theme is the text layer. pdf.js positions the
 * real characters over the canvas, which makes the document selectable,
 * copyable — and searchable, so the term that led somebody here can be
 * highlighted in the page they land on. A `<embed>`ed PDF can do none of that.
 *
 * pdf.js parses and rasterises off the main thread; the worker has to be told
 * where it lives, and `?url` is how Vite hands us the built asset's path
 * rather than trying to inline a worker as a module.
 */
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export interface PdfViewer {
  /** Loads a document and draws it. Safe to call again for the next one. */
  open(url: string, highlight?: string): Promise<void>
  /** Stops rendering and releases the document. */
  close(): void
  zoomIn(): void
  zoomOut(): void
  /** Reports page count and where the reader currently is. */
  onPage(fn: (page: number, total: number) => void): void
}

/** Zoom steps, in scale factors. `1` is the PDF's own idea of 100%. */
const ZOOM = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3]

/**
 * How wide a page is drawn when the viewer opens.
 *
 * Fit-to-width rather than 100%: these are A4 court documents, and at 100% on
 * a wide screen they sit as a narrow column with the measure of a phone.
 */
const FIT_WIDTH_PADDING = 48

export function createPdfViewer(container: HTMLElement): PdfViewer {
  let doc: PDFDocumentProxy | null = null
  /** Kept because `destroy` lives on the loading task, not on the document. */
  let task: PDFDocumentLoadingTask | null = null
  let scale: number | null = null
  let term = ''
  let pageListener: ((page: number, total: number) => void) | null = null
  /** Bumped on every open and close, so a slow render for the previous
   *  document cannot paint over the one that replaced it. */
  let generation = 0

  const observer = new IntersectionObserver((entries) => {
    // The page most in view is the page you are on. Reported rather than
    // computed by the caller, which would need the scroll geometry to do it.
    let best: { page: number; ratio: number } | null = null
    for (const e of entries) {
      const page = Number((e.target as HTMLElement).dataset.page)
      if (!Number.isFinite(page)) continue
      if (best === null || e.intersectionRatio > best.ratio) {
        best = { page, ratio: e.intersectionRatio }
      }
    }
    if (best !== null && best.ratio > 0 && doc !== null) {
      pageListener?.(best.page, doc.numPages)
    }
  }, { root: container, threshold: [0, 0.25, 0.5, 0.75, 1] })

  async function draw(): Promise<void> {
    const mine = generation
    const document_ = doc
    if (document_ === null || scale === null) return
    container.replaceChildren()

    for (let n = 1; n <= document_.numPages; n++) {
      const page = await document_.getPage(n)
      if (mine !== generation) return

      const viewport = page.getViewport({ scale })
      const wrap = window.document.createElement('div')
      wrap.className = 'pdfv__page'
      wrap.dataset.page = String(n)
      wrap.style.width = `${Math.floor(viewport.width)}px`
      wrap.style.height = `${Math.floor(viewport.height)}px`

      const canvas = window.document.createElement('canvas')
      // Drawn at device resolution and scaled down by CSS: at 1x on a retina
      // screen the type comes out soft, which on a legal document reads as a
      // bad scan rather than as a rendering choice.
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`
      wrap.append(canvas)

      const text = window.document.createElement('div')
      text.className = 'pdfv__text'
      wrap.append(text)

      container.append(wrap)
      observer.observe(wrap)

      const context = canvas.getContext('2d')
      if (context === null) continue
      context.scale(dpr, dpr)
      await page.render({ canvas, canvasContext: context, viewport }).promise
      if (mine !== generation) return

      const layer = new pdfjs.TextLayer({
        textContentSource: await page.getTextContent(),
        container: text,
        viewport,
      })
      await layer.render()
      if (mine !== generation) return
      if (term !== '') highlight(text, term)
    }
  }

  return {
    async open(url, highlightTerm = '') {
      generation++
      term = highlightTerm.trim()
      task = pdfjs.getDocument({ url })
      doc = await task.promise
      // Fit to width on open, then hold that scale while the reader pages
      // through — re-fitting per page would make every page a different size.
      const first = await doc.getPage(1)
      const natural = first.getViewport({ scale: 1 }).width
      scale = Math.max(0.5, (container.clientWidth - FIT_WIDTH_PADDING) / natural)
      pageListener?.(1, doc.numPages)
      await draw()
    },

    close() {
      generation++
      observer.disconnect()
      container.replaceChildren()
      void task?.destroy()
      task = null
      doc = null
      scale = null
    },

    zoomIn() {
      if (scale === null) return
      scale = ZOOM.find((z) => z > scale!) ?? ZOOM[ZOOM.length - 1]!
      void draw()
    },

    zoomOut() {
      if (scale === null) return
      scale = [...ZOOM].reverse().find((z) => z < scale!) ?? ZOOM[0]!
      void draw()
    },

    onPage(fn) { pageListener = fn },
  }
}

/**
 * Marks the search term in a rendered page's text layer.
 *
 * Accent- and case-insensitive, to agree with the index that sent the reader
 * here: FTS5's `unicode61` tokenizer folds both, so a search for "execucao"
 * that matched "EXECUÇÃO" has to light up that word and not nothing.
 *
 * pdf.js emits one span per run of text, and a term can fall across two of
 * them; this marks whole spans that contain it rather than splitting them,
 * which keeps the character positions pdf.js computed intact. A highlight one
 * span wide is a fair answer — it points at the line.
 */
function highlight(layer: HTMLElement, term: string): void {
  const fold = (s: string): string =>
    s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

  const needle = fold(term)
  if (needle === '') return

  for (const span of layer.querySelectorAll<HTMLElement>('span')) {
    if (fold(span.textContent ?? '').includes(needle)) span.classList.add('is-hit')
  }
}
