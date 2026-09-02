import type { APIRoute } from 'astro'
import { data } from '../../data/index.ts'

/**
 * The bytes behind the eye and the download arrow on a case file.
 *
 * The stored PDFs live in the scraper's blob store, and this route never
 * touches the filesystem itself: it asks the data source, which asks
 * `FsBlobStore`, whose key check is what makes a stored key incapable of
 * addressing a file outside the PDF directory. The `id` in the URL is only
 * ever a row lookup — it never becomes part of a path.
 *
 * `?descargar` switches the disposition from inline to attachment. Both carry
 * the same descriptive filename, so a document saved from the preview lands in
 * the downloads folder under the case, the act and its date rather than as
 * `12101987`.
 */
export const GET: APIRoute = async ({ params, url }) => {
  const id = Number(params.id)
  if (!Number.isInteger(id)) return notFound()

  const file = await data.openDocument(id)
  if (file === null) return notFound()

  const disposition = url.searchParams.has('descargar') ? 'attachment' : 'inline'
  const body = typeof file.body === 'string' ? file.body : new Uint8Array(file.body)

  return new Response(body, {
    headers: {
      'content-type': file.contentType,
      // Both forms: `filename*` carries the accents (Sentença, Decisão) for
      // every browser that reads RFC 5987, and the ASCII `filename` is what
      // the rest fall back to rather than inventing a name of their own.
      'content-disposition':
        `${disposition}; filename="${asciiFilename(file.filename)}"; ` +
        `filename*=UTF-8''${encodeRFC5987(file.filename)}`,
      // The acervo is a capture: a document's bytes do not change under a
      // given id, but a re-run can replace them, so this is a short cache
      // rather than an immutable one.
      'cache-control': 'private, max-age=300',
    },
  })
}

const notFound = (): Response =>
  new Response('No hay ningún documento con ese identificador en el acervo.', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })

/** Accents folded, quotes and control characters gone — safe inside a quoted header. */
const asciiFilename = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replaceAll('"', "'")

const encodeRFC5987 = (name: string): string =>
  encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
