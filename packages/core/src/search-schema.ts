import type Database from 'better-sqlite3'

// Type-only, for the same reason `schema.ts` does it — see the note there.
type Db = Database.Database

/**
 * The tokenizer every FTS5 table below is built with.
 *
 * `unicode61` is SQLite's Unicode-aware tokenizer: it case-folds and splits
 * on Unicode character classes rather than on ASCII alone. `remove_diacritics`
 * controls whether "sentença" and "sentenca" are the same token.
 *
 * Measured on Portuguese court prose (see `tests/search.test.ts`, which
 * asserts the behaviour this choice buys, and the tokenizer comparison in
 * the task report) against twelve realistic queries — the accented spelling
 * and the unaccented one for each of `sentença`, `execução`, `prescrição`,
 * `apelação`, `órgão`, `José`, `Gonçalves`:
 *
 *   tokenizer                        queries returning at least one row
 *   ascii                            4/12   (no case folding past ASCII: "EXECUÇÃO" -> "execuÇÃo")
 *   unicode61 remove_diacritics=0    5/12   (folds case, keeps accents: "execucao" finds nothing)
 *   unicode61 remove_diacritics=1   12/12
 *   unicode61 remove_diacritics=2   12/12
 *
 * So the real decision is "fold diacritics or not", and folding wins
 * decisively: half the useful queries fail without it, because a document
 * says "execução" and a person searching a Brazilian court portal types
 * "execucao". Nothing is lost in the other direction — the query string goes
 * through the same tokenizer, so the accented spelling still matches.
 *
 * Between `1` and `2` the Portuguese results are identical (both fold every
 * character the language uses, in composed *and* decomposed form — PDF text
 * extraction produces both). They differ on 112 codepoints, all of them
 * precomposed double-diacritic characters (Ǖ, Ḗ, Ṓ, ...) that `=1` leaves
 * untouched and `=2` folds. None are Portuguese, but party names in a
 * federal court file are not all Portuguese, and `=2` is a strict superset
 * of `=1` at no cost — so `=2`, which needs SQLite >= 3.27 (we ship 3.49).
 *
 * `tokenchars`/`separators` are left at their defaults: a case number
 * ("0013475-36.2026.4.05.0000") therefore tokenizes into its digit groups,
 * and `toFtsQuery` quotes it into a phrase, so searching the whole number
 * matches as an ordered phrase while a fragment of it still matches too.
 */
const TOKENIZER = `tokenize = "unicode61 remove_diacritics 2"`

/**
 * Three FTS5 tables, one per base table, rather than one table aggregating
 * everything about a case into a single row.
 *
 * The granularities genuinely differ — a case has many documents and many
 * parties — and the snippet has to come from *the document that matched*,
 * which a single case-level row (all documents concatenated) could not
 * point at. Splitting them also means each index mirrors exactly one table,
 * so the triggers stay one-to-one and no write has to re-aggregate its
 * siblings.
 *
 * All three are `content=`-backed (external content) tables: the index
 * stores only the terms, and `snippet()`/`highlight()` read the original
 * text back from the base table on demand. For `documents.text_content` —
 * whole PDFs, by far the largest column in the database — that is the
 * difference between one copy of the corpus and two. Measured over 31 real
 * scraped documents (166 KB of text): 139 KB of index with `content=`
 * against 336 KB without it, the extra being the second copy of the text
 * FTS5 would otherwise keep for itself.
 *
 * Kept out of `SCHEMA` on purpose: `ensureSearchIndex` needs to know whether
 * it is *creating* these tables (in which case a pre-existing database's
 * rows still have to be backfilled) or merely finding them again.
 */
