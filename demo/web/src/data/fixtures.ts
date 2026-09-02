import type {
  ArchiveStats,
  CaptureOverview,
  CaseDetail,
  CasePage,
  CaseSummary,
  Conversation,
  Movement,
  PortalHit,
  PortalQuery,
  PortalSearchResult,
} from './types.ts'
import type { WebDataSource } from './source.ts'

/**
 * The sample acervo. Every string here is lifted from the design file — case
 * numbers, classes, parties, movement wording, the counters at the foot of the
 * list — so the mock-up reads exactly like the screens it was drawn from.
 *
 * Court data stays in Portuguese, as the portal serves it. Only the interface
 * around it speaks Spanish.
 */

/** Builds the tail of a long timeline: real PJe wording, descending dates. */
const olderMovements = (count: number, fromYear: number): Movement[] => {
  const script = [
    'Juntada de petição',
    'Publicado no DJe',
    'Expedição de intimação eletrônica',
    'Decorrido prazo',
    'Conclusos para decisão',
    'Proferido despacho de mero expediente',
    'Remetidos os autos para o Ministério Público Federal',
    'Devolvidos os autos pelo Ministério Público Federal',
    'Juntada de contrarrazões',
    'Certidão de decurso de prazo',
    'Recebidos os autos no gabinete',
    'Autos com vista à parte',
  ]
  const out: Movement[] = []
  for (let i = 0; i < count; i++) {
    const day = ((i * 7) % 27) + 1
    const month = (11 - (i % 12))
    const year = fromYear - Math.floor(i / 6)
    const stamp =
      `${String(day).padStart(2, '0')}/${String(month + 1).padStart(2, '0')}/${year}` +
      ` ${String(8 + (i % 9)).padStart(2, '0')}:${String((i * 13) % 60).padStart(2, '0')}`
    out.push({ timestamp: stamp, description: script[i % script.length]! })
  }
  return out
}

const CASE_0801438: CaseDetail = {
  number: '0801438-34.2016.4.05.8102',
  className: 'Apelação Cível',
  classCode: '198',
  organ: 'Gab 7 — Des. Paulo Roberto',
  panel: '2ª Turma',
  jurisdiction: 'TRF5',
  distributedAt: '25/08/2026',
  referenceNumber: '0801438-34.2016.4.05.8102',
  parties: [
    {
      polo: 'ativo',
      name: 'CONSELHO REGIONAL DE ODONTOLOGIA DO CEARÁ',
      documentType: 'cnpj',
      documentNumber: '07.299.589/0001-10',
      oab: null,
      role: 'APELANTE',
    },
    {
      polo: 'ativo',
      name: 'ALLEX KONNE DE NOGUEIRA E SOUZA',
      documentType: 'cpf',
      documentNumber: '640.535.983-20',
      oab: 'CE17669-A',
      role: 'ADVOGADO',
    },
    {
      polo: 'passivo',
      name: 'BENJAMIM SAMPAIO FILHO',
      documentType: 'cpf',
      documentNumber: '102.897.124-91',
      oab: null,
      role: 'APELADO',
    },
  ],
  movements: [
    { timestamp: '31/08/2026 14:29', description: 'Conclusos para julgamento' },
    { timestamp: '31/08/2026 14:29', description: 'Remetidos os autos da Distribuição ao Relator' },
    { timestamp: '25/08/2026 09:49', description: 'Recebidos os autos' },
    { timestamp: '25/08/2026 09:49', description: 'Recebido pelo Distribuidor' },
    { timestamp: '25/08/2026 09:49', description: 'Distribuído por sorteio' },
    ...olderMovements(34, 2025),
  ],
  documents: [
    { docDate: '24/07/2025', label: 'Despacho', format: 'PDF' },
    { docDate: '03/06/2022', label: 'Despacho Inspeção', format: 'PDF' },
    { docDate: '04/08/2021', label: 'Despacho', format: 'PDF' },
    { docDate: '19/05/2021', label: 'Despacho Inspeção', format: 'PDF' },
    { docDate: '23/10/2020', label: 'Despacho', format: 'PDF' },
    { docDate: '15/06/2020', label: 'Despacho Inspeção', format: 'PDF' },
    { docDate: '05/07/2019', label: 'Despacho', format: 'PDF' },
    { docDate: '26/07/2017', label: 'Decisão', format: 'PDF' },
    { docDate: '23/02/2017', label: 'Despacho', format: 'PDF' },
    { docDate: '13/02/2026', label: 'Despacho', format: 'HTML' },
  ],
  documentsBytes: 219_136,
  capture: {
    documents: { captured: 10, declared: 10 },
    movements: { captured: 39, declared: 39 },
    parties: { captured: 3, declared: 3 },
    lastCaptureAt: 'hoy, 14:22',
    requestCount: 11,
  },
}

