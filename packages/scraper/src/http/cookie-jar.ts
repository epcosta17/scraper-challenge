/**
 * Minimal same-host cookie jar. The PJe portal only sets host cookies
 * (JSESSIONID, ROUTER_ID, bot-manager cookies) so path/domain scoping
 * would add complexity without changing behaviour.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>()

  setFromHeaders(headers: Headers): void {
    const raw = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie')].filter((v): v is string => v !== null)

    for (const line of raw) {
      const pair = line.split(';', 1)[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  /** Empties the jar. See `startSession`'s doc comment for why starting a session needs this. */
  clear(): void {
    this.cookies.clear()
  }
}
