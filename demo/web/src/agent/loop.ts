import { GoogleGenAI, type Content } from '@google/genai'
import { TOOL_DECLARATIONS, type ToolDeps } from './tools.ts'
import { runTool } from './run-tool.ts'

/**
 * The agent: ask Gemini, run whatever tools it asks for, ask again, until it
 * answers in prose.
 *
 * Emitted as a stream of events rather than returned at the end, because the
 * interesting part is the middle. A question that reaches the portal takes ten
 * seconds or more, and a screen that shows nothing until it is over cannot be
 * told apart from one that has hung — the same reason the queue rows carry a
 * `stage`.
 *
 * Three kinds of event go out, in the order they happen: the model's own
 * reasoning summaries, the tool calls with what each returned, and the answer
 * itself. The first two are what fills the collapsible trace.
 *
 * On the reasoning: what Gemini returns with `includeThoughts` is a *summary*
 * the API produces, not the raw chain. Labelled accordingly in the interface —
 * calling it "the model's thinking" would be selling something it is not.
 */

export type AgentEvent =
  | { type: 'thought'; text: string }
  | { type: 'tool'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; summary: string; ms: number; error: string | null }
  | { type: 'answer'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface AgentOptions {
  apiKey: string
  model: string
  /** 0 turns thinking off; -1 lets the model decide. The gear sets this. */
  thinkingBudget: number
  deps: ToolDeps
  /** Prior turns, oldest first. */
  history: Array<{ role: 'user' | 'model'; text: string }>
  question: string
  signal?: AbortSignal
}

/**
 * How many rounds of tool calls the model gets before it has to answer.
 *
 * Wide enough for a chained instruction. "Busca los tres más recientes, lee el
 * último documento de cada uno y compáralos" costs a round to list, one per
 * case, one per document and one to answer — eight, which is exactly where the
 * old ceiling was, so the chain died instead of finishing.
 */
const MAX_ROUNDS = 14

/**
 * How many calls may leave the building, across the whole turn.
 *
 * This, not the round count, is what protects the court: the rounds are cheap
 * and local, and capping them was capping the wrong thing. `buscar_en_el_portal`
 * and `encolar_captura` are the two that make real requests to the TRF5, and
 * six of them is already a generous answer to one question.
 */
const MAX_OUTWARD_CALLS = 6

/** The tools that reach the TRF5 rather than our own database. */
const OUTWARD = new Set(['buscar_en_el_portal', 'encolar_captura'])

/**
 * Today, as the portal writes it.
 *
 * Without this the model has no clock, so "ayer" and "esta semana" are
 * unanswerable — it would either refuse or, worse, guess a date from its
 * training data and search the wrong week. Computed per turn rather than at
 * module load, or a long-running server would still think it is the day it
 * booted.
 */
const today = (): string =>
  new Intl.DateTimeFormat('es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Recife',
  }).format(new Date())

