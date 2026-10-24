import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  HistoryPolicy,
  ProviderDescriptor,
  RowScope,
  StorageProvider,
  StorageTransaction,
  StoredRow,
  WriteBatch,
} from '../contracts/index.ts';
import {
  AlreadyExistsError,
  InternalError,
  MemoryKitError,
  RevisionConflictError,
  StoreBusyError,
  StoreUnavailableError,
  StoreVersionTooNewError,
  type ContentType,
  type JsonValue,
  type Link,
  type LinkType,
  type MemoryId,
  type MemoryState,
  type Namespace,
} from '../model/index.ts';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.ts';

type Row = Record<string, unknown>;

export interface SqliteFeatures {
  journalMode: string;
  fts5: boolean;
}

export interface SqliteStorageOptions {
  path: string; // the database file, normally <store>/memory.db
  busyTimeoutMs?: number;
  scanBudget?: number;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

// What the connection actually provides. Exported so the refusal paths can be tested on
// builds that do have WAL and FTS5.
export function probeFeatures(db: DatabaseSync): SqliteFeatures {
  const mode = db.prepare('PRAGMA journal_mode = WAL').get() as Row | undefined;
  let fts5 = true;
  try {
    db.exec(
      'CREATE VIRTUAL TABLE temp.memorykit_fts5_probe USING fts5(x); DROP TABLE temp.memorykit_fts5_probe;'
    );
  } catch {
    fts5 = false;
  }
  return { journalMode: String(mode?.journal_mode ?? ''), fts5 };
}

export function requireFeatures(features: SqliteFeatures): void {
  if (!features.fts5) {
    throw new StoreUnavailableError('SQLite FTS5 is not available in this Node build', {
      reason: 'fts5_missing',
    });
  }
  if (features.journalMode.toLowerCase() !== 'wal') {
    throw new StoreUnavailableError('The store cannot use WAL journaling', {
      reason: 'wal_unavailable',
      journalMode: features.journalMode,
    });
  }
}

export function isNetworkPath(path: string): boolean {
  return path.startsWith('\\\\') || path.startsWith('//');
}

function sqliteCode(error: unknown): number | null {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' ? code : null;
}

function isBusy(error: unknown): boolean {
  const code = sqliteCode(error);
  return code !== null && ((code & 0xff) === SQLITE_BUSY || (code & 0xff) === SQLITE_LOCKED);
}

// Scope as SQL. LIKE is avoided because "_" is legal in namespaces and is a LIKE wildcard.
function scopeSql(scope: RowScope): { sql: string; params: SQLInputValue[] } {
  if (scope.patterns.includes('*')) return { sql: '1', params: [] };
  if (scope.patterns.length === 0) return { sql: '0', params: [] };
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  for (const pattern of scope.patterns) {
    if (pattern.endsWith('/*')) {
      const base = pattern.slice(0, -2);
      clauses.push('(namespace = ? OR substr(namespace, 1, ?) = ?)');
      params.push(base, base.length + 1, base + '/');
    } else {
      clauses.push('namespace = ?');
      params.push(pattern);
    }
  }
  return { sql: '(' + clauses.join(' OR ') + ')', params };
}

function metadataText(metadata: Record<string, JsonValue>): string {
  const parts: string[] = [];
  const walk = (value: JsonValue): void => {
    if (value === null) return;
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object') Object.values(value).forEach(walk);
    else parts.push(String(value));
  };
  walk(metadata);
  return parts.join(' ');
}

export class SqliteStorage implements StorageProvider {
  readonly descriptor: ProviderDescriptor = {
    id: 'storage-sqlite',
    version: '0.1.0',
    contractVersions: [1],
    capabilities: [],
    limitations: ['local-filesystem-only'],
  };

  private readonly path: string;
  private readonly busyTimeoutMs: number;
  private db: DatabaseSync | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(opts: SqliteStorageOptions) {
    this.path = opts.path;
    this.busyTimeoutMs = opts.busyTimeoutMs ?? 5000;
  }