/**
 * The Datascroller case. The detail page announces 41 parties and paints ten;
 * the rest live behind a JSF widget the scraper cannot drive, so the capture is
 * recorded as partial and every screen that shows the list says so.
 */
const CASE_0024885: CaseDetail = {
  number: '0024885-29.2005.4.05.0000',
  className: 'Embargos à Execução',
  classCode: '172',
  organ: 'Gab 2 — Des. Ana Beatriz',
  panel: '1ª Turma',
  jurisdiction: 'TRF5',
  distributedAt: '14/03/2005',
  referenceNumber: null,
  parties: [
    { polo: 'ativo', name: 'UNIÃO FEDERAL (FAZENDA NACIONAL)', documentType: 'cnpj', documentNumber: '00.394.460/0001-41', oab: null, role: 'EMBARGANTE' },
    { polo: 'ativo', name: 'PROCURADORIA-REGIONAL DA FAZENDA NACIONAL DA 5ª REGIÃO', documentType: null, documentNumber: null, oab: null, role: 'PROCURADOR' },
    { polo: 'passivo', name: 'MARIA DAS GRAÇAS ALBUQUERQUE LINS', documentType: 'cpf', documentNumber: '221.443.774-00', oab: null, role: 'EMBARGADO' },
    { polo: 'passivo', name: 'JOSÉ CARLOS DE MELO CAVALCANTI', documentType: 'cpf', documentNumber: '079.552.304-91', oab: null, role: 'EMBARGADO' },
    { polo: 'passivo', name: 'SEVERINO RAMOS DA SILVA', documentType: 'cpf', documentNumber: '134.908.664-15', oab: null, role: 'EMBARGADO' },
    { polo: 'passivo', name: 'ANTÔNIA VIEIRA DE BARROS', documentType: 'cpf', documentNumber: '306.771.284-72', oab: null, role: 'EMBARGADO' },
    { polo: 'passivo', name: 'FRANCISCO DE ASSIS NOGUEIRA', documentType: 'cpf', documentNumber: '045.310.203-68', oab: null, role: 'EMBARGADO' },
    { polo: 'passivo', name: 'ESPÓLIO DE JOÃO BATISTA DE ANDRADE', documentType: 'cpf', documentNumber: '018.226.484-53', oab: null, role: 'EMBARGADO' },
    { polo: 'passivo', name: 'LUIZ GONZAGA FERREIRA DE LIMA', documentType: 'cpf', documentNumber: '260.114.394-04', oab: null, role: 'EMBARGADO' },
    { polo: 'passivo', name: 'RITA DE CÁSSIA MOURA DE OLIVEIRA', documentType: 'cpf', documentNumber: '511.640.884-20', oab: 'PE21455', role: 'ADVOGADO' },
  ],
  movements: [
    { timestamp: '18/09/2025 11:02', description: 'Expedição de documentos' },
    { timestamp: '02/09/2025 16:44', description: 'Juntada de petição' },
    ...olderMovements(10, 2024),
  ],
  documents: [{ docDate: '18/09/2025', label: 'Certidão', format: 'PDF' }],
  documentsBytes: 32_768,
  capture: {
    documents: { captured: 1, declared: 1 },
    movements: { captured: 12, declared: 12 },
    // The header of the parties panel says 41; the Datascroller paints 10.
    parties: { captured: 10, declared: 41 },
    lastCaptureAt: 'ayer, 03:11',
    requestCount: 9,
  },
}

