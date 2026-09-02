import { declaredMovements, declaredParties } from './declared.ts'

/**
 * The two failures that carry the coverage story, said in the interface's own
 * language.
 *
 * `failures.error` is the scraper's operational note, written in English for
 * whoever is reading a run. Two of its kinds are not really errors at all —
 * they are the record of *how much* of a list the portal declared and would
 * not hand over, and they are the reason a screen says `11 de 41`. Those two
 * are worth reading in Spanish, right under the numbers they explain.
 *
 * Everything else — a 429 on a document, a search bridge that would not run —
 * is passed through untouched. Inventing a Spanish sentence for an arbitrary
 * exception message would be paraphrasing something this module has no way to
 * understand, and the original is exact.
 */

/** `Parsed 1 ativo / 10 passivo parties …` → how many rows actually came back. */
const PARSED_PARTIES = /^Parsed (\d+) ativo \/ (\d+) passivo parties/
const PARSED_MOVEMENTS = /^Parsed (\d+) movements/

export function explainFailure(kind: string, error: string): string | null {
  if (kind === 'parties') {
    const parsed = PARSED_PARTIES.exec(error)
    const declared = declaredParties(error)
    if (parsed === null || declared === null) return null
    const read = Number(parsed[1]!) + Number(parsed[2]!)
    return `${read} de ${declared} partes. El Datascroller de la ficha solo pinta una página ` +
      'de participantes y no expone las siguientes; este scraper no lo sigue.'
  }

  if (kind === 'movements') {
    const parsed = PARSED_MOVEMENTS.exec(error)
    const declared = declaredMovements(error)
    if (parsed === null || declared === null) return null
    return `${parsed[1]!} de ${declared} movimientos. El PDF resumen dejó de coincidir con lo ` +
      'que declara la ficha, así que la premisa de que el PDF trae el registro completo ha ' +
      'dejado de valer para este expediente.'
  }

  return null
}
