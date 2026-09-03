import type { APIRoute } from 'astro'
import { data } from '../data/index.ts'

/**
 * Which of the things an answer cited actually exist.
 *
 * This is what stands between a model's habit of inventing case numbers and a
 * page full of links that look verified. The browser sends every number and
 * document id the answer mentioned; this returns the subset the acervo really
 * holds, and only those become links.
 *
 * Asked after the answer is whole rather than per chunk: a case number
 * arriving a character at a time is not a case number yet.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: { cases?: unknown; documents?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ cases: [], documents: [] })
  }

  const asked = Array.isArray(body.cases) ? body.cases.filter((c): c is string => typeof c === 'string') : []
  const docs = Array.isArray(body.documents)
    ? body.documents.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : []

  // Bounded: an answer citing a thousand numbers is not an answer, and this
  // should not become a way to probe the database one request at a time.
  const held = await data.casesByNumber(asked.slice(0, 60))

  // Each known document comes back with the case it sits in, because that is
  // what the link needs: the viewer lives in the case file, and the raw file
  // behind /documentos/:id is a download rather than something to read.
  const documents = await data.documentCases(docs.slice(0, 60))

  return json({
    cases: [...held.keys()],
    documents: [...documents].map(([id, expediente]) => ({ id, expediente })),
  })
}

const json = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
