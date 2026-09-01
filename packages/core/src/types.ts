export interface Party {
  name: string
  role: string
}

export interface StoredCase {
  idProcessoTrf: number
  number: string
  ca: string | null
  className: string
  classCode: string | null
  court: string | null
  panel: string | null
  distributedAt: string | null
  subjects: string[]
  parties: Party[]
  summaryPdfKey: string | null
  /** From the detail page's "Dados do Processo" panel — TRF5 for every case observed so far. */
  jurisdiction: string | null
  courtAddress: string | null
  /** "Processo referência", when the case cites a related case number. */
  referenceNumber: string | null
}

export type Polo = 'ativo' | 'passivo'
export type PartyDocumentType = 'cpf' | 'cnpj'

/**
 * One row of the detail page's Polo Ativo/Passivo tables, already split out
 * of the single free-text string the page prints (name, an optional OAB
 * registration, an optional CPF *or* CNPJ, and a procedural role) — see
 * `packages/scraper/src/pje/detail.ts`'s `parseParties` for how.
 */
export interface PartyInput {
  polo: Polo
  name: string
  documentType: PartyDocumentType | null
  documentNumber: string | null
  oab: string | null
  role: string | null
  situation: string | null
}

export interface StoredParty extends PartyInput {
  idProcessoTrf: number
}

/** One row of the "Movimentações do Processo" table, in the page's own order. */
export interface MovementInput {
  /** 0-based position in the page's own ordering — the table has no other stable key. */
  position: number
  timestamp: string | null
  description: string
}

export interface StoredMovement extends MovementInput {
  idProcessoTrf: number
}

// The portal answers a sealed ("segredo de justiça") case and an unassigned
// id with the identical HTTP 200 + error.seam shape (see `fetchReportPdf`),
// so the scraper has no way to distinguish them — every probe is recorded
// as `not_found`. Narrowed to what is actually produced rather than
// declaring statuses ('secret', 'error') the code can never write.
export type ProbeStatus = 'not_found'

export interface Failure {
  id: number
  kind: string
  ref: string
  error: string
  attempts: number
  lastAttemptAt: string
  resolvedAt: string | null
}