const SEARCH_SCHEMA = `
CREATE VIRTUAL TABLE cases_fts USING fts5(
  number, class_name, court, panel, subjects_json, parties_json,
  content = 'cases',
  content_rowid = 'id_processo_trf',
  ${TOKENIZER}
);

CREATE VIRTUAL TABLE parties_fts USING fts5(
  name, role, oab,
  content = 'parties',
  content_rowid = 'id',
  ${TOKENIZER}
);

CREATE VIRTUAL TABLE documents_fts USING fts5(
  label, text_content,
  content = 'documents',
  content_rowid = 'id_processo_documento',
  ${TOKENIZER}
);

-- Sync is done by triggers rather than from the repository functions.
--
-- An external-content FTS5 index is only correct if every base-table write
-- is paired with the matching index write, and a delete/update must hand
-- FTS5 the *old* column values so it can subtract the right terms. A trigger
-- is the one place that always has OLD in hand, runs inside the writer's own
-- transaction (so a rolled-back upsert cannot leave the index ahead of the
-- table), and cannot be bypassed — not by a repository function someone adds
-- later, not by the worker or the web app writing directly, not by a manual
-- UPDATE in the sqlite3 shell. Doing it in the repositories would put that
-- invariant in the hands of every future caller instead.

CREATE TRIGGER cases_ai AFTER INSERT ON cases BEGIN
  INSERT INTO cases_fts(rowid, number, class_name, court, panel, subjects_json, parties_json)
  VALUES (new.id_processo_trf, new.number, new.class_name, new.court, new.panel, new.subjects_json, new.parties_json);
END;
CREATE TRIGGER cases_ad AFTER DELETE ON cases BEGIN
  INSERT INTO cases_fts(cases_fts, rowid, number, class_name, court, panel, subjects_json, parties_json)
  VALUES ('delete', old.id_processo_trf, old.number, old.class_name, old.court, old.panel, old.subjects_json, old.parties_json);
END;
CREATE TRIGGER cases_au AFTER UPDATE ON cases BEGIN
  INSERT INTO cases_fts(cases_fts, rowid, number, class_name, court, panel, subjects_json, parties_json)
  VALUES ('delete', old.id_processo_trf, old.number, old.class_name, old.court, old.panel, old.subjects_json, old.parties_json);
  INSERT INTO cases_fts(rowid, number, class_name, court, panel, subjects_json, parties_json)
  VALUES (new.id_processo_trf, new.number, new.class_name, new.court, new.panel, new.subjects_json, new.parties_json);
END;

CREATE TRIGGER parties_ai AFTER INSERT ON parties BEGIN
  INSERT INTO parties_fts(rowid, name, role, oab) VALUES (new.id, new.name, new.role, new.oab);
END;
CREATE TRIGGER parties_ad AFTER DELETE ON parties BEGIN
  INSERT INTO parties_fts(parties_fts, rowid, name, role, oab) VALUES ('delete', old.id, old.name, old.role, old.oab);
END;
CREATE TRIGGER parties_au AFTER UPDATE ON parties BEGIN
  INSERT INTO parties_fts(parties_fts, rowid, name, role, oab) VALUES ('delete', old.id, old.name, old.role, old.oab);
  INSERT INTO parties_fts(rowid, name, role, oab) VALUES (new.id, new.name, new.role, new.oab);
END;

CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, label, text_content) VALUES (new.id_processo_documento, new.label, new.text_content);
END;
CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, label, text_content)
  VALUES ('delete', old.id_processo_documento, old.label, old.text_content);
END;
CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, label, text_content)
  VALUES ('delete', old.id_processo_documento, old.label, old.text_content);
  INSERT INTO documents_fts(rowid, label, text_content) VALUES (new.id_processo_documento, new.label, new.text_content);
END;
`

const FTS_TABLES = ['cases_fts', 'parties_fts', 'documents_fts'] as const

function tableExists(db: Db, name: string): boolean {
  const row = db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { x: number } | undefined
  return row !== undefined
}

/**
 * Creates the search index if this database has not got one yet, and
 * backfills it from whatever is already stored.
 *
 * The backfill is the whole reason this is a function and not three more
 * `CREATE ... IF NOT EXISTS` lines in `SCHEMA`. The triggers above only fire
 * on writes that happen *after* they exist, so on a database that has been
 * crawling for weeks every existing case, party and document would be
 * permanently invisible to search — the index would look healthy and quietly
 * cover only the rows added from today on. `'rebuild'` reads the whole
 * content table and repopulates the index, which is exactly right here and
 * far too expensive to run on every `openDatabase`: hence the
 * "did I just create this?" check rather than an unconditional rebuild.
 *
 * On a fresh database the same call runs against empty tables and costs
 * nothing. Both paths are covered in `tests/search.test.ts`.
 */
export function ensureSearchIndex(db: Db): void {
  if (FTS_TABLES.every((t) => tableExists(db, t))) return

  // A half-created index (a crash between two of the statements below, or an
  // older build that only got as far as one table) would otherwise be left
  // in place and silently under-cover the corpus. Drop what is there and
  // build the whole set in one transaction instead.
  const rebuild = db.transaction(() => {
    for (const t of FTS_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`)
    for (const t of ['cases', 'parties', 'documents']) {
      for (const suffix of ['ai', 'ad', 'au']) db.exec(`DROP TRIGGER IF EXISTS ${t}_${suffix}`)
    }
    db.exec(SEARCH_SCHEMA)
    for (const t of FTS_TABLES) {
      db.prepare(`INSERT INTO ${t}(${t}) VALUES ('rebuild')`).run()
    }
  })
  rebuild()
}