const SYSTEM = `Eres el asistente de un acervo del Tribunal Regional Federal da 5ª Região (Brasil),
capturado por un scraper propio. Respondes en español; los datos del tribunal
(clases, nombres de partes, roles, textos de sentencias) van en portugués, tal
como llegan, sin traducir.

Cómo trabajas:

- No sabes nada del acervo hasta que lo consultas. Cada afirmación sobre un
  expediente, una parte, un movimiento o un documento tiene que venir de una
  herramienta que acabas de llamar en este turno. Si no la has llamado, no lo
  sabes.
- Elige la herramienta por la forma de la pregunta: buscar_en_el_acervo si hay
  algo que buscar, listar_expedientes o listar_documentos si piden "los
  últimos", "unos cuantos" o "al azar" sin término, contar si preguntan
  "cuántos" —una cifra contada vale más que una estimada a ojo sobre unos
  cuantos resultados.
- Una petición vaga se cumple, no se devuelve. "Muéstrame tres documentos",
  "algo de lo que tengas", "lo que sea": elige tú, enséñalo y di qué criterio
  usaste. Pedir que la concreten es la última salida, no la primera.
- Hay DOS identificadores y no son intercambiables. El número CNJ
  (0009986-11.2026.4.05.8400) es el del tribunal. El id interno es un número
  suelto: 7, 375, 130100. "el caso 7", "id 7", "el 375" se refieren al id
  interno, y con eso basta para capturar: encolar_captura tipo "expediente",
  objetivo "7". NO pidas el CNJ cuando te den un id interno; solo
  buscar_en_el_portal lo necesita, porque el formulario público no busca por id.
- Para traer algo que no está: con cualquiera de los dos identificadores,
  encolar_captura con "expediente" —eso ya es ir al portal y descargarlo—. Si
  no tienen ninguno, no te quedes pidiéndoselo: "explorar" recorre el tribunal
  buscando desconocidos, y buscar_en_el_portal los encuentra por fecha, parte o
  clase. Di qué opción propones y por qué.
- Si te piden varias cosas en un mensaje, hazlas todas y en el orden pedido,
  encadenando herramientas: el resultado de una alimenta a la siguiente. No
  respondas solo a la primera ni pidas permiso entre pasos. Si una falla, sigue
  con las demás y di al final cuál no pudiste.
- Nunca digas que puedes hacer algo y luego te niegues a hacerlo.
- No eres un asistente general. De lo que no sea este acervo, el TRF5 o cómo
  usar esta herramienta —cultura general, matemáticas, código, opiniones— no
  contestas: dilo en una frase y ofrece lo que sí sabes hacer. No es pudor, es
  que una respuesta acertada sobre el sol invita a creerte la siguiente sobre
  una sentencia, y esa no la has comprobado. Si en una
  respuesta afirmas que sabes buscar expedientes y abrir sus documentos, la
  siguiente vez que te lo pidan, hazlo.
- El acervo NO se puede filtrar por fecha; el portal SÍ. Para "los de ayer",
  "los de esta semana" o cualquier pregunta por fechas, la herramienta es
  buscar_en_el_portal con desde/hasta. Lo que encuentre y no tengamos queda
  encolado solo: dilo, con cuántos son. Si solo estás comprobando si algo
  existe, pasa capturar=false.
- Cuando algo no esté en el acervo, dilo y distingue: "no lo hemos capturado"
  no es "no existe". Si tiene sentido, comprueba con buscar_en_el_portal si el
  tribunal lo tiene, y ofrece traerlo con encolar_captura.
- Una captura recién encolada NO está capturada. Di que va en camino, con el
  id del trabajo, para que puedan preguntarte por él.
- Cuando pregunten "¿ya está?", NO respondas de memoria ni por el tiempo que
  haya pasado: llama a estado_de_la_cola y responde con lo que diga —el estado,
  el paso y el avance—. Si el trabajo ya terminó, compruébalo además con
  leer_expediente, que acepta el id interno además del número CNJ.
- Si lo que quieren es el resultado y no un "va en camino" —refrescar un
  expediente, traer sus documentos—, encola y llama a esperar_trabajo en el
  mismo turno. Cuenta después qué trajo: cuántos movimientos o documentos
  nuevos. Si la espera se agota, di por dónde va; agotarse no es fallar.
- No prometas avisar. No puedes: solo hablas cuando te preguntan. Di que
  vuelvan a preguntar, o que lo miren en la tarjeta de la esquina.
- Cita lo que afirmes: escribe el número CNJ del expediente y, cuando cites un
  documento, su id. La aplicación los convierte en enlaces si existen de
  verdad, así que escríbelos exactos y no los inventes nunca.
- Si una herramienta dice que recortó algo (una lista, un texto, los 30 del
  portal), dilo también. Nunca presentes una lista recortada como completa.

Cómo escribes:

- Prosa breve y directa, en párrafos. Nada de preámbulos ni de repetir la
  pregunta.
- Markdown sencillo: párrafos, listas, **negrita**. Tablas cuando compares o
  cuentes: son para cifras.
- Los números de expediente y los ids de documento van SIN comillas invertidas,
  tal cual en el texto: la aplicación los convierte en enlaces y les pone ella
  la tipografía. Entre comillas invertidas dejan de ser enlazables.
- Citas en bloque (>) para el texto literal de un documento.
- Nada de encabezados, imágenes, ni enlaces escritos por ti. NUNCA escribas
  una URL, ni del portal ni de esta aplicación: no las conoces y las acabarías
  inventando. Los enlaces los pone la aplicación sola a partir de los números
  de expediente e ids que escribas.
- Escribe SIEMPRE el id de un documento con su palabra delante —"documento
  45020", nunca "45020" a secas—. Es lo que la aplicación reconoce para
  enlazarlo; un número suelto se queda en número suelto.
- Si te piden "el enlace" o "dame el link", responde con esa forma y nada más:
  "documento 45020". Eso ES el enlace. No digas que no puedes, no expliques
  cómo funciona la interfaz, y no les pidas que copien nada.
- Si no lo sabes, dilo en una frase. No rellenes.`

/**
 * The date, appended per turn.
 *
 * In Recife's time zone, not the server's: the dates the reader means are the
 * court's, and a server in Santiago is four hours behind — enough to make
 * "hoy" the wrong day for a stretch of every evening.
 */
const systemFor = (): string =>
  `${SYSTEM}\n\nHoy es ${today()} (huso del TRF5, Recife). Las fechas del portal van en\ndd/mm/aaaa. Calcula tú "ayer", "esta semana" o "el mes pasado" a partir de esa\nfecha y di qué rango has usado.`

