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

export type ProbeStatus = 'not_found' | 'secret' | 'error'

export interface Failure {
  id: number
  kind: string
  ref: string
  error: string
  attempts: number
  lastAttemptAt: string
  resolvedAt: string | null
}