/** A case whose document sweep died on a 429 halfway through. */
const CASE_0800245: CaseDetail = {
  number: '0800245-51.2020.4.05.8002',
  className: 'Ação Civil Pública',
  classCode: '65',
  organ: 'Gab 11 — Des. Marcelo Nunes',
  panel: '3ª Turma',
  jurisdiction: 'TRF5',
  distributedAt: '07/02/2020',
  referenceNumber: '0800245-51.2020.4.05.8002',
  parties: [
    { polo: 'ativo', name: 'MINISTÉRIO PÚBLICO FEDERAL', documentType: 'cnpj', documentNumber: '26.989.715/0002-93', oab: null, role: 'APELANTE' },
    { polo: 'ativo', name: 'CAMILA REGO DE SOUSA MENDONÇA', documentType: 'cpf', documentNumber: '702.113.454-11', oab: 'AL10233', role: 'ADVOGADO' },
    { polo: 'passivo', name: 'MUNICÍPIO DE ARAPIRACA', documentType: 'cnpj', documentNumber: '12.198.693/0001-58', oab: null, role: 'APELADO' },
    { polo: 'passivo', name: 'ESTADO DE ALAGOAS', documentType: 'cnpj', documentNumber: '12.200.135/0001-80', oab: null, role: 'APELADO' },
  ],
  movements: [
    { timestamp: '11/06/2026 10:15', description: 'Remetidos os autos ao 1º grau' },
    { timestamp: '28/05/2026 09:03', description: 'Baixa definitiva' },
    ...olderMovements(7, 2025),
  ],
  documents: [
    { docDate: '11/06/2026', label: 'Certidão de baixa', format: 'PDF' },
    { docDate: '28/05/2026', label: 'Acórdão', format: 'PDF' },
    { docDate: '14/04/2026', label: 'Voto', format: 'PDF' },
    { docDate: '14/04/2026', label: 'Relatório', format: 'PDF' },
    { docDate: '02/12/2025', label: 'Parecer do MPF', format: 'PDF' },
    { docDate: '19/08/2024', label: 'Contrarrazões', format: 'PDF' },
    { docDate: '30/07/2024', label: 'Apelação', format: 'PDF' },
    { docDate: '07/02/2020', label: 'Petição inicial', format: 'HTML' },
  ],
  documentsBytes: 1_486_848,
  capture: {
    // Three downloads still owe us a 429 retry — see the failures panel.
    documents: { captured: 8, declared: 11 },
    movements: { captured: 9, declared: 9 },
    parties: { captured: 4, declared: 4 },
    lastCaptureAt: 'hoy, 06:40',
    requestCount: 14,
  },
}

const CASE_0005425: CaseDetail = {
  number: '0005425-26.2026.4.05.8308',
  className: 'Apelação Cível',
  classCode: '198',
  organ: 'Gab 14 — Des. Edvaldo Batista',
  panel: '4ª Turma',
  jurisdiction: 'TRF5',
  distributedAt: '12/03/2026',
  referenceNumber: null,
  parties: [
    { polo: 'ativo', name: 'CONSELHO REGIONAL DE ENFERMAGEM DE PERNAMBUCO', documentType: 'cnpj', documentNumber: '10.751.007/0001-73', oab: null, role: 'APELANTE' },
    { polo: 'ativo', name: 'HELOÍSA CAVALCANTI DE ARRUDA', documentType: 'cpf', documentNumber: '883.204.514-06', oab: 'PE33120', role: 'ADVOGADO' },
    { polo: 'ativo', name: 'RENATO BEZERRA DE MOURA', documentType: 'cpf', documentNumber: '620.884.334-49', oab: 'PE29004', role: 'ADVOGADO' },
    { polo: 'passivo', name: 'CLÍNICA SANTA LUZIA LTDA', documentType: 'cnpj', documentNumber: '05.664.221/0001-09', oab: null, role: 'APELADO' },
    { polo: 'passivo', name: 'TARCÍSIO LEAL DA FONSECA', documentType: 'cpf', documentNumber: '441.902.774-38', oab: null, role: 'APELADO' },
    { polo: 'passivo', name: 'IVONE MARIA DA CONCEIÇÃO', documentType: 'cpf', documentNumber: '155.480.204-77', oab: 'PE18720', role: 'ADVOGADO' },
  ],
  movements: [
    { timestamp: '22/05/2026 15:38', description: 'Juntada de petição' },
    { timestamp: '04/05/2026 08:12', description: 'Publicado no DJe' },
    ...olderMovements(15, 2026),
  ],
  documents: [
    { docDate: '22/05/2026', label: 'Petição', format: 'PDF' },
    { docDate: '04/05/2026', label: 'Despacho', format: 'PDF' },
    { docDate: '19/03/2026', label: 'Apelação', format: 'PDF' },
    { docDate: '12/03/2026', label: 'Sentença', format: 'HTML' },
  ],
  documentsBytes: 402_432,
  capture: {
    documents: { captured: 4, declared: 4 },
    movements: { captured: 17, declared: 17 },
    parties: { captured: 6, declared: 6 },
    lastCaptureAt: 'hoy, 11:07',
    requestCount: 12,
  },
}

