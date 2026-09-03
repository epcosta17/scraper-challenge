import type { APIRoute } from 'astro'
import { chat } from '../data/index.ts'

/**
 * The conversation list, and everything that changes it.
 *
 * GET returns the list, or one whole conversation with `?id=`. POST carries an
 * `accion`, because four small routes for create/append/rename/delete would be
 * four files saying the same thing.
 *
 * Nothing here ever sees the Gemini key: it goes to `/agente.json` with the
 * question and stops there. What is stored is what was said and what was
 * looked up to say it.
 */
export const GET: APIRoute = ({ url }) => {
  const raw = url.searchParams.get('id')
  if (raw === null) return json({ conversaciones: chat.list(100) })

  const id = Number(raw)
  if (!Number.isInteger(id)) return json({ error: 'Id inválido.' }, 400)
  const found = chat.read(id)
  if (found === null) return json({ error: 'No existe esa conversación.' }, 404)
  return json(found)
}

export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return json({ error: 'El cuerpo de la petición no es JSON.' }, 400)
  }

  const accion = String(body.accion ?? '')
  const id = Number(body.id)

  switch (accion) {
    case 'crear': {
      return json({ conversacion: chat.create(String(body.titulo ?? '')) })
    }

    case 'anadir': {
      if (!Number.isInteger(id)) return json({ error: 'Id inválido.' }, 400)
      const role = body.rol === 'model' ? 'model' : 'user'
      const text = String(body.texto ?? '')
      // A turn is never stored empty: a blank row would show in the thread as a
      // message nobody sent.
      if (text.trim() === '') return json({ error: 'El turno está vacío.' }, 400)
      const trace = Array.isArray(body.trazo) ? body.trazo : []
      const turn = chat.append(id, role, text, trace)
      if (turn === null) return json({ error: 'No existe esa conversación.' }, 404)
      return json({ turno: turn })
    }

    case 'renombrar': {
      if (!Number.isInteger(id)) return json({ error: 'Id inválido.' }, 400)
      return chat.rename(id, String(body.titulo ?? ''))
        ? json({ ok: true })
        : json({ error: 'No existe esa conversación.' }, 404)
    }

    case 'borrar': {
      if (!Number.isInteger(id)) return json({ error: 'Id inválido.' }, 400)
      return chat.remove(id) ? json({ ok: true }) : json({ error: 'No existe esa conversación.' }, 404)
    }

    default:
      return json({ error: `Acción desconocida: ${accion}` }, 400)
  }
}

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
