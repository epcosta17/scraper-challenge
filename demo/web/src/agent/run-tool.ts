import type { ToolDeps, ToolResult } from './tools.ts'

/**
 * Runs one tool call and shapes what goes back to the model.
 *
 * Two rules hold throughout.
 *
 * Results are **data, never prose**: no tool returns a sentence for the model
 * to repeat. The model writes; these know. A tool that phrased its own answer
 * would put words in the reply that nothing in the acervo can be checked
 * against.
 *
 * Results are **bounded**. A case with 4,182 movements or a 22,000-character
 * judgment would otherwise fill the context and crowd out the question. Each
 * tool trims, and says in the payload that it trimmed — the model can then
 * ask for more, and, more importantly, will not report a truncated list as if
 * it were the whole of one.
 */

/** Case numbers found in a payload are what the page later turns into links. */
const MAX_HITS = 25
const MAX_MOVEMENTS = 60
const MAX_DOCUMENT_CHARS = 12_000

/** How often the wait looks again. Often enough to feel live, rarely enough
 *  that a two-minute wait is sixty reads and not six thousand. */
const POLL_MS = 1_500

const progressOf = (job: { progress?: { done: number; total: number | null } | null }): string | null =>
  job.progress === undefined || job.progress === null
    ? null
    : `${job.progress.done}${job.progress.total === null ? '' : ` de ${job.progress.total}`}`

/**
 * What a case holds right now, from a job's target.
 *
 * The target is whatever was enqueued — a CNJ number, `id 567`, or a range —
 * so anything that is not one case simply has no counts, and the caller says
 * nothing about them rather than guessing.
 */
async function countsFor(
  deps: ToolDeps,
  target: string,
): Promise<{ numero: string; partes: number; movimientos: number; documentos: number } | null> {
  const raw = target.trim().replace(/^ids?\s+/i, '')
  const numero = /^\d+$/.test(raw) ? await deps.data.caseNumberById(Number(raw)) : raw
  if (numero === null || !/^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/.test(numero)) return null
  const c = await deps.data.getCase(numero)
  if (c === null) return null
  return {
    numero: c.number,
    partes: c.parties.length,
    movimientos: c.movements.length,
    documentos: c.documents.length,
  }
}