  async open(): Promise<void> {
    if (this.db) return;
    if (isNetworkPath(this.path)) {
      throw new StoreUnavailableError('The store must be on a local filesystem', {
        reason: 'network_path',
      });
    }
    const { DatabaseSync } = await import('node:sqlite');
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(this.path);
    } catch {
      throw new StoreUnavailableError('The store database cannot be opened', {
        reason: 'open_failed',
      });
    }
    try {
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(this.busyTimeoutMs))}`);
      const version = this.userVersion(db);
      if (version > SCHEMA_VERSION) {
        throw new StoreVersionTooNewError('The store schema is newer than this MemoryKit', {
          found: version,
          supported: SCHEMA_VERSION,
        });
      }
      requireFeatures(probeFeatures(db));
      db.exec('PRAGMA foreign_keys = ON');
      this.migrate(db, version);
    } catch (error) {
      db.close();
      if (error instanceof MemoryKitError) throw error;
      throw new StoreUnavailableError('The store database cannot be opened', {
        reason: 'not_a_store',
      });
    }
    this.db = db;
  }

  async close(): Promise<void> {
    await this.exclusive(async () => {
      this.db?.close();
      this.db = null;
    });
  }

  private userVersion(db: DatabaseSync): number {
    const row = db.prepare('PRAGMA user_version').get() as Row;
    return Number(row.user_version);
  }

  private migrate(db: DatabaseSync, from: number): void {
    if (from === SCHEMA_VERSION) return;
    if (from === 0) {
      const objects = db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .get() as Row;
      if (Number(objects.n) > 0) {
        throw new StoreUnavailableError('The database is not a MemoryKit store', {
          reason: 'foreign_database',
        });
      }
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let version = from; version < SCHEMA_VERSION; version++) db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  private connection(): DatabaseSync {
    if (!this.db) throw new StoreUnavailableError('The store is not open', { reason: 'closed' });
    return this.db;
  }

  // One connection per provider, so every use of it is serialised. A read never observes
  // a write transaction that has not committed.
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  write<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const db = this.connection();
      try {
        db.exec('BEGIN IMMEDIATE');
      } catch (error) {
        if (isBusy(error))
          throw new StoreBusyError('The store is busy', { timeoutMs: this.busyTimeoutMs });
        throw error;
      }
      try {
        const result = await fn(new SqliteTransaction(db));
        db.exec('COMMIT');
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        if (isBusy(error))
          throw new StoreBusyError('The store is busy', { timeoutMs: this.busyTimeoutMs });
        throw error;
      }
    });
  }

  get(id: MemoryId, scope: RowScope): Promise<StoredRow | null> {
    return this.exclusive(async () => loadRow(this.connection(), id, scope));
  }

  supersededBy(ids: MemoryId[]): Promise<Record<MemoryId, MemoryId[]>> {
    return this.exclusive(async () => {
      const result: Record<MemoryId, MemoryId[]> = {};
      for (const id of ids) result[id] = [];
      if (ids.length === 0) return result;
      const rows = this.connection()
        .prepare(
          `SELECT target, source FROM links WHERE type = 'supersedes' AND target IN (${ids.map(() => '?').join(',')}) ORDER BY source`
        )
        .all(...ids) as Row[];
      for (const row of rows) result[String(row.target)]!.push(String(row.source));
      return result;
    });
  }
}

function loadRow(db: DatabaseSync, id: MemoryId, scope: RowScope): StoredRow | null {
  const where = scopeSql(scope);
  const row = db
    .prepare(`SELECT * FROM memories WHERE id = ? AND ${where.sql}`)
    .get(id, ...where.params) as Row | undefined;
  if (!row) return null;
  const links = db
    .prepare('SELECT type, target FROM links WHERE source = ? ORDER BY ordinal')
    .all(id) as Row[];
  return {
    record: {
      id: String(row.id),
      namespace: String(row.namespace),
      key: row.key === null ? null : String(row.key),
      kind: String(row.kind),
      content: String(row.content),
      contentType: String(row.content_type) as ContentType,
      metadata: JSON.parse(String(row.metadata)) as Record<string, JsonValue>,
      links: links.map((link): Link => ({
        type: String(link.type) as LinkType,
        target: String(link.target),
      })),
      state: String(row.state) as MemoryState,
      priorState: row.prior_state === null ? null : (String(row.prior_state) as MemoryState),
      revision: Number(row.revision),
      provenance: JSON.parse(String(row.provenance)) as StoredRow['record']['provenance'],
      actor: String(row.actor),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    },
  };
}

class SqliteTransaction implements StorageTransaction {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async findOperation(principalId: string, operationId: string) {
    const row = this.db
      .prepare(
        'SELECT fingerprint, memory_id, revision, seq FROM operations WHERE principal_id = ? AND operation_id = ?'
      )
      .get(principalId, operationId) as Row | undefined;
    if (!row) return null;
    return {
      fingerprint: String(row.fingerprint),
      memoryId: String(row.memory_id),
      revision: Number(row.revision),
      seq: row.seq === null ? null : Number(row.seq),
    };
  }

  async load(id: MemoryId, scope: RowScope): Promise<StoredRow | null> {
    return loadRow(this.db, id, scope);
  }

  async findByKey(ns: Namespace, key: string): Promise<MemoryId | null> {
    const row = this.db
      .prepare('SELECT id FROM memories WHERE namespace = ? AND key = ?')
      .get(ns, key) as Row | undefined;
    return row ? String(row.id) : null;
  }

  async namespacePolicy(ns: Namespace, defaultPolicy: HistoryPolicy): Promise<HistoryPolicy> {
    const row = this.db.prepare('SELECT history_policy FROM namespaces WHERE name = ?').get(ns) as
      Row | undefined;
    if (row) return String(row.history_policy) as HistoryPolicy;
    this.db
      .prepare('INSERT INTO namespaces (name, history_policy, created_at) VALUES (?, ?, ?)')
      .run(ns, defaultPolicy, new Date().toISOString());
    return defaultPolicy;
  }

  async commit(
    batch: WriteBatch,
    expected: { id: MemoryId; revision: number | null }[]
  ): Promise<{ seqs: number[] }> {
    const db = this.db;
    for (const { id, revision } of expected) {
      const row = db.prepare('SELECT revision FROM memories WHERE id = ?').get(id) as
        Row | undefined;
      const current = row ? Number(row.revision) : null;
      if (revision === null && current !== null) {
        throw new InternalError('A new memory id is already in use', { id });
      }
      if (revision !== null && current !== revision) {
        if (current === null) throw new InternalError('An expected memory is missing', { id });
        throw new RevisionConflictError('The memory has changed since it was read', {
          id,
          currentRevision: current,
        });
      }
    }

    const inserted = new Set(
      expected.filter((item) => item.revision === null).map((item) => item.id)
    );
    for (const { record } of batch.rows) {
      const values: SQLInputValue[] = [
        record.namespace,
        record.key,
        record.kind,
        record.content,
        record.contentType,
        JSON.stringify(record.metadata),
        JSON.stringify(record.provenance),
        record.state,
        record.priorState,
        record.revision,
        record.actor,
        record.createdAt,
        record.updatedAt,
      ];
      try {
        if (inserted.has(record.id)) {
          db.prepare(
            `INSERT INTO memories (namespace, key, kind, content, content_type, metadata, provenance, state,
               prior_state, revision, actor, created_at, updated_at, id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(...values, record.id);
        } else {
          db.prepare(
            `UPDATE memories SET namespace = ?, key = ?, kind = ?, content = ?, content_type = ?, metadata = ?,
               provenance = ?, state = ?, prior_state = ?, revision = ?, actor = ?, created_at = ?, updated_at = ?
             WHERE id = ?`
          ).run(...values, record.id);
        }
      } catch (error) {
        if (sqliteCode(error) === SQLITE_CONSTRAINT_UNIQUE && record.key !== null) {
          const existing = await this.findByKey(record.namespace, record.key);
          throw new AlreadyExistsError('The key is already taken in this namespace', {
            namespace: record.namespace,
            key: record.key,
            id: existing,
          });
        }
        throw error;
      }
      db.prepare('DELETE FROM links WHERE source = ?').run(record.id);
      const link = db.prepare(
        'INSERT INTO links (source, type, target, ordinal) VALUES (?, ?, ?, ?)'
      );
      record.links.forEach((item, ordinal) => link.run(record.id, item.type, item.target, ordinal));
      db.prepare('DELETE FROM memories_fts WHERE id = ?').run(record.id);
      db.prepare(
        'INSERT INTO memories_fts (id, kind, content, metadata_text) VALUES (?, ?, ?, ?)'
      ).run(record.id, record.kind, record.content, metadataText(record.metadata));
    }

    const seqs: number[] = [];
    const outbox = db.prepare(
      `INSERT INTO outbox (operation_id, memory_id, revision, operation, actor, at, namespace, policy, payload, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    );
    for (const entry of batch.outbox) {
      const result = outbox.run(
        entry.operationId,
        entry.memoryId,
        entry.revision,
        entry.operation,
        entry.actor,
        entry.at,
        entry.namespace,
        entry.policy,
        entry.payload === null ? null : JSON.stringify(entry.payload)
      );
      seqs.push(Number(result.lastInsertRowid));
    }

    const op = batch.operation;
    db.prepare(
      `INSERT INTO operations (principal_id, operation_id, fingerprint, memory_id, revision, seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      op.principalId,
      op.operationId,
      op.fingerprint,
      op.memoryId,
      op.revision,
      seqs.length > 0 ? seqs[seqs.length - 1]! : null,
      new Date().toISOString()
    );
    return { seqs };
  }
}
