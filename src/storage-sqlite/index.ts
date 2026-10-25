import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  HistoryPolicy,
  HistoryQueue,
  HistoryStatus,
  NamespaceInfo,
  OperationStatus,
  OutboxEntry,
  ProviderDescriptor,
  RowScope,
  StorageProvider,
  StorageTransaction,
  StoredOutcome,
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
  type Operation,
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

// SQLite primary result codes the storage maps to contract errors.
const UNAVAILABLE: Record<number, string> = {
  8: 'read_only',
  10: 'io_error',
  11: 'not_a_store',
  13: 'disk_full',
  14: 'open_failed',
  26: 'not_a_store',
};

// Maps a SQLite failure to the contract's codes. Anything else is rethrown unless the caller
// names a fallback reason, so an invariant violation still surfaces as Internal.
function storageError(error: unknown, timeoutMs: number, fallback?: string): unknown {
  if (error instanceof MemoryKitError) return error;
  if (isBusy(error)) return new StoreBusyError('The store is busy', { timeoutMs });
  const code = sqliteCode(error);
  const reason = (code === null ? undefined : UNAVAILABLE[code & 0xff]) ?? fallback;
  if (reason === undefined) return error;
  return new StoreUnavailableError('The store cannot be used', { reason });
}

function requireStore(db: DatabaseSync, version: number): void {
  if (version > SCHEMA_VERSION) {
    throw new StoreVersionTooNewError('The store schema is newer than this MemoryKit', {
      found: version,
      supported: SCHEMA_VERSION,
    });
  }
  if (version > 0) return;
  const objects = db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .get() as Row;
  if (Number(objects.n) > 0) {
    throw new StoreUnavailableError('The database is not a MemoryKit store', {
      reason: 'foreign_database',
    });
  }
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
      // Refuse a foreign or newer database before anything changes it.
      requireStore(db, this.userVersion(db));
      requireFeatures(probeFeatures(db));
      db.exec('PRAGMA foreign_keys = ON');
      this.migrate(db);
    } catch (error) {
      db.close();
      throw storageError(error, this.busyTimeoutMs, 'not_a_store');
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

  // The version is read again under the write lock, so concurrent first opens of a new
  // store migrate it once.
  private migrate(db: DatabaseSync): void {
    if (this.userVersion(db) === SCHEMA_VERSION) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      const from = this.userVersion(db);
      requireStore(db, from);
      for (let version = from; version < SCHEMA_VERSION; version++) db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
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

  // One write transaction, with the write lock taken up front so it never fails part way
  // through on a lock upgrade.
  private immediate<T>(fn: (db: DatabaseSync) => Promise<T> | T): Promise<T> {
    return this.exclusive(async () => {
      const db = this.connection();
      try {
        db.exec('BEGIN IMMEDIATE');
      } catch (error) {
        throw storageError(error, this.busyTimeoutMs);
      }
      try {
        const result = await fn(db);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw storageError(error, this.busyTimeoutMs);
      }
    });
  }

  private read<T>(fn: (db: DatabaseSync) => T): Promise<T> {
    return this.exclusive(async () => {
      try {
        return fn(this.connection());
      } catch (error) {
        throw storageError(error, this.busyTimeoutMs);
      }
    });
  }

  write<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    return this.immediate((db) => fn(new SqliteTransaction(db)));
  }

  get(id: MemoryId, scope: RowScope): Promise<StoredRow | null> {
    return this.read((db) => loadRow(db, id, scope));
  }

  supersededBy(ids: MemoryId[]): Promise<Record<MemoryId, MemoryId[]>> {
    return this.read((db) => supersededBy(db, ids));
  }

  operation(principalId: string, operationId: string): Promise<OperationStatus | null> {
    return this.read((db) => {
      const row = db
        .prepare(
          `SELECT o.operation_id, o.memory_id, o.revision, x.status, x.history_ref
           FROM operations o LEFT JOIN outbox x ON x.seq = o.seq
           WHERE o.principal_id = ? AND o.operation_id = ?`
        )
        .get(principalId, operationId) as Row | undefined;
      if (!row) return null;
      const history: HistoryStatus =
        row.status === 'exported'
          ? 'persisted'
          : row.status === 'pending' || row.status === 'blocked'
            ? row.status
            : 'not_required';
      return {
        operationId: String(row.operation_id),
        memoryId: String(row.memory_id),
        revision: Number(row.revision),
        storage: 'persisted',
        history,
        historyRef: history === 'persisted' ? String(row.history_ref) : null,
      };
    });
  }

  pruneOperations(before: string): Promise<number> {
    return this.immediate((db) =>
      Number(db.prepare('DELETE FROM operations WHERE created_at < ?').run(before).changes)
    );
  }

  setNamespacePolicy(ns: Namespace, policy: HistoryPolicy): Promise<NamespaceInfo> {
    return this.immediate((db) => {
      db.prepare(
        `INSERT INTO namespaces (name, history_policy, created_at) VALUES (?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET history_policy = excluded.history_policy`
      ).run(ns, policy, new Date().toISOString());
      return { name: ns, historyPolicy: policy };
    });
  }

  getNamespace(ns: Namespace): Promise<NamespaceInfo | null> {
    return this.read((db) => {
      const row = db.prepare('SELECT history_policy FROM namespaces WHERE name = ?').get(ns) as
        Row | undefined;
      return row ? { name: ns, historyPolicy: String(row.history_policy) as HistoryPolicy } : null;
    });
  }

  // Taken when nobody else holds a live lease. Every grant gets a new fencing token, so a
  // holder whose lease expired and was taken over can no longer mark entries.
  acquireDrainLease(holder: string, ttlMs: number): Promise<{ token: number } | null> {
    return this.immediate((db) => {
      const now = Date.now();
      const row = db
        .prepare('SELECT holder, token, expires_at FROM drain_lease WHERE id = 1')
        .get() as Row | undefined;
      if (row && row.holder !== null && row.holder !== holder && Number(row.expires_at) > now) {
        return null;
      }
      const token = (row ? Number(row.token) : 0) + 1;
      db.prepare(
        `INSERT INTO drain_lease (id, holder, token, expires_at) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, token = excluded.token,
           expires_at = excluded.expires_at`
      ).run(holder, token, now + Math.max(0, Math.floor(ttlMs)));
      return { token };
    });
  }

  releaseDrainLease(leaseToken: number): Promise<void> {
    return this.immediate((db) => {
      db.prepare(
        'UPDATE drain_lease SET holder = NULL, expires_at = 0 WHERE id = 1 AND token = ?'
      ).run(leaseToken);
    });
  }

  // A blocked entry stops the queue: nothing after it is exported until it is unblocked.
  nextOutbox(): Promise<
    (OutboxEntry & { attempts: number }) | { blocked: OutboxEntry; error: string } | null
  > {
    return this.read((db) => {
      const blocked = db
        .prepare("SELECT * FROM outbox WHERE status = 'blocked' ORDER BY seq LIMIT 1")
        .get() as Row | undefined;
      if (blocked) return { blocked: outboxEntry(blocked), error: errorCode(blocked.last_error) };
      const next = db
        .prepare("SELECT * FROM outbox WHERE status = 'pending' ORDER BY seq LIMIT 1")
        .get() as Row | undefined;
      return next ? { ...outboxEntry(next), attempts: Number(next.attempts) } : null;
    });
  }

  lastExportedRef(): Promise<string | null> {
    return this.read((db) => {
      const row = db
        .prepare(
          "SELECT history_ref FROM outbox WHERE status = 'exported' ORDER BY seq DESC LIMIT 1"
        )
        .get() as Row | undefined;
      return row ? String(row.history_ref) : null;
    });
  }

  // An exported entry keeps its row, without the snapshot.
  markExported(seq: number, historyRef: string, leaseToken: number): Promise<boolean> {
    return this.immediate((db) => {
      if (!holdsLease(db, leaseToken)) return false;
      db.prepare(
        `UPDATE outbox SET status = 'exported', history_ref = ?, payload = NULL, last_error = NULL
         WHERE seq = ? AND status = 'pending'`
      ).run(historyRef, seq);
      return true;
    });
  }

  markFailed(
    seq: number,
    error: { code: string; message: string },
    block: boolean,
    leaseToken: number
  ): Promise<boolean> {
    return this.immediate((db) => {
      if (!holdsLease(db, leaseToken)) return false;
      db.prepare(
        `UPDATE outbox SET attempts = attempts + 1, last_error = ?,
           status = CASE WHEN ? THEN 'blocked' ELSE status END
         WHERE seq = ? AND status = 'pending'`
      ).run(JSON.stringify(error), block ? 1 : 0, seq);
      return true;
    });
  }

  unblock(): Promise<number> {
    return this.immediate((db) =>
      Number(
        db
          .prepare("UPDATE outbox SET status = 'pending', attempts = 0 WHERE status = 'blocked'")
          .run().changes
      )
    );
  }

  queue(): Promise<HistoryQueue> {
    return this.read((db) => {
      const pending = db
        .prepare("SELECT count(*) AS n FROM outbox WHERE status = 'pending'")
        .get() as Row;
      const blocked = db
        .prepare(
          "SELECT seq, operation_id, last_error FROM outbox WHERE status = 'blocked' ORDER BY seq LIMIT 1"
        )
        .get() as Row | undefined;
      return {
        pending: Number(pending.n),
        blocked: blocked
          ? {
              seq: Number(blocked.seq),
              operationId: String(blocked.operation_id),
              error: errorCode(blocked.last_error),
            }
          : null,
      };
    });
  }
}