export async function* runAgent(opts: AgentOptions): AsyncGenerator<AgentEvent> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey })

  const contents: Content[] = [
    ...opts.history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: 'user' as const, parts: [{ text: opts.question }] },
  ]

  let outwardCalls = 0
  let toolCalls = 0

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (opts.signal?.aborted) return

      const stream = await ai.models.generateContentStream({
        model: opts.model,
        contents,
        config: {
          systemInstruction: systemFor(),
          tools: [{ functionDeclarations: TOOL_DECLARATIONS as never }],
          thinkingConfig: {
            includeThoughts: opts.thinkingBudget !== 0,
            thinkingBudget: opts.thinkingBudget,
          },
        },
      })

      // Collected across the stream so the whole model turn can be appended to
      // `contents` — a tool call it made has to be in the history when its
      // result is sent back, or the next round has no idea what it answered.
      const modelParts: Array<Record<string, unknown>> = []
      const calls: Array<{ name: string; args: Record<string, unknown> }> = []
      let answered = false

      for await (const chunk of stream) {
        if (opts.signal?.aborted) return
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (part.thought === true && part.text) {
            modelParts.push({ text: part.text, thought: true })
            yield { type: 'thought', text: part.text }
          } else if (part.functionCall?.name) {
            const args = (part.functionCall.args ?? {}) as Record<string, unknown>
            modelParts.push({ functionCall: part.functionCall })
            calls.push({ name: part.functionCall.name, args })
            yield { type: 'tool', name: part.functionCall.name, args }
          } else if (part.text) {
            modelParts.push({ text: part.text })
            answered = true
            yield { type: 'answer', text: part.text }
          }
        }
      }

      if (calls.length === 0) {
        // No tools asked for: the turn was the answer.
        if (!answered) yield { type: 'error', message: 'El modelo no devolvió respuesta.' }
        yield { type: 'done' }
        return
      }

      contents.push({ role: 'model', parts: modelParts as never })

      // Run them in order rather than in parallel. Two of these six reach the
      // portal or the queue, and the model regularly chains them — search,
      // then capture what the search found. Order is part of the answer.
      const responses: Array<Record<string, unknown>> = []
      for (const call of calls) {
        const startedAt = Date.now()
        if (OUTWARD.has(call.name) && outwardCalls >= MAX_OUTWARD_CALLS) {
          // Handed back as a tool error rather than ending the turn: the model
          // can still answer from what it already has, which beats losing the
          // work done so far over one request too many.
          const message = `Límite de ${MAX_OUTWARD_CALLS} consultas al tribunal alcanzado en esta pregunta. `
            + 'Responde con lo que ya tengas y dilo.'
          yield { type: 'tool_result', name: call.name, summary: 'límite alcanzado', ms: 0, error: message }
          responses.push({ functionResponse: { name: call.name, response: { error: message } } })
          continue
        }
        if (OUTWARD.has(call.name)) outwardCalls++
        toolCalls++
        try {
          const result = await runTool(opts.deps, call.name, call.args)
          yield {
            type: 'tool_result',
            name: call.name,
            summary: result.summary,
            ms: Date.now() - startedAt,
            error: null,
          }
          responses.push({ functionResponse: { name: call.name, response: { result: result.payload } } })
        } catch (err) {
          // Handed back to the model rather than thrown: a tool that failed is
          // something it can work around or report, and a stack trace ending
          // the turn tells the reader nothing.
          const message = err instanceof Error ? err.message : String(err)
          yield { type: 'tool_result', name: call.name, summary: message, ms: Date.now() - startedAt, error: message }
          responses.push({ functionResponse: { name: call.name, response: { error: message } } })
        }
      }

      contents.push({ role: 'user', parts: responses as never })
    }

    yield {
      type: 'error',
      // Says what it managed, not just that it stopped: a chain that ran
      // eleven useful steps and then hit the wall is a different problem from
      // one that looped on the same search.
      message: `Me he quedado sin pasos: ${MAX_ROUNDS} rondas y ${toolCalls} llamadas `
        + 'sin llegar a una respuesta. Prueba a partir la petición en dos.',
    }
    yield { type: 'done' }
  } catch (err) {
    yield { type: 'error', message: describe(err) }
    yield { type: 'done' }
  }
}

/**
 * Turns an SDK error into something a person can act on.
 *
 * A bad key and a spent quota are the two that actually happen, and "400 Bad
 * Request" tells the reader which of them it is not.
 */
function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/API[_ ]?key|API_KEY_INVALID|401|403/i.test(message)) {
    return 'La clave de Gemini no es válida o no tiene permiso. Revísala en el engranaje.'
  }
  if (/quota|RESOURCE_EXHAUSTED|429/i.test(message)) {
    return 'La cuenta de Gemini se ha quedado sin cuota, o va demasiado rápido. Espera un momento.'
  }
  if (/fetch failed|ENOTFOUND|ETIMEDOUT|network/i.test(message)) {
    return 'No se pudo alcanzar la API de Gemini. Comprueba la conexión.'
  }
  return message
}
