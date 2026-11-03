import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { indexedTerms, rowPredicate, selectionTerms, type RowSelection } from '../storage-state/search-index.ts';
import type { RecordRow, State } from '../storage-state/index.ts';
import { sha256Hex } from '../model/index.ts';

/** Rebuildable candidate IDs/terms only. No authoritative records or credentials. */
export function indexedIds(path: string, state: State, selection: RowSelection,
  read: (ids: string[]) => RecordRow[]): string[] {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS manifest(version INTEGER PRIMARY KEY, fingerprint TEXT);
      CREATE TABLE IF NOT EXISTS rows(id TEXT PRIMARY KEY,file TEXT,namespace TEXT,state TEXT,kind TEXT);
      CREATE TABLE IF NOT EXISTS terms(term TEXT,id TEXT,PRIMARY KEY(term,id));
      CREATE TABLE IF NOT EXISTS links(target TEXT,id TEXT,PRIMARY KEY(target,id));`);
    const fingerprint = sha256Hex(JSON.stringify(state.files));
    if (db.prepare('SELECT fingerprint FROM manifest WHERE version=1').get()?.fingerprint !== fingerprint) {
      const existing = new Map(db.prepare('SELECT id,file FROM rows').all().map((r) => [r.id as string, r.file as string]));
      const changed = Object.keys(state.files).filter((id) => existing.get(id) !== state.files[id]);
      const records = read(changed); // Read and verify authoritative files before committing.
      db.exec('BEGIN IMMEDIATE');
      try {
        const remove = (id: string) => {
          db.prepare('DELETE FROM rows WHERE id=?').run(id);
          db.prepare('DELETE FROM terms WHERE id=?').run(id);
          db.prepare('DELETE FROM links WHERE id=?').run(id);
        };
        for (const id of existing.keys()) if (!state.files[id]) remove(id);
        for (const r of records) {
          remove(r.id);
          db.prepare('INSERT INTO rows VALUES(?,?,?,?,?)').run(r.id,state.files[r.id]!,r.namespace,r.state,r.kind);
          for (const term of indexedTerms(r)) db.prepare('INSERT INTO terms VALUES(?,?)').run(term,r.id);
          for (const target of new Set(r.links.filter((l) => l.type === 'supersedes').map((l) => l.target)))
            db.prepare('INSERT INTO links VALUES(?,?)').run(target,r.id);
        }
        db.prepare('INSERT OR REPLACE INTO manifest VALUES(1,?)').run(fingerprint);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    const values: SQLInputValue[] = [];
    const bind = (v: unknown) => { values.push(v as SQLInputValue); return '?'; };
    const terms = selectionTerms(selection);
    const predicate = rowPredicate(selection, bind) + (terms.length ? ` AND id IN
      (SELECT id FROM terms WHERE term IN (${terms.map(bind).join(',')}) GROUP BY id
      ${selection.any ? '' : `HAVING count(*)=${bind(terms.length)}`})` : '');
    const selected = selection.supersededIds ? [] : db.prepare('SELECT id FROM rows WHERE ' + predicate).all(...values).map((r) => r.id as string);
    const targets = selection.supersededIds ?? selected;
    const related = targets.flatMap((id) => db.prepare('SELECT id FROM links WHERE target=?').all(id).map((r) => r.id as string));
    return [...new Set([...selected, ...related])];
  } finally { db.close(); }
}
