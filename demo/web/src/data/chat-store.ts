import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Where the conversations live.
 *
 * A database of its own, deliberately. The chat is the demo's, not the
 * scraper's, and putting a `conversations` table into `packages/core`'s schema
 * would push a demo concern into the deliverable — the acervo's schema should
 * describe the court, and nothing else. Two files, one purpose each.
 *
 * What is stored: the questions, the answers, and the trace behind each answer
 * — the reasoning summaries and the tool calls, which are the part worth
 * keeping and the part that was being thrown away on every reload.
 *
 * What is never stored: the Gemini API key. It lives in the browser, travels
 * with each request and ends there. Nothing on this page changes that.
 */

export interface StoredTurn {
  id: number
  role: 'user' | 'model'
  text: string
  /** The trace events behind a model turn, as captured. Empty for questions. */
  trace: unknown[]
  createdAt: string
}

export interface Conversation {
  id: number
  title: string
  createdAt: string
  updatedAt: string
  turns: number
}

/**
 * One handle per file, not one handle ever.
 *
 * Keyed by path because a single memoised handle silently ignored the argument
 * from the second call on: every caller got whichever file happened to be
 * opened first. Only one path is used in the running app, so it would never
 * have shown there — the tests, which open a fresh file each time, are what
 * caught it.
 */
const open = new Map<string, Database.Database>()

function connect(path: string): Database.Database {
  const cached = open.get(path)
  if (cached !== undefined) return cached
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  open.set(path, db)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      -- Milliseconds, not seconds: two conversations touched inside the same
      -- second would otherwise tie, and the list order would come down to the
      -- id tiebreak rather than to what actually happened last.
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
    );
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL
        REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'model')),
      text TEXT NOT NULL,
      trace TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
    );
    CREATE INDEX IF NOT EXISTS turns_by_conversation
      ON turns (conversation_id, id);
  `)
  // Off by default in SQLite, and the cascade above is the whole reason the
  // delete route can be one statement.
  db.pragma('foreign_keys = ON')
  return db
}

export interface ChatStore {
  list(limit: number): Conversation[]
  create(title: string): Conversation
  read(id: number): { conversation: Conversation; turns: StoredTurn[] } | null
  append(id: number, role: 'user' | 'model', text: string, trace?: unknown[]): StoredTurn | null
  rename(id: number, title: string): boolean
  remove(id: number): boolean
}

/** A question, cut to something that reads as a title in a list. */
export function titleFrom(question: string): string {
  const line = question.trim().replace(/\s+/g, ' ')
  if (line === '') return 'Sin título'
  return line.length <= 60 ? line : `${line.slice(0, 59).trimEnd()}…`
}

export function openChatStore(path: string): ChatStore {
  const conn = connect(path)

  const toConversation = (r: Record<string, unknown>): Conversation => ({
    id: r.id as number,
    title: r.title as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    turns: (r.turns as number) ?? 0,
  })

  const toTurn = (r: Record<string, unknown>): StoredTurn => ({
    id: r.id as number,
    role: r.role as 'user' | 'model',
    text: r.text as string,
    // A row written by an older build, or half-written, must not take the
    // whole thread down with it: an unreadable trace is simply no trace.
    trace: parseTrace(r.trace as string),
    createdAt: r.created_at as string,
  })

  return {
    list(limit) {
      const rows = conn.prepare(`
        SELECT c.*, (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id) AS turns
        FROM conversations c
        -- Ordered by the last turn written, not by a timestamp. Turn ids are
        -- monotonic across every conversation, which makes them an exact clock;
        -- updated_at is only as fine as the system clock, and two turns
        -- written in the same millisecond tied, leaving the order to the id
        -- tiebreak. updated_at stays for display ("hace 3 h"), not for this.
        -- A conversation with no turns has no activity, so it sorts last. The
        -- app never makes one: a conversation is opened by the first answer
        -- and gets both its turns immediately.
        ORDER BY COALESCE(
          (SELECT MAX(t.id) FROM turns t WHERE t.conversation_id = c.id), 0
        ) DESC, c.id DESC
        LIMIT ?
      `).all(Math.min(200, Math.max(1, limit))) as Array<Record<string, unknown>>
      return rows.map(toConversation)
    },

    create(title) {
      const info = conn.prepare('INSERT INTO conversations (title) VALUES (?)').run(titleFrom(title))
      return this.read(Number(info.lastInsertRowid))!.conversation
    },

    read(id) {
      const row = conn.prepare(`
        SELECT c.*, (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id) AS turns
        FROM conversations c WHERE c.id = ?
      `).get(id) as Record<string, unknown> | undefined
      if (row === undefined) return null
      const turns = conn.prepare('SELECT * FROM turns WHERE conversation_id = ? ORDER BY id')
        .all(id) as Array<Record<string, unknown>>
      return { conversation: toConversation(row), turns: turns.map(toTurn) }
    },

    append(id, role, text, trace = []) {
      const exists = conn.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)
      if (exists === undefined) return null
      const write = conn.transaction(() => {
        const info = conn.prepare('INSERT INTO turns (conversation_id, role, text, trace) VALUES (?, ?, ?, ?)')
          .run(id, role, text, JSON.stringify(trace))
        // Bumped on every turn so the list is ordered by real activity, not by
        // when the conversation happened to be started.
        conn.prepare("UPDATE conversations SET updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?").run(id)
        return Number(info.lastInsertRowid)
      })
      const turnId = write()
      return toTurn(conn.prepare('SELECT * FROM turns WHERE id = ?').get(turnId) as Record<string, unknown>)
    },

    rename(id, title) {
      return conn.prepare("UPDATE conversations SET title = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?")
        .run(titleFrom(title), id).changes > 0
    },

    remove(id) {
      return conn.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0
    },
  }
}

function parseTrace(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
