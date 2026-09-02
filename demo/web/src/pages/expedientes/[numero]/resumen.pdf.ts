import type { APIRoute } from 'astro'
import { data } from '../../../data/index.ts'

/**
 * The portal's own summary PDF for a whole case — the first thing every
 * capture downloads, and the one file that holds the case's procedural log
 * end to end. It is what the header's download control on a case file offers,
 * and it comes out of the same blob store, through the same key check, as the
 * individual documents.
 */
export const GET: APIRoute = async ({ params }) => {
  const numero = params.numero
  const file = numero === undefined ? null : await data.openCaseSummary(numero)
  if (file === null) {
    return new Response('Ese expediente no tiene un PDF de resumen guardado.', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  return new Response(new Uint8Array(file.body as Uint8Array), {
    headers: {
      'content-type': file.contentType,
      'content-disposition': `inline; filename="${file.filename}"`,
      'cache-control': 'private, max-age=300',
    },
  })
}