/** Freshly distributed: no documents in the file yet, and that is not a gap. */
const CASE_0013475: CaseDetail = {
  number: '0013475-36.2026.4.05.0000',
  className: 'Agravo de Instrumento',
  classCode: '202',
  organ: 'Gab 6 — Des. Paulo Cordeiro',
  panel: '1ª Turma',
  jurisdiction: 'TRF5',
  distributedAt: '17/08/2026',
  referenceNumber: '0801201-19.2024.4.05.8400',
  parties: [
    { polo: 'ativo', name: 'BANCO DO NORDESTE DO BRASIL S.A.', documentType: 'cnpj', documentNumber: '07.237.373/0001-20', oab: null, role: 'AGRAVANTE' },
    { polo: 'passivo', name: 'AGROPECUÁRIA SERRA VERDE LTDA', documentType: 'cnpj', documentNumber: '08.442.910/0001-64', oab: null, role: 'AGRAVADO' },
  ],
  movements: [
    { timestamp: '17/08/2026 13:20', description: 'Distribuído por sorteio' },
    { timestamp: '17/08/2026 13:20', description: 'Recebido pelo Distribuidor' },
  ],
  documents: [],
  documentsBytes: 0,
  capture: {
    documents: { captured: 0, declared: 0 },
    movements: { captured: 2, declared: 2 },
    parties: { captured: 2, declared: 2 },
    lastCaptureAt: 'hoy, 09:55',
    requestCount: 6,
  },
}

const CASE_0019122: CaseDetail = {
  number: '0019122-32.2026.4.05.8400',
  className: 'Mandado de Segurança',
  classCode: '120',
  organ: 'Gab 3 — Des. Helena Vaz',
  panel: 'Pleno',
  jurisdiction: 'TRF5',
  distributedAt: '21/04/2026',
  referenceNumber: null,
  parties: [
    { polo: 'ativo', name: 'SINDICATO DOS SERVIDORES PÚBLICOS FEDERAIS DO RN', documentType: 'cnpj', documentNumber: '08.301.442/0001-05', oab: null, role: 'IMPETRANTE' },
    { polo: 'ativo', name: 'GUSTAVO HENRIQUE DANTAS PEIXOTO', documentType: 'cpf', documentNumber: '017.554.484-90', oab: 'RN9987', role: 'ADVOGADO' },
    { polo: 'passivo', name: 'SUPERINTENDENTE REGIONAL DO INSS NO RIO GRANDE DO NORTE', documentType: null, documentNumber: null, oab: null, role: 'IMPETRADO' },
    { polo: 'passivo', name: 'INSTITUTO NACIONAL DO SEGURO SOCIAL - INSS', documentType: 'cnpj', documentNumber: '29.979.036/0001-40', oab: null, role: 'LITISCONSORTE' },
    { polo: 'passivo', name: 'MINISTÉRIO PÚBLICO FEDERAL', documentType: 'cnpj', documentNumber: '26.989.715/0002-93', oab: null, role: 'FISCAL DA LEI' },
  ],
  movements: [
    { timestamp: '31/08/2026 17:41', description: 'Decisão publicada' },
    { timestamp: '30/08/2026 10:26', description: 'Proferida decisão liminar' },
    ...olderMovements(20, 2026),
  ],
  documents: [
    { docDate: '31/08/2026', label: 'Decisão', format: 'PDF' },
    { docDate: '30/08/2026', label: 'Informações da autoridade coatora', format: 'PDF' },
    { docDate: '05/05/2026', label: 'Petição inicial', format: 'PDF' },
    { docDate: '21/04/2026', label: 'Procuração', format: 'HTML' },
  ],
  documentsBytes: 585_728,
  capture: {
    documents: { captured: 4, declared: 4 },
    movements: { captured: 22, declared: 22 },
    parties: { captured: 5, declared: 5 },
    lastCaptureAt: 'hoy, 13:48',
    requestCount: 13,
  },
}

