import type { APIRoute } from 'astro'
import { data, portal, runner } from '../data/index.ts'
import { runAgent, type AgentEvent } from '../agent/loop.ts'

/**
 * Where a question is asked and the answer streams back.
 *
 * Server-sent events, one JSON object per line, because the interesting part
 * of an agent's turn is the middle: the reasoning summaries and the tool calls
 * arrive as they happen, and the answer arrives a word at a time. A single
 * JSON response would leave the screen silent for the ten or twenty seconds a
 * question that reaches the portal actually takes.
 *
 * The API key arrives in the request body and is used for this call only. It
 * is never written to SQLite, never logged, and never leaves this process
 * except to Gemini — the browser holds it in `localStorage` and hands it over
 * per question. That is the whole of its life here.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: {
    apiKey?: unknown
    model?: unknown
    thinkingBudget?: unknown
    question?: unknown
    history?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return bad('El cuerpo de la petición no es JSON.')
  }

  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  const question = typeof body.question === 'string' ? body.question.trim() : ''
  if (apiKey === '') return bad('Falta la clave de Gemini. Ponla en el engranaje.')
  if (question === '') return bad('No hay pregunta.')

  const history = Array.isArray(body.history)
    ? body.history
        .filter((h): h is { role: string; text: string } =>
          typeof h === 'object' && h !== null && 'role' in h && 'text' in h)
        .map((h) => ({
          role: h.role === 'model' ? ('model' as const) : ('user' as const),
          text: String(h.text),
        }))
        // Bounded: a long thread would otherwise be re-sent whole on every
        // question, growing the bill and eventually the latency with it.
        .slice(-12)
    : []

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      const send = (event: AgentEvent): void => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      }

      try {
        for await (const event of runAgent({
          apiKey,
          model: typeof body.model === 'string' && body.model !== '' ? body.model : 'gemini-2.5-flash',
          // -1 lets the model decide how long to think; 0 turns it off. The
          // gear writes this, so the reader controls what they pay for.
          thinkingBudget: Number.isFinite(Number(body.thinkingBudget)) ? Number(body.thinkingBudget) : -1,
          deps: { data, portal, runner },
          history,
          question,
          signal: request.signal,
        })) {
          send(event)
        }
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        send({ type: 'done' })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      // Nothing between here and the browser should hold this back waiting for
      // a full body; the whole point is that it arrives in pieces.
      'x-accel-buffering': 'no',
    },
  })
}

const bad = (message: string): Response =>
  new Response(JSON.stringify({ type: 'error', message }), {
    status: 400,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
