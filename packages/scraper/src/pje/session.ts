import { HttpClient, decodeLatin1 } from '../http/client.ts'
import { searchPageUrl } from './urls.ts'
import { HOST } from './urls.ts'

export interface PjeSession {
  /** Form action, including the `;jsessionid=` path segment the server requires. */
  actionUrl: string
  /** JSF-generated command id, e.g. `fPP:j_id244`. Never hardcode it. */
  submitParam: string
}

const ACTION_RE = /<form id="fPP"[^>]*action="([^"]+)"/
const SUBMIT_RE =
  /executarPesquisa\s*=\s*function\(\)\{A4J\.AJAX\.Submit\('fPP',\s*null,\s*\{'similarityGroupingId':'([^']+)'/

export function parseSessionFromHtml(html: string): PjeSession {
  const action = ACTION_RE.exec(html)?.[1]
  if (!action) throw new Error('Could not locate the fPP form action in the search page')

  const submit = SUBMIT_RE.exec(html)?.[1]
  if (!submit) throw new Error('Could not locate the executarPesquisa submit parameter')

  return { actionUrl: action.startsWith('http') ? action : HOST + action, submitParam: submit }
}

export async function startSession(client: HttpClient): Promise<PjeSession> {
  const res = await client.request(searchPageUrl())
  return parseSessionFromHtml(decodeLatin1(res.body))
}