const CASES: CaseDetail[] = [
  CASE_0801438,
  CASE_0024885,
  CASE_0800245,
  CASE_0005425,
  CASE_0013475,
  CASE_0019122,
]

const toSummary = (c: CaseDetail): CaseSummary => ({
  number: c.number,
  className: c.className,
  organ: c.organ,
  parties: c.capture.parties,
  documents: c.capture.documents,
  lastMovement: c.movements[0] ?? null,
})

/** Cases in the real acervo — the sample above is the first page of it. */
const ARCHIVE_TOTAL = 133_421

/** The portal never answers with more than this, and never offers page 2. */
const PORTAL_ROW_LIMIT = 30

/**
 * The eight rows drawn in the design, plus the rest of the page the server
 * sent. Together they add up to the cap, which is the point of the screen: a
 * full page means the answer is truncated.
 */
const PORTAL_HITS: PortalHit[] = [
  { number: '0000148-15.2005.4.05.8001', className: 'Apelação Cível', inArchive: true },
  { number: '0018550-52.2007.4.05.8300', className: 'Apelação Cível', inArchive: true },
  { number: '0006125-26.2012.4.05.8200', className: 'Apelação Cível', inArchive: false },
  { number: '0804873-72.2014.4.05.8300', className: 'Apelação / Remessa', inArchive: true },
  { number: '0801438-34.2016.4.05.8102', className: 'Apelação Cível', inArchive: true },
  { number: '0800263-32.2017.4.05.8502', className: 'Agravo de Instrumento', inArchive: false },
  { number: '0012749-27.2003.4.05.8000', className: 'Embargos à Execução', inArchive: true },
  { number: '0009757-30.2002.4.05.8000', className: 'Apelação Cível', inArchive: false },
  ...Array.from({ length: PORTAL_ROW_LIMIT - 8 }, (_, i): PortalHit => {
    const seq = String(800_100 + i * 137).padStart(7, '0')
    const dv = String(11 + ((i * 17) % 78)).padStart(2, '0')
    const year = 2004 + (i % 21)
    const forum = String(8000 + ((i * 101) % 500)).padStart(4, '0')
    const classes = ['Apelação Cível', 'Apelação / Remessa', 'Embargos à Execução', 'Agravo de Instrumento']
    return {
      number: `${seq}-${dv}.${year}.4.05.${forum}`,
      className: classes[i % classes.length]!,
      inArchive: i % 3 !== 1,
    }
  }),
]

