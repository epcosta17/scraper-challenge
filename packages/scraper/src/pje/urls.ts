export const HOST = 'https://pjett.trf5.jus.br'
export const BASE = `${HOST}/pjeconsulta`

export const searchPageUrl = (): string => `${BASE}/ConsultaPublica/listView.seam`

export const reportPdfUrl = (idProcessoTrf: number): string =>
  `${BASE}/ConsultaPublica/DetalheProcessoConsultaPublica/reportPDF.seam` +
  `?idProcessoTrf=${idProcessoTrf}`

/** The case detail page. `ca` is the 48-hex token only the search bridge can produce. */
export const detailUrl = (ca: string): string =>
  `${BASE}/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=${ca}`

export interface BinaryDocumentParams {
  idBin: number
  numeroDocumento: string
  /** The document's id within the case's file (`idProcessoDocumento` on this endpoint). */
  id: number
}

/**
 * The binary (PDF) document download endpoint. Works cold, no session
 * required. All three params are required by the server — omit any and it
 * serves HTML instead of the file (or, for `numeroDocumento`, a 404).
 * `nomeArqProcDocBin` (a suggested filename) is optional and deliberately
 * left out: it comes back from the page UTF-8-mangled (the same
 * ISO-8859-1-vs-UTF-8 charset mismatch documented in `search.ts`'s
 * `encodeFormComponent`) and the real filename is read from the download's
 * own `Content-Disposition` header instead.
 */
export const documentBinUrl = (p: BinaryDocumentParams): string => {
  const params = new URLSearchParams({
    idBin: String(p.idBin),
    numeroDocumento: p.numeroDocumento,
    idProcessoDocumento: String(p.id),
    actionMethod:
      'ConsultaPublica/DetalheProcessoConsultaPublica/listView.xhtml:processoDocumentoBinHome.setDownloadInstance(row)',
  })
  return `${BASE}/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?${params.toString()}`
}

/**
 * The HTML document endpoint. Unlike the case's own `ca`, this `ca` is
 * session-bound: it only resolves when requested with the same cookie jar
 * that fetched the detail page it was harvested from.
 */
export const documentHtmlUrl = (ca: string, idProcessoDoc: number): string =>
  `${BASE}/ConsultaPublica/DetalheProcessoConsultaPublica/documentoSemLoginHTML.seam` +
  `?ca=${ca}&idProcessoDoc=${idProcessoDoc}`
