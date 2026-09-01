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
