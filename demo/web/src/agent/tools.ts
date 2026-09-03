import type { WebDataSource } from '../data/source.ts'
import type { PortalSearch } from '../data/portal.ts'
import type { Runner } from '../data/runner.ts'

/**
 * What the agent can do, and nothing else.
 *
 * These ten are the whole of its reach. It has no database handle, no HTTP
 * client and no way to phrase its own query — every answer it gives has to
 * come back through one of these, which is what makes "cite what you claim"
 * enforceable rather than a request in a prompt.
 *
 * Six read the acervo. Four leave it — two watch the queue, one of them waiting
 * for work to finish, and two reach the court: one asks the court what it has, one
 * queues a capture. That pair is the difference between a chatbot over a
 * database and this product — asked about a case nobody has crawled, it can
 * check whether the TRF5 has it and go and get it, instead of reporting an
 * absence that is only ours.
 *
 * Every result is data, never prose. The model does the writing; these do the
 * knowing. And every result carries the identifiers a citation needs, so the
 * page can turn a case number into a link *after checking it exists* — see
 * `renderAnswer`. A case number the model invents stays plain text.
 */

export interface ToolDeps {
  data: WebDataSource
  portal: PortalSearch
  runner: Runner
}

/** One call the model made, and what came back — for the reasoning trace. */
export interface ToolTrace {
  name: string
  args: Record<string, unknown>
  /** A short human line: "5 resultados", "21 movimientos". Never the payload. */
  summary: string
  ms: number
  error: string | null
}

export interface ToolResult {
  /** What goes back to the model, as JSON. */
  payload: unknown
  summary: string
}

/**
 * The declarations handed to Gemini.
 *
 * Written out rather than generated from the implementations because this is
 * the model's entire view of the system: every word here is a decision about
 * what it will reach for and when. The descriptions say what a tool is *for*,
 * not only what it takes — a model picks tools by their prose.
 */
