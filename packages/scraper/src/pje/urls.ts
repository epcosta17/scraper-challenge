export const HOST = 'https://pjett.trf5.jus.br'
export const BASE = `${HOST}/pjeconsulta`

export const searchPageUrl = (): string => `${BASE}/ConsultaPublica/listView.seam`

export const reportPdfUrl = (idProcessoTrf: number): string =>
  `${BASE}/ConsultaPublica/DetalheProcessoConsultaPublica/reportPDF.seam` +
  `?idProcessoTrf=${idProcessoTrf}`
