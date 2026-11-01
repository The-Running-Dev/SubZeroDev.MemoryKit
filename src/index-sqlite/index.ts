// Optional derived caches. Recall cache values contain sensitive queries and quoted text.
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

/** Opt-in sensitive output cache. Five-minute TTL; globally bounded to 64 entries and
 * 16 MiB of values per file. Deleting entries is logical eviction, not secure erasure. */
export class SqliteRecallCache {
  private readonly db: DatabaseSync;
  private readonly bucket: string;
  constructor(path: string, bucket: string) {
    validateKeys([bucket]);
    this.bucket = bucket;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    this.db.exec(
      'PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS recall_cache (bucket TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(bucket,key));'
    );
  }
  async get(key: string): Promise<unknown[] | null> {
    validateKeys([key]);
    const row = this.db
      .prepare('SELECT value FROM recall_cache WHERE bucket=? AND key=? AND expires>?')
      .get(this.bucket, key, Date.now());
    if (!row) return null;
    try {
      const value: unknown = JSON.parse(String(row.value));
      return Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }
  async put(key: string, value: unknown[]): Promise<void> {
    validateKeys([key]);
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > 256 * 1024) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM recall_cache WHERE expires<=?').run(Date.now());
      this.db
        .prepare('INSERT OR REPLACE INTO recall_cache VALUES (?,?,?,?)')
        .run(this.bucket, key, json, Date.now() + 300000);
      this.db.exec(
        'DELETE FROM recall_cache WHERE rowid NOT IN (SELECT rowid FROM recall_cache ORDER BY expires DESC, rowid DESC LIMIT 64)'
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async clear(): Promise<void> {
    this.db.prepare('DELETE FROM recall_cache WHERE bucket=?').run(this.bucket);
  }
  close(): void {
    this.db.close();
  }
}