export const TOOL_DECLARATIONS = [
  {
    name: 'buscar_en_el_acervo',
    description:
      'Búsqueda de texto completo sobre lo ya capturado: número y metadatos del expediente, ' +
      'nombres de las partes, descripciones de los movimientos y el texto íntegro de los ' +
      'documentos. Devuelve expedientes con un fragmento del sitio donde coincidió. ' +
      'Acentos opcionales: "execucao" encuentra "execução". Es la primera herramienta para ' +
      'casi cualquier pregunta. NO consulta el portal del tribunal: solo lo que ya tenemos.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Los términos a buscar.' },
        limite: { type: 'integer', description: 'Cuántos expedientes devolver (por defecto 8, máximo 25).' },
      },
      required: ['texto'],
    },
  },
  {
    name: 'leer_expediente',
    description:
      'La ficha completa de un expediente del acervo por su número CNJ: clase, órgano juzgador, ' +
      'fecha de distribución, todas las partes con su rol, la línea temporal entera de ' +
      'movimientos y la lista de documentos con sus fechas. Úsala para responder "¿en qué va ' +
      'este proceso?" o "¿quién litiga aquí?". Devuelve nulo si el expediente no está capturado.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        numero: {
          type: 'string',
          description:
            'El número CNJ (0009986-11.2026.4.05.8400) o el id interno (567). El id interno ' +
            'sirve para comprobar un expediente que encolaste por id.',
        },
      },
      required: ['numero'],
    },
  },
  {
    name: 'leer_documento',
    description:
      'El texto íntegro de un documento capturado, por su id. Úsala cuando el fragmento de la ' +
      'búsqueda no baste para citar con exactitud —una sentencia, un acórdão— o cuando la ' +
      'pregunta sea sobre lo que ese documento dice. Los ids salen de buscar_en_el_acervo o de ' +
      'leer_expediente; no los inventes.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'El id del documento.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'contar',
    description:
      'Cifras sobre el acervo, agrupadas por clase judicial u órgano juzgador. Úsala cuando la ' +
      'pregunta sea "cuántos" o "cuál es el más frecuente": contar es más fiable que estimar a ' +
      'partir de unos cuantos resultados de búsqueda. Devuelve también el total del acervo, ' +
      'para que puedas decir sobre qué se está contando.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        agrupar_por: {
          type: 'string',
          enum: ['clase', 'organo'],
          description: 'Por qué campo agrupar.',
        },
      },
      required: ['agrupar_por'],
    },
  },
  {
    name: 'listar_expedientes',
    description:
      'Lista expedientes del acervo sin buscar nada: los más recientes. Úsala para "muéstrame ' +
      'los últimos", "qué tienes", "los 3 más nuevos" — preguntas sin término de búsqueda. ' +
      'Hay dos sentidos de "reciente" y son distintos: "movimiento" ordena por la última ' +
      'actuación en el tribunal (lo más nuevo judicialmente) y "captura" por cuándo lo bajó ' +
      'nuestro scraper (un expediente capturado hoy puede llevar parado desde 2019). Si el ' +
      'usuario no lo aclara, usa "movimiento" y di cuál has usado.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        ordenar_por: {
          type: 'string',
          enum: ['movimiento', 'captura'],
          description: 'Último movimiento en el tribunal, o fecha en que lo capturamos.',
        },
        limite: { type: 'integer', description: 'Cuántos devolver (por defecto 10, máximo 50).' },
      },
      required: ['ordenar_por'],
    },
  },
  {
    name: 'listar_documentos',
    description:
      'Documentos de todo el acervo sin buscar nada, cada uno con el expediente al que ' +
      'pertenece. Es la herramienta para "muéstrame unos documentos", "3 al azar", "los ' +
      'últimos que habéis bajado" — cualquier petición de documentos que no venga con un ' +
      'expediente ni un término de búsqueda. "aleatorio" toma una muestra al azar; ' +
      '"reciente" ordena por la fecha del documento. Devuelve solo documentos ya ' +
      'descargados, así que puedes leer cualquiera de ellos con leer_documento.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        orden: {
          type: 'string',
          enum: ['aleatorio', 'reciente'],
          description: 'Muestra al azar, o los más nuevos por fecha del documento.',
        },
        limite: { type: 'integer', description: 'Cuántos devolver (por defecto 5, máximo 25).' },
      },
      required: ['orden'],
    },
  },
  {
    name: 'buscar_en_el_portal',
    description:
      'Consulta EN VIVO el formulario público del TRF5 — lo que el tribunal tiene, no lo que ' +
      'nosotros hemos capturado. Es la única forma de encontrar expedientes por FECHA: el ' +
      'acervo no se puede filtrar así, el portal sí. Úsala también cuando buscar_en_el_acervo ' +
      'no encuentre algo y quieras saber si existe. ' +
      'Reglas del portal, que rechaza o ignora en silencio si no se cumplen: parte y abogado ' +
      'necesitan al menos dos palabras; las fechas van en dd/mm/aaaa y filtran por la fecha de ' +
      'AUTUACIÓN, no la del último movimiento; el número y la referencia deben ser exactos; el ' +
      'estado de la OAB no filtra sin el número. Corta siempre en 30 resultados y no hay ' +
      'página dos: si sale recortado, hay que afinar. Es lenta (segundos) y hace una petición ' +
      'real al tribunal: úsala cuando aporte, no por rutina. ' +
      'Por defecto encola la captura de lo que encuentre y no tengamos, igual que hace la ' +
      'pantalla de Búsqueda, y devuelve el id del trabajo de cada uno.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        numero: { type: 'string', description: 'Número CNJ exacto.' },
        desde: { type: 'string', description: 'Autuados desde esta fecha, dd/mm/aaaa.' },
        hasta: { type: 'string', description: 'Autuados hasta esta fecha, dd/mm/aaaa.' },
        clase: { type: 'string', description: 'Clase judicial, coincidencia parcial.' },
        parte: { type: 'string', description: 'Nombre de una parte, dos palabras como mínimo.' },
        abogado: { type: 'string', description: 'Nombre de un abogado, dos palabras como mínimo.' },
        documento: { type: 'string', description: 'CPF o CNPJ de una parte, solo dígitos.' },
        tipo_documento: {
          type: 'string',
          enum: ['cpf', 'cnpj'],
          description: 'Qué es el documento anterior.',
        },
        oab: { type: 'string', description: 'Número de inscripción OAB del abogado.' },
        estado_oab: { type: 'string', description: 'Estado de la OAB; no filtra sin el número.' },
        referencia: { type: 'string', description: 'Número del proceso de referencia, exacto.' },
        capturar: {
          type: 'boolean',
          description:
            'Encolar la captura de lo que el tribunal tenga y nosotros no. Por defecto sí, ' +
            'igual que la pantalla de Búsqueda. Ponlo en false cuando solo estés comprobando ' +
            'si algo existe: capturar treinta expedientes por una consulta de sondeo hace ' +
            'trabajar al tribunal para nada.',
        },
      },
    },
  },
  {
    name: 'estado_de_la_cola',
    description:
      'Cómo va el trabajo que encolaste, o la cola entera. Es la herramienta para "¿ya está?", ' +
      '"¿va bien?", "¿qué queda?". Con "trabajo" mira ese trabajo concreto: su estado ' +
      '(queued, running, done, failed), en qué paso va y cuánto lleva. Sin él devuelve el ' +
      'resumen: cuántos corren, cuántos esperan y los últimos. ' +
      'NUNCA supongas que una captura terminó porque haya pasado un rato: míralo aquí. Y si ' +
      'sigue corriendo, dilo con lo que la cola diga —el paso y el avance—, no con una frase ' +
      'vaga de que tarda un poco.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        trabajo: {
          type: 'integer',
          description: 'El id de un trabajo. Omítelo para ver la cola entera.',
        },
      },
    },
  },
  {
    name: 'esperar_trabajo',
    description:
      'Espera a que termine un trabajo de la cola y cuenta qué cambió. Úsala cuando el usuario ' +
      'quiera el resultado y no un "va en camino": bloquea hasta que el trabajo acaba, o hasta ' +
      'agotar la espera. Al terminar dice qué trajo —partes, movimientos y documentos, y ' +
      'cuántos son nuevos si el expediente ya estaba—. ' +
      'Si se agota la espera NO ha fallado: devuelve el avance y puedes volver a esperar. Para ' +
      'muchos trabajos a la vez es mejor estado_de_la_cola; esta espera de uno en uno. ' +
      'Después de esta llamada NO digas que sigue en camino si aquí pone que terminó.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        trabajo: { type: 'integer', description: 'El id que devolvió encolar_captura.' },
        segundos: {
          type: 'integer',
          description: 'Cuánto esperar como máximo (por defecto 90, tope 240).',
        },
      },
      required: ['trabajo'],
    },
  },
  {
    name: 'encolar_captura',
    description:
      'Pone trabajo en la cola del scraper y arranca un worker si no hay ninguno. Son cuatro ' +
      'capacidades distintas, no una:\n' +
      '- "expediente": captura un expediente entero por primera vez —ficha, partes, ' +
      'movimientos y todos sus documentos. objetivo = número CNJ o id interno.\n' +
      '- "actualizar": vuelve a leer un expediente QUE YA ESTÁ en el acervo, para traer lo ' +
      'que haya cambiado. objetivo = número CNJ o id interno. Falla si no está capturado.\n' +
      '- "rango": lo mismo que "expediente" pero sobre un rango de ids internos seguidos. ' +
      'objetivo = "130100-130400".\n' +
      '- "explorar": recorre el tribunal buscando expedientes que no conocemos. Con objetivo ' +
      'vacío sigue desde donde se quedó la última vez; con un rango, ese rango.\n' +
      'IMPORTANTE sobre el objetivo: un número suelto —"7", "375", "130100"— es un ID INTERNO ' +
      'y es un objetivo perfectamente válido. "el caso 7", "id 7", "captura el 375" se ' +
      'encolan tal cual con tipo "expediente". NO pidas el número CNJ en ese caso: el ' +
      'scraper va al portal con el id interno y lo baja igual. Solo buscar_en_el_portal ' +
      'necesita el CNJ completo, porque el formulario público no busca por id interno. ' +
      'Capturar por id interno ES ir al tribunal y descargarlo.\n' +
      'Devuelve el id del trabajo. La captura tarda de segundos a minutos, así que NO ' +
      'afirmes después que ya está capturado: di que va en camino, y usa esperar_trabajo si ' +
      'quieren el resultado. Si el usuario quiere algo nuevo pero no sabe ningún número, ' +
      '"explorar" es la respuesta; buscar_en_el_portal es la otra, si tiene parte o clase.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        tipo: {
          type: 'string',
          enum: ['expediente', 'actualizar', 'rango', 'explorar'],
          description: 'Qué clase de trabajo encolar.',
        },
        objetivo: {
          type: 'string',
          description:
            'Número CNJ o id interno para "expediente" y "actualizar"; un rango como ' +
            '"130100-130400" para "rango"; vacío para que "explorar" siga la marca de agua.',
        },
      },
      required: ['tipo'],
    },
  },
] as const

export type ToolName = (typeof TOOL_DECLARATIONS)[number]['name']
