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

/**
 * Fetches the search page and parses the session out of it.
 *
 * Clears the client's cookie jar first. Found live: when the jar already
 * carries a cookie (e.g. a JSESSIONID planted by an unrelated prior request
 * on the same client — a summary PDF fetch, say), the server infers the
 * client already supports cookies and stops URL-rewriting the session into
 * the form's `action` attribute. The resulting `actionUrl` then carries no
 * `;jsessionid=` segment at all, and the subsequent POST to it fails with
 * `ActionNotExecutedError` ("no Ajax-Update-Ids header at all") — not
 * because the submit parameter is stale, but because the session the form
 * was rendered under and the one the POST's cookie now claims have quietly
 * diverged. "Start a session" has to mean start a NEW one: inheriting a
 * stale cookie here is exactly what breaks the URL rewriting this whole
 * flow depends on.
 */
export async function startSession(client: HttpClient): Promise<PjeSession> {
  client.jar.clear()
  const res = await client.request(searchPageUrl())
  return parseSessionFromHtml(decodeLatin1(res.body))
}
