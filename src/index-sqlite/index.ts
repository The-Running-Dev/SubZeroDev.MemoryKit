// Optional derived-vector index. No text, tokens or source records are persisted here.
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ValidationFailedError } from '../model/index.ts';
import type { EmbeddingIndex } from '../workflow/index.ts';

export class SqliteEmbeddingIndex implements EmbeddingIndex {
  private db: DatabaseSync;
  private bucket: string;
  constructor(path: string, bucket: string) {
    if (!/^[a-f0-9]{64}$/.test(bucket))
      throw new ValidationFailedError('Index bucket must be a SHA-256 identity');
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    this.db.exec(
      'PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS vectors (bucket TEXT NOT NULL, key TEXT NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(bucket,key));'
    );
    this.bucket = bucket;
  }
  async get(keys: string[]): Promise<(number[] | null)[]> {
    validateKeys(keys);
    const read = this.db.prepare('SELECT vector FROM vectors WHERE bucket=? AND key=?');
    return keys.map((key) => {
      const row = read.get(this.bucket, key);
      return row ? (JSON.parse(String(row.vector)) as number[]) : null;
    });
  }
  async put(entries: { key: string; vector: number[] }[]): Promise<void> {
    validateKeys(entries.map((e) => e.key));
    if (
      entries.some(
        (e) =>
          !Array.isArray(e.vector) ||
          !e.vector.length ||
          e.vector.length > 65536 ||
          e.vector.some((n) => !Number.isFinite(n))
      )
    )
      throw new ValidationFailedError('Invalid index vector');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const write = this.db.prepare(
        'INSERT OR REPLACE INTO vectors(bucket,key,vector) VALUES (?,?,?)'
      );
      for (const { key, vector } of entries) write.run(this.bucket, key, JSON.stringify(vector));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async retain(keys: string[]): Promise<void> {
    validateKeys(keys);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const keep = new Set(keys);
      const remove = this.db.prepare('DELETE FROM vectors WHERE bucket=? AND key=?');
      for (const row of this.db.prepare('SELECT key FROM vectors WHERE bucket=?').all(this.bucket))
        if (!keep.has(String(row.key))) remove.run(this.bucket, String(row.key));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
}
function validateKeys(keys: string[]): void {
  if (keys.some((key) => !/^[a-f0-9]{64}$/.test(key)))
    throw new ValidationFailedError('Index keys must be SHA-256 identities');
}