function holdsLease(db: DatabaseSync, leaseToken: number): boolean {
  const row = db.prepare('SELECT token FROM drain_lease WHERE id = 1').get() as Row | undefined;
  return row !== undefined && Number(row.token) === leaseToken;
}

function errorCode(text: unknown): string {
  if (typeof text !== 'string') return 'unknown';
  try {
    const code = (JSON.parse(text) as { code?: unknown }).code;
    return typeof code === 'string' ? code : 'unknown';
  } catch {
    return 'unknown';
  }
}

function outboxEntry(row: Row): OutboxEntry {
  return {
    seq: Number(row.seq),
    operationId: String(row.operation_id),
    memoryId: String(row.memory_id),
    revision: Number(row.revision),
    operation: String(row.operation) as Operation,
    actor: String(row.actor),
    at: String(row.at),
    namespace: String(row.namespace),
    policy: String(row.policy) as OutboxEntry['policy'],
    payload:
      row.payload === null ? null : (JSON.parse(String(row.payload)) as OutboxEntry['payload']),
  };
}

function supersededBy(db: DatabaseSync, ids: MemoryId[]): Record<MemoryId, MemoryId[]> {
  const result: Record<MemoryId, MemoryId[]> = {};
  for (const id of ids) result[id] = [];
  if (ids.length === 0) return result;
  const rows = db
    .prepare(
      `SELECT target, source FROM links WHERE type = 'supersedes' AND target IN (${ids.map(() => '?').join(',')}) ORDER BY source`
    )
    .all(...ids) as Row[];
  for (const row of rows) result[String(row.target)]!.push(String(row.source));
  return result;
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
        'SELECT fingerprint, memory_id, revision, seq, outcome FROM operations WHERE principal_id = ? AND operation_id = ?'
      )
      .get(principalId, operationId) as Row | undefined;
    if (!row) return null;
    return {
      fingerprint: String(row.fingerprint),
      memoryId: String(row.memory_id),
      revision: Number(row.revision),
      seq: row.seq === null ? null : Number(row.seq),
      outcome: row.outcome === null ? null : (JSON.parse(String(row.outcome)) as StoredOutcome),
    };
  }

  async load(id: MemoryId, scope: RowScope): Promise<StoredRow | null> {
    return loadRow(this.db, id, scope);
  }

  async supersededBy(ids: MemoryId[]): Promise<Record<MemoryId, MemoryId[]>> {
    return supersededBy(this.db, ids);
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
      `INSERT INTO operations (principal_id, operation_id, fingerprint, memory_id, revision, seq, created_at, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      op.principalId,
      op.operationId,
      op.fingerprint,
      op.memoryId,
      op.revision,
      seqs.length > 0 ? seqs[seqs.length - 1]! : null,
      new Date().toISOString(),
      JSON.stringify(op.outcome)
    );
    return { seqs };
  }
}