const CONVERSATION: Conversation = {
  scope: 'Sobre 133.421 expedientes y 1,2 M de documentos del TRF5',
  messages: [
    {
      role: 'user',
      paragraphs: [
        '¿En cuántos casos de anuidade de conselho profissional el TRF5 extinguió el proceso por falta de interés procesal en 2026?',
      ],
      citations: [],
      extraCitations: 0,
    },
    {
      role: 'assistant',
      paragraphs: [
        'Encontré 47 expedientes en 2026 con materia «Conselhos Regionais e Afins (Anuidade)» cuyo último movimiento registra extinção sem resolução de mérito por ausência de interesse processual.',
        'El patrón se concentra en 3 órganos juzgadores, y en 41 de los 47 el conselho es el polo activo. La clase predominante es Apelação Cível (198).',
      ],
      citations: ['0801438-34.2016', '0024885-29.2005'],
      extraCitations: 45,
    },
  ],
  sources: [
    {
      number: '0801438-34.2016.4.05.8102',
      className: 'Apelação Cível',
      fragment:
        '…extinção do processo sem resolução de mérito, ante a ausência de interesse processual superveniente…',
    },
    {
      number: '0024885-29.2005.4.05.0000',
      className: 'Embargos à Execução',
      fragment:
        '…o conselho profissional não demonstrou interesse na continuidade da execução…',
    },
    {
      number: '0019122-32.2026.4.05.8400',
      className: 'Mandado de Segurança',
      fragment: '…julgo extinto o feito, nos termos do art. 485, VI, do CPC…',
    },
  ],
  sourceCount: 47,
}

const CAPTURE: CaptureOverview = {
  runningJobs: 3,
  casesToday: 1_284,
  documentsToday: 11_902,
  openFailures: 7,
  requestsPerSecond: 2.1,
  updatedAgoLabel: 'hace 3 s',
  requestsPerCase: 11,
  jobs: [
    { id: 'j-1', kind: 'deep', target: 'ids 130100–130400', done: 217, total: 300, totalIsEstimate: false, state: 'running' },
    { id: 'j-2', kind: 'discover', target: 'marca de agua 133.421 →', done: 41, total: 350, totalIsEstimate: true, state: 'running' },
    { id: 'j-3', kind: 'deep', target: '0024885-29.2005.4.05.0000', done: 1, total: 1, totalIsEstimate: false, state: 'running' },
    { id: 'j-4', kind: 'backfill', target: 'huecos 128.000–129.000', done: null, total: null, totalIsEstimate: false, state: 'queued' },
    { id: 'j-5', kind: 'deep', target: 'ids 129800–130100', done: 300, total: 300, totalIsEstimate: false, state: 'done' },
    { id: 'j-6', kind: 'deep', target: '0800245-51.2020.4.05.8002', done: 0, total: 1, totalIsEstimate: false, state: 'failed' },
  ],
  failures: [
    { kind: 'deep_case', ref: '130104', error: 'puente de búsqueda: la acción no se ejecutó' },
    { kind: 'parties', ref: '28907', error: '10 de 40 partes — el Datascroller oculta el resto' },
    { kind: 'document', ref: '12039033', error: '429 tras 5 intentos' },
  ],
}

/**
 * The in-memory implementation of {@link WebDataSource}. Swapping it for one
 * backed by `@pje-trf5/core` is a one-line change in `./index.ts`.
 */
export const createFixtureDataSource = (): WebDataSource => ({
  async archiveStats(): Promise<ArchiveStats> {
    return {
      caseCount: ARCHIVE_TOTAL,
      documentCount: 1_204_388,
      coveragePct: 98.7,
      lastSyncLabel: 'hace 4 min',
    }
  },

  async listCases(page: number, pageSize: number): Promise<CasePage> {
    const pageCount = Math.max(1, Math.ceil(ARCHIVE_TOTAL / pageSize))
    const safePage = Math.min(Math.max(1, page), pageCount)
    // The sample only covers the first page of the acervo; every later page is
    // honestly empty rather than filled with invented rows.
    const items = safePage === 1 ? CASES.slice(0, pageSize).map(toSummary) : []
    return { items, total: ARCHIVE_TOTAL, page: safePage, pageSize, pageCount }
  },

  async getCase(number: string): Promise<CaseDetail | null> {
    return CASES.find((c) => c.number === number) ?? null
  },

  async captureOverview(): Promise<CaptureOverview> {
    return CAPTURE
  },

  async searchPortal(_query: PortalQuery): Promise<PortalSearchResult> {
    return {
      hits: PORTAL_HITS,
      rowLimit: PORTAL_ROW_LIMIT,
      // A full page is the only signal the portal gives that it truncated.
      capped: PORTAL_HITS.length >= PORTAL_ROW_LIMIT,
      elapsedMs: 1_400,
    }
  },

  async conversation(): Promise<Conversation> {
    return CONVERSATION
  },
})