export async function runTool(
  deps: ToolDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'buscar_en_el_acervo': {
      const texto = String(args.texto ?? '').trim()
      const limite = Math.min(MAX_HITS, Math.max(1, Number(args.limite) || 8))
      if (texto === '') {
        return { payload: { error: 'Hace falta algo que buscar.' }, summary: 'sin términos' }
      }
      const result = await deps.data.search({ text: texto }, 1, limite)
      if (result.error !== null) {
        return { payload: { error: result.error }, summary: result.error }
      }
      return {
        payload: {
          total: result.total,
          mostrando: result.hits.length,
          expedientes: result.hits.map((h) => ({
            numero: h.number,
            clase: h.className,
            organo: h.organ,
            distribuido: h.distributedAt,
            coincide_en: h.matchedIn,
            fragmento: h.snippet?.segments.map((s) => s.text).join('') ?? null,
            documento_id: h.snippet?.documentId ?? null,
            documento: h.snippet?.label ?? null,
          })),
        },
        summary: `${result.total} ${result.total === 1 ? 'expediente' : 'expedientes'}`,
      }
    }

    case 'leer_expediente': {
      const asked = String(args.numero ?? '').trim()
      // A bare number is an internal id, which is how a capture is queued and
      // therefore how somebody asks whether that capture arrived.
      const numero = /^\d+$/.test(asked)
        ? (await deps.data.caseNumberById(Number(asked))) ?? asked
        : asked
      const c = await deps.data.getCase(numero)
      if (c === null) {
        // Said as data, not as an apology: the model decides what to do about
        // it, and "not in the acervo" is different from "does not exist".
        return {
          payload: { encontrado: false, numero, nota: 'No está en el acervo capturado.' },
          summary: 'no está en el acervo',
        }
      }
      const movements = c.movements.slice(0, MAX_MOVEMENTS)
      return {
        payload: {
          encontrado: true,
          numero: c.number,
          clase: c.className,
          organo: c.organ,
          panel: c.panel,
          distribuido: c.distributedAt,
          proceso_de_referencia: c.referenceNumber,
          partes: c.parties.map((p) => ({
            nombre: p.name,
            rol: p.role,
            polo: p.polo,
            documento: p.documentNumber,
            tipo_documento: p.documentType,
            oab: p.oab,
          })),
          movimientos: movements.map((m) => ({ fecha: m.timestamp, descripcion: m.description })),
          movimientos_mostrados: movements.length,
          movimientos_totales: c.movements.length,
          documentos: c.documents.map((d) => ({
            id: d.id, titulo: d.label, fecha: d.docDate, formato: d.format,
          })),
          // The capture's own honesty, handed through: a case where the portal
          // declares more than we read must not be summarised as complete.
          captura: {
            partes: `${c.capture.parties.captured} de ${c.capture.parties.declared ?? '?'}`,
            movimientos: `${c.capture.movements.captured} de ${c.capture.movements.declared ?? '?'}`,
          },
        },
        summary: `${c.parties.length} partes, ${c.movements.length} movimientos, ${c.documents.length} documentos`,
      }
    }

    case 'leer_documento': {
      const id = Number(args.id)
      if (!Number.isInteger(id)) {
        return { payload: { error: 'El id tiene que ser un número.' }, summary: 'id inválido' }
      }
      // The text, not the file. `openDocument` would hand back PDF bytes for
      // any document that has one — right for the viewer, unreadable here.
      const doc = await deps.data.documentText(id)
      if (doc === null) {
        return { payload: { encontrado: false, id }, summary: 'no existe' }
      }
      const trimmed = doc.text.slice(0, MAX_DOCUMENT_CHARS)
      return {
        payload: {
          encontrado: true,
          id,
          titulo: doc.label,
          fecha: doc.docDate,
          expediente: doc.caseNumber,
          texto: trimmed,
          recortado: trimmed.length < doc.text.length,
          caracteres_totales: doc.text.length,
        },
        summary: `${doc.text.length} caracteres`,
      }
    }

    case 'contar': {
      const by = String(args.agrupar_por ?? '')
      const stats = await deps.data.archiveStats()
      const rows = by === 'organo'
        ? (await deps.data.caseOrgans()).map((o) => ({ valor: o.name, expedientes: o.caseCount }))
        : (await deps.data.caseClasses()).map((c) => ({ valor: c.name, expedientes: c.caseCount }))
      return {
        payload: { agrupado_por: by === 'organo' ? 'organo' : 'clase', total_acervo: stats.caseCount, filas: rows },
        summary: `${rows.length} ${rows.length === 1 ? 'grupo' : 'grupos'} sobre ${stats.caseCount} expedientes`,
      }
    }

    case 'listar_expedientes': {
      // Two orderings, because "recent" is two questions. Defaulting to the
      // court's own activity: asked for "the latest cases", nobody means "the
      // ones our crawler happened to touch last".
      const by = String(args.ordenar_por ?? 'movimiento')
      const limit = Math.min(50, Math.max(1, Number(args.limite) || 10))
      const items = by === 'captura'
        ? (await deps.data.listCases(1, limit)).items
        : await deps.data.recentlyMoved(limit)
      const stats = await deps.data.archiveStats()
      return {
        payload: {
          ordenado_por: by === 'captura' ? 'fecha de captura' : 'último movimiento en el tribunal',
          total_acervo: stats.caseCount,
          mostrando: items.length,
          expedientes: items.map((c) => ({
            numero: c.number,
            clase: c.className,
            organo: c.organ,
            ultimo_movimiento: c.lastMovement === null
              ? null
              : { fecha: c.lastMovement.timestamp, descripcion: c.lastMovement.description },
          })),
        },
        summary: `${items.length} por ${by === 'captura' ? 'captura' : 'movimiento'}`,
      }
    }

    case 'listar_documentos': {
      const order = String(args.orden ?? 'aleatorio') === 'reciente' ? 'recent' : 'random'
      const limit = Math.min(25, Math.max(1, Number(args.limite) || 5))
      const docs = await deps.data.sampleDocuments(limit, order)
      return {
        payload: {
          orden: order === 'recent' ? 'más recientes por fecha del documento' : 'muestra al azar',
          mostrando: docs.length,
          documentos: docs.map((d) => ({
            id: d.id,
            titulo: d.label,
            fecha: d.docDate,
            formato: d.format,
            expediente: d.caseNumber,
            clase: d.className,
          })),
        },
        summary: `${docs.length} ${docs.length === 1 ? 'documento' : 'documentos'}`,
      }
    }

    case 'buscar_en_el_portal': {
      // Every criterion the portal takes, not the four it used to be: dates are
      // the only way to answer "los de ayer", and the acervo cannot be filtered
      // by them at all.
      const filters = {
        number: String(args.numero ?? '').trim(),
        from: String(args.desde ?? '').trim(),
        to: String(args.hasta ?? '').trim(),
        class: String(args.clase ?? '').trim(),
        party: String(args.parte ?? '').trim(),
        lawyer: String(args.abogado ?? '').trim(),
        document: String(args.documento ?? '').trim(),
        documentType: String(args.tipo_documento ?? '').trim(),
        oab: String(args.oab ?? '').trim(),
        oabState: String(args.estado_oab ?? '').trim(),
        reference: String(args.referencia ?? '').trim(),
      }
      const asked = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== ''))
      if (Object.keys(asked).length === 0) {
        return { payload: { error: 'Hace falta al menos un criterio.' }, summary: 'sin criterios' }
      }
      const out = await deps.portal.run(asked)
      if (!out.ok) {
        // The failure is named, so the model can tell "the court has nothing"
        // from "we could not ask" — and never report the second as the first.
        return { payload: { ok: false, motivo: out.kind, detalle: out.error }, summary: out.kind }
      }
      const held = await deps.data.casesByNumber(out.hits.map((h) => h.number))
      const missing = out.hits.filter((h) => !held.has(h.number))

      // The same thing the search screen does with its results: what the court
      // has and we do not is queued on the spot, and a worker started. Two
      // screens onto the same portal that behaved differently was the
      // inconsistency worth removing — a reader who searches from here should
      // end up with what a reader who searches from /busqueda ends up with.
      //
      // The agent can turn it off, because it also searches to *check* whether
      // something exists, and that question should not cost the court thirty
      // captures.
      const capture = args.capturar !== false && missing.length > 0
      const queued = capture
        ? await deps.data.ensureCaptureJobs(missing.map((h) => h.idProcessoTrf))
        : new Map<number, number>()
      if (queued.size > 0) deps.runner.ensureRunning()

      return {
        payload: {
          ok: true,
          encontrados: out.hits.length,
          recortado_en_30: out.capped,
          encolados: queued.size,
          nota: queued.size > 0
            ? `Se han encolado ${queued.size} capturas de lo que el tribunal tiene y nosotros no. `
              + 'Todavía NO están en el acervo; su avance se ve en la cola.'
            : undefined,
          expedientes: out.hits.map((h) => ({
            numero: h.number,
            id_interno: h.idProcessoTrf,
            // Straight off the portal's own result row, so an answer about
            // what the court has does not need a capture first.
            clase: h.className,
            asunto: h.subject,
            partes: h.parties,
            ultimo_movimiento: h.lastMovement,
            ya_capturado: held.has(h.number),
            trabajo: queued.get(h.idProcessoTrf) ?? null,
          })),
        },
        summary: `${out.hits.length} en el portal${out.capped ? ', recortado' : ''}`
          + (queued.size > 0 ? `, ${queued.size} encolados` : ''),
      }
    }

    case 'estado_de_la_cola': {
      const overview = await deps.data.captureOverview()
      const asked = Number(args.trabajo)

      const describe = (j: (typeof overview.jobs)[number]) => ({
        trabajo: j.id,
        tipo: j.kind,
        objetivo: j.target,
        estado: j.state,
        intentos: j.attempts,
        empezado: j.startedAt,
        terminado: j.finishedAt,
        paso: j.stage ?? null,
        avance: j.progress === undefined || j.progress === null
          ? null
          : `${j.progress.done}${j.progress.total === null ? '' : ` de ${j.progress.total}`}`,
        error: j.error,
      })

      if (Number.isInteger(asked)) {
        const job = overview.jobs.find((j) => j.id === asked)
        if (job === undefined) {
          return {
            payload: {
              encontrado: false,
              trabajo: asked,
              nota: 'No está entre los trabajos recientes. Puede haber terminado hace rato.',
            },
            summary: 'no está en la cola',
          }
        }
        return { payload: { encontrado: true, ...describe(job) }, summary: `#${asked}: ${job.state}` }
      }

      return {
        payload: {
          corriendo: overview.runningJobs,
          en_espera: overview.queuedJobs,
          fallos_abiertos: overview.openFailures,
          expedientes_hoy: overview.casesToday,
          documentos_hoy: overview.documentsToday,
          trabajos: overview.jobs.slice(0, 12).map(describe),
        },
        summary: `${overview.runningJobs} corriendo, ${overview.queuedJobs} en espera`,
      }
    }

    case 'esperar_trabajo': {
      const id = Number(args.trabajo)
      if (!Number.isInteger(id)) {
        return { payload: { error: 'Hace falta el id del trabajo.' }, summary: 'sin id' }
      }
      const limit = Math.min(240, Math.max(5, Number(args.segundos) || 90)) * 1000

      const first = await deps.data.job(id)
      if (first === null) {
        return { payload: { encontrado: false, trabajo: id }, summary: 'no existe' }
      }

      // What the case looked like before, so the answer can be "trajo 4
      // movimientos nuevos" rather than "terminó" — which is what somebody
      // asking for a refresh actually wants to know.
      const before = await countsFor(deps, first.target)

      const startedAt = Date.now()
      let job = first
      while (job.state === 'queued' || job.state === 'running') {
        if (Date.now() - startedAt > limit) {
          return {
            payload: {
              termino: false,
              trabajo: id,
              estado: job.state,
              paso: job.stage ?? null,
              avance: progressOf(job),
              esperado_segundos: Math.round((Date.now() - startedAt) / 1000),
              nota: 'Sigue trabajando. No ha fallado: puedes volver a esperar o mirar estado_de_la_cola.',
            },
            summary: `sigue ${job.state}`,
          }
        }
        await new Promise((r) => setTimeout(r, POLL_MS))
        const next = await deps.data.job(id)
        if (next === null) break
        job = next
      }

      const after = await countsFor(deps, job.target)
      return {
        payload: {
          termino: true,
          trabajo: id,
          estado: job.state,
          error: job.error,
          segundos: Math.round((Date.now() - startedAt) / 1000),
          expediente: after?.numero ?? null,
          resultado: after === null ? null : {
            partes: after.partes,
            movimientos: after.movimientos,
            documentos: after.documentos,
            // Null rather than zero when there was nothing to compare against:
            // a first capture has no "new", and calling it zero would read as
            // "it brought nothing".
            nuevos: before === null ? null : {
              partes: after.partes - before.partes,
              movimientos: after.movimientos - before.movimientos,
              documentos: after.documentos - before.documentos,
            },
          },
        },
        summary: job.state === 'done'
          ? `terminó en ${Math.round((Date.now() - startedAt) / 1000)}s`
          : `${job.state}`,
      }
    }

    case 'encolar_captura': {
      // The four the queue actually accepts. The agent had only the first, so a
      // reader who wanted something new but had no case number hit a dead end —
      // while the scraper behind it could have gone and found one.
      const KINDS = {
        expediente: 'deep_case',
        actualizar: 'refresh_case',
        rango: 'deep_range',
        explorar: 'crawl',
      } as const
      const tipo = String(args.tipo ?? '') as keyof typeof KINDS
      const kind = KINDS[tipo]
      if (kind === undefined) {
        return {
          payload: { error: `Tipo desconocido: ${tipo}. Usa expediente, actualizar, rango o explorar.` },
          summary: 'tipo inválido',
        }
      }

      const objetivo = String(args.objetivo ?? '').trim()
      const out = await deps.data.enqueue(kind, objetivo)
      if (!out.ok) {
        // The reason comes from the queue's own parser, so the model can repeat
        // exactly what was wrong with the target instead of guessing.
        return { payload: { encolado: false, tipo, motivo: out.error }, summary: 'rechazado' }
      }

      const started = deps.runner.ensureRunning()
      return {
        payload: {
          encolado: true,
          tipo,
          trabajo: out.job.id,
          objetivo: objetivo === '' ? 'desde la marca de agua' : objetivo,
          worker: started.started ? 'arrancado' : 'ya estaba corriendo',
          nota: tipo === 'explorar'
            ? 'Explorar puede tardar bastante y traer varios expedientes. Todavía NO hay nada nuevo en el acervo.'
            : 'La captura tarda entre segundos y minutos. Todavía NO está en el acervo.',
        },
        summary: `${tipo} · trabajo #${out.job.id}`,
      }
    }

    default:
      return { payload: { error: `Herramienta desconocida: ${name}` }, summary: 'desconocida' }
  }
}
