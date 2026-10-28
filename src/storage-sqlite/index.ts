import { randomBytes } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Grant, Principal } from '../access/index.ts';
import type {
  HistoryPolicy,
  HistoryQueue,
  HistoryStatus,
  NamespaceInfo,
  OperationStatus,
  OutboxEntry,
  ProviderDescriptor,
  PurgeOutcome,
  PurgeRequest,
  RowScope,
  StorageProvider,
  StorageRetrieve,
  StorageSearch,
  StorageTransaction,
  StoredOutcome,
  StoredRow,
  TokenInfo,
  TokenStore,
  WriteBatch,
} from '../contracts/index.ts';
import {
  AlreadyExistsError,
  IdempotencyMismatchError,
  InternalError,
  MemoryKitError,
  NotFoundError,
  RevisionConflictError,
  StoreBusyError,
  StoreUnavailableError,
  StoreVersionTooNewError,
  ValidationFailedError,
  MAX_RETRIEVE_BYTES,
  canonicalJson,
  metadataText,
  retrievedItem,
  searchTerms,
  sha256Hex,
  type ContentType,
  type JsonValue,
  type Link,
  type LinkType,
  type MemoryId,
  type MemoryState,
  type MemoryRecord,
  type Namespace,
  type Operation,
  type RetrieveResult,
  type RetrieveSource,
  type RetrievedItem,
  type SearchResult,
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

const DEFAULT_SCAN_BUDGET = 10_000;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CONSTRAINT_UNIQUE = 2067;
// The history_ref of an outbox entry a purge discarded before it was exported.
const DISCARDED = 'discarded';

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

// Each word is quoted, so the text never reaches FTS5 as query syntax; the words are ANDed.
function ftsQuery(text: string): string {
  return searchTerms(text)
    .map((term) => '"' + term.replaceAll('"', '""') + '"')
    .join(' ');
}

// A cursor holds the last row a page examined, as its sort key and id, and the fingerprint of
// the query it belongs to.
interface Cursor {
  v: 1;
  key: number | string; // bm25 rank with text, otherwise updatedAt
  id: MemoryId;
  query: string;
}

function searchFingerprint(query: StorageSearch): string {
  return sha256Hex(
    canonicalJson({
      text: query.text ?? null,
      kinds: [...(query.kinds ?? [])].sort(),
      states: [...query.states].sort(),
      metadata: query.metadata ?? {},
      patterns: [...query.patterns].sort(),
    })
  );
}

// A retrieve cursor belongs to retrieve, so it cannot page a search.
function retrieveFingerprint(query: StorageRetrieve): string {
  return sha256Hex(canonicalJson({ operation: 'retrieve', search: searchFingerprint(query) }));
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(text: string, fingerprint: string, keyType: 'number' | 'string'): Cursor {
  let cursor: Partial<Cursor> | null = null;
  try {
    cursor = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Partial<Cursor>;
  } catch {
    // reported below
  }
  if (
    cursor === null ||
    typeof cursor !== 'object' ||
    cursor.v !== 1 ||
    typeof cursor.key !== keyType ||
    typeof cursor.id !== 'string' ||
    cursor.query !== fingerprint
  ) {
    throw new ValidationFailedError('Invalid cursor: invalid_cursor', {
      field: 'cursor',
      reason: 'invalid_cursor',
    });
  }
  return cursor as Cursor;
}

function matchesMetadata(row: Row, wanted: StorageSearch['metadata']): boolean {
  if (wanted === undefined) return true;
  const metadata = JSON.parse(String(row.metadata)) as Record<string, JsonValue>;
  return Object.entries(wanted).every(
    ([key, value]) => Object.hasOwn(metadata, key) && metadata[key] === value
  );
}

// The rows a search examines, in its order, from the row after the cursor. Without text they
// are newest first, keyed by updatedAt; with text they are by BM25 rank, keyed by rank.
function scanSql(
  query: StorageSearch,
  fingerprint: string
): { sql: string; params: SQLInputValue[]; text: string | null } {
  const text = query.text === undefined ? null : ftsQuery(query.text);
  const cursor =
    query.cursor === undefined
      ? null
      : decodeCursor(query.cursor, fingerprint, text === null ? 'string' : 'number');
  const scope = scopeSql(query);
  const where = [scope.sql, `state IN (${query.states.map(() => '?').join(',')})`];
  const params: SQLInputValue[] = [...scope.params, ...query.states];
  if (query.kinds !== undefined) {
    where.push(`kind IN (${query.kinds.map(() => '?').join(',')})`);
    params.push(...query.kinds);
  }
  let sql: string;
  if (text === null) {
    if (cursor) {
      where.push('(updated_at < ? OR (updated_at = ? AND id > ?))');
      params.push(cursor.key, cursor.key, cursor.id);
    }
    sql = `SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id`;
  } else {
    if (cursor) {
      where.push('(rank > ? OR (rank = ? AND id > ?))');
      params.push(cursor.key, cursor.key, cursor.id);
    }
    params.unshift(text);
    sql =
      'SELECT * FROM (SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts ' +
      'JOIN memories m ON m.id = memories_fts.id WHERE memories_fts MATCH ?) ' +
      `WHERE ${where.join(' AND ')} ORDER BY rank, id`;
  }
  return { sql, params, text };
}

function nextCursor(
  last: Row | null,
  text: string | null,
  fingerprint: string,
  stopped: boolean
): string | null {
  if (!stopped || last === null) return null;
  return encodeCursor({
    v: 1,
    key: text === null ? String(last.updated_at) : Number(last.rank),
    id: String(last.id),
    query: fingerprint,
  });
}

// What the result costs besides its items: the envelope with a cursor and a partial reason.
// A cursor is about 200 bytes, so 512 leaves room. Each item adds its comma separately.
const ENVELOPE_BYTES = 512;

export class SqliteStorage implements StorageProvider, TokenStore {
  readonly descriptor: ProviderDescriptor = {
    id: 'storage-sqlite',
    version: '0.1.0',
    contractVersions: [1],
    capabilities: ['search.lexical', 'retrieve.lexical', 'purge.current'],
    limitations: ['local-filesystem-only'],
  };

  private readonly path: string;
  private readonly busyTimeoutMs: number;
  private readonly scanBudget: number;
  private db: DatabaseSync | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(opts: SqliteStorageOptions) {
    this.path = opts.path;
    this.busyTimeoutMs = opts.busyTimeoutMs ?? 5000;
    this.scanBudget = Math.max(1, Math.floor(opts.scanBudget ?? DEFAULT_SCAN_BUDGET));
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

  // Tokens. The secret is random and only its SHA-256 is stored, so a lookup by hash
  // compares nothing a caller controls against a stored secret.
  issue(principalId: string, grants: Grant[]): Promise<{ tokenId: string; secret: string }> {
    const tokenId = 'tok_' + randomBytes(12).toString('hex');
    const secret = 'mk_' + randomBytes(32).toString('base64url');
    return this.immediate((db) => {
      db.prepare(
        'INSERT INTO tokens (token_id, principal_id, grants, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(
        tokenId,
        principalId,
        JSON.stringify(grants),
        sha256Hex(secret),
        new Date().toISOString()
      );
      return { tokenId, secret };
    });
  }

  verify(secret: string): Promise<Principal | null> {
    return this.read((db) => {
      const row = db
        .prepare(
          'SELECT principal_id, grants FROM tokens WHERE secret_hash = ? AND revoked_at IS NULL'
        )
        .get(sha256Hex(secret)) as Row | undefined;
      if (!row) return null;
      return {
        id: String(row.principal_id),
        profile: 'local',
        grants: JSON.parse(String(row.grants)) as Grant[],
      };
    });
  }

  // Revoking a token twice is not an error; the first revocation time is kept.
  revoke(tokenId: string): Promise<void> {
    return this.immediate((db) => {
      const row = db.prepare('SELECT revoked_at FROM tokens WHERE token_id = ?').get(tokenId) as
        Row | undefined;
      if (!row) throw new NotFoundError('Token not found', { tokenId });
      if (row.revoked_at === null) {
        db.prepare('UPDATE tokens SET revoked_at = ? WHERE token_id = ?').run(
          new Date().toISOString(),
          tokenId
        );
      }
    });
  }

  list(): Promise<TokenInfo[]> {
    return this.read((db) =>
      (
        db
          .prepare(
            'SELECT token_id, principal_id, grants, created_at, revoked_at FROM tokens ORDER BY created_at, token_id'
          )
          .all() as Row[]
      ).map((row) => ({
        tokenId: String(row.token_id),
        principalId: String(row.principal_id),
        grants: JSON.parse(String(row.grants)) as Grant[],
        createdAt: String(row.created_at),
        revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
      }))
    );
  }

  write<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    return this.immediate((db) => fn(new SqliteTransaction(db)));
  }

  get(id: MemoryId, scope: RowScope): Promise<StoredRow | null> {
    return this.read((db) => loadRow(db, id, scope));
  }

  supersededBy(ids: MemoryId[], scope: RowScope): Promise<Record<MemoryId, MemoryId[]>> {
    return this.read((db) => supersededBy(db, ids, scope));
  }

  // Rows outside the scope, the states and the kinds are filtered by the query itself; the
  // metadata filter runs on the rows it returns, and every row it examines counts towards the
  // scan budget. A page that stops at the budget is partial, and its cursor resumes after the
  // last row it examined.
  search(query: StorageSearch): Promise<SearchResult> {
    return this.read((db) => {
      const fingerprint = searchFingerprint(query);
      const { sql, params, text } = scanSql(query, fingerprint);
      const rows: Row[] = [];
      let last: Row | null = null;
      let scanned = 0;
      let more = false;
      let partial = false;
      for (const row of db.prepare(sql).iterate(...params) as Iterable<Row>) {
        if (scanned === this.scanBudget) {
          partial = true;
          break;
        }
        scanned++;
        const matches = matchesMetadata(row, query.metadata);
        if (matches && rows.length === query.limit) {
          more = true;
          break;
        }
        last = row;
        if (matches) rows.push(row);
      }

      const derived = supersededBy(
        db,
        rows.map((row) => String(row.id)),
        { patterns: query.readable }
      );
      const items: MemoryRecord[] = rows.map((row) => ({
        ...toRecord(db, row),
        supersededBy: derived[String(row.id)]!,
      }));
      const cursor = nextCursor(last, text, fingerprint, more || partial);
      return partial
        ? { items, nextCursor: cursor, completeness: 'partial', partialReason: 'scan_budget' }
        : { items, nextCursor: cursor, completeness: 'complete' };
    });
  }

  // Search's scan, with each matching row projected to a compact item. A page also stops
  // before an item that would take the serialized result past MAX_RETRIEVE_BYTES, and its
  // cursor resumes at that item. The largest possible item is about 25 KiB, so a page always
  // holds at least one.
  retrieve(query: StorageRetrieve): Promise<RetrieveResult> {
    return this.read((db) => {
      const fingerprint = retrieveFingerprint(query);
      const { sql, params, text } = scanSql(query, fingerprint);
      const items: RetrievedItem[] = [];
      let used = ENVELOPE_BYTES;
      let last: Row | null = null;
      let scanned = 0;
      let more = false;
      let partial = false;
      for (const row of db.prepare(sql).iterate(...params) as Iterable<Row>) {
        if (scanned === this.scanBudget) {
          partial = true;
          break;
        }
        scanned++;
        const matches = matchesMetadata(row, query.metadata);
        if (matches && items.length === query.limit) {
          more = true;
          break;
        }
        if (matches) {
          const id = String(row.id);
          const replacements = supersededBy(db, [id], { patterns: query.readable })[id]!;
          const item = retrievedItem(
            toSource(row),
            replacements,
            Number(row.rank),
            query.text,
            query.excerptChars
          );
          const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
          if (used + size > MAX_RETRIEVE_BYTES) {
            more = true;
            break;
          }
          used += size;
          items.push(item);
        }
        last = row;
      }
      const cursor = nextCursor(last, text, fingerprint, more || partial);
      return partial
        ? { items, nextCursor: cursor, completeness: 'partial', partialReason: 'scan_budget' }
        : { items, nextCursor: cursor, completeness: 'complete' };
    });
  }

  // An operation's entries were queued together, so they are the run of rows ending at its
  // seq; the operation reports the worst of them and the last exported one's ref.
  operation(principalId: string, operationId: string): Promise<OperationStatus | null> {
    return this.read((db) => {
      const row = db
        .prepare(
          `SELECT operation_id, memory_id, revision, seq FROM operations
           WHERE principal_id = ? AND operation_id = ?`
        )
        .get(principalId, operationId) as Row | undefined;
      if (!row) return null;
      const statuses = new Set<string>();
      let historyRef: string | null = null;
      if (row.seq !== null) {
        const entries = db
          .prepare(
            'SELECT operation_id, actor, status, history_ref FROM outbox WHERE seq <= ? ORDER BY seq DESC'
          )
          .iterate(Number(row.seq)) as Iterable<Row>;
        for (const entry of entries) {
          if (entry.operation_id !== operationId || entry.actor !== principalId) break;
          // An entry a purge discarded never reaches history.
          if (entry.history_ref === DISCARDED) continue;
          statuses.add(String(entry.status));
          if (historyRef === null && entry.history_ref !== null) {
            historyRef = String(entry.history_ref);
          }
        }
      }
      const history: HistoryStatus = statuses.has('blocked')
        ? 'blocked'
        : statuses.has('pending')
          ? 'pending'
          : statuses.has('exported')
            ? 'persisted'
            : 'not_required';
      return {
        operationId: String(row.operation_id),
        memoryId: String(row.memory_id),
        revision: Number(row.revision),
        storage: 'persisted',
        history,
        historyRef: history === 'persisted' ? historyRef : null,
      };
    });
  }

  purge(id: MemoryId, scope: RowScope, request: PurgeRequest): Promise<PurgeOutcome> {
    return this.immediate((db) => {
      const { principalId, operationId } = request;
      const prior = db
        .prepare(
          `SELECT o.fingerprint, p.namespace, p.report FROM operations o
           LEFT JOIN purges p ON p.memory_id = o.memory_id AND p.operation_id = o.operation_id
             AND p.principal_id = o.principal_id
           WHERE o.principal_id = ? AND o.operation_id = ?`
        )
        .get(principalId, operationId) as Row | undefined;
      if (prior) {
        if (prior.fingerprint !== request.fingerprint || prior.report === null) {
          throw new IdempotencyMismatchError('The operation id was used for a different request', {
            operationId,
          });
        }
        const facts = JSON.parse(String(prior.report)) as Omit<
          PurgeOutcome,
          'namespace' | 'replayed'
        >;
        return { namespace: String(prior.namespace), ...facts, replayed: true };
      }

      const current = loadRow(db, id, scope);
      if (!current) throw new NotFoundError('Memory not found', { id });
      const { namespace, revision } = current.record;
      if (revision !== request.expectedRevision) {
        throw new RevisionConflictError('The memory has changed since it was read', {
          id,
          currentRevision: revision,
        });
      }

      // The memory's entries not yet exported keep no snapshot and are never exported.
      const pendingDiscarded = Number(
        db
          .prepare(
            `UPDATE outbox SET status = 'exported', history_ref = ?, payload = NULL, last_error = NULL
             WHERE memory_id = ? AND status IN ('pending', 'blocked')`
          )
          .run(DISCARDED, id).changes
      );
      // History is told of the purge when it may hold the memory: its namespace keeps
      // history, or an earlier revision was exported under another policy.
      const policyRow = db
        .prepare('SELECT history_policy FROM namespaces WHERE name = ?')
        .get(namespace) as Row | undefined;
      const policy = policyRow ? (String(policyRow.history_policy) as HistoryPolicy) : 'none';
      const exported = db
        .prepare(
          "SELECT 1 FROM outbox WHERE memory_id = ? AND status = 'exported' AND history_ref IS NOT ? LIMIT 1"
        )
        .get(id, DISCARDED);
      const queued = request.queueHistory && (policy !== 'none' || exported !== undefined);

      db.prepare('DELETE FROM links WHERE source = ?').run(id);
      db.prepare('DELETE FROM memories_fts WHERE id = ?').run(id);
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);

      let seq: number | null = null;
      if (queued) {
        const result = db
          .prepare(
            `INSERT INTO outbox (operation_id, memory_id, revision, operation, actor, at, namespace, policy, payload, status)
             VALUES (?, ?, ?, 'purge', ?, ?, ?, ?, NULL, 'pending')`
          )
          .run(
            operationId,
            id,
            revision + 1,
            principalId,
            request.at,
            namespace,
            policy === 'none' ? 'metadata' : policy
          );
        seq = Number(result.lastInsertRowid);
      }
      db.prepare(
        `INSERT INTO operations (principal_id, operation_id, fingerprint, memory_id, revision, seq, created_at, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
      ).run(principalId, operationId, request.fingerprint, id, revision + 1, seq, request.at);

      // Outcomes kept for replays hold copies of the record; none may outlive the purge.
      const mentions = db
        .prepare(
          `SELECT principal_id, operation_id, outcome FROM operations
           WHERE outcome IS NOT NULL AND instr(outcome, ?) > 0`
        )
        .all(JSON.stringify(id)) as Row[];
      const rewrite = db.prepare(
        'UPDATE operations SET outcome = ? WHERE principal_id = ? AND operation_id = ?'
      );
      for (const row of mentions) {
        const outcome = JSON.parse(String(row.outcome)) as StoredOutcome;
        const kept =
          outcome.memory.id === id
            ? null
            : JSON.stringify({ ...outcome, related: outcome.related.filter((r) => r.id !== id) });
        rewrite.run(kept, String(row.principal_id), String(row.operation_id));
      }

      const facts = { pendingDiscarded, queued };
      db.prepare(
        `INSERT INTO purges (memory_id, namespace, principal_id, operation_id, at, report)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, namespace, principalId, operationId, request.at, JSON.stringify(facts));
      return { namespace, ...facts, replayed: false };
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
          "SELECT history_ref FROM outbox WHERE status = 'exported' AND history_ref IS NOT ? ORDER BY seq DESC LIMIT 1"
        )
        .get(DISCARDED) as Row | undefined;
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
      const oldest = db
        .prepare("SELECT last_error FROM outbox WHERE status = 'pending' ORDER BY seq LIMIT 1")
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
        lastError: oldest?.last_error == null ? null : errorCode(oldest.last_error),
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

// With a scope, only sources in it: reads pass the caller's, and the history payload, which
// records the whole relationship, passes none.
function supersededBy(
  db: DatabaseSync,
  ids: MemoryId[],
  scope?: RowScope
): Record<MemoryId, MemoryId[]> {
  const result: Record<MemoryId, MemoryId[]> = {};
  for (const id of ids) result[id] = [];
  if (ids.length === 0) return result;
  const where = scope === undefined ? { sql: '1', params: [] } : scopeSql(scope);
  const rows = db
    .prepare(
      `SELECT l.target, l.source FROM links l JOIN memories m ON m.id = l.source
       WHERE l.type = 'supersedes' AND l.target IN (${ids.map(() => '?').join(',')}) AND ${where.sql}
       ORDER BY l.source`
    )
    .all(...ids, ...where.params) as Row[];
  for (const row of rows) result[String(row.target)]!.push(String(row.source));
  return result;
}

function loadRow(db: DatabaseSync, id: MemoryId, scope: RowScope): StoredRow | null {
  const where = scopeSql(scope);
  const row = db
    .prepare(`SELECT * FROM memories WHERE id = ? AND ${where.sql}`)
    .get(id, ...where.params) as Row | undefined;
  if (!row) return null;
  return { record: toRecord(db, row) };
}

function toSource(row: Row): RetrieveSource {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    namespace: String(row.namespace),
    key: row.key === null ? null : String(row.key),
    kind: String(row.kind),
    state: String(row.state) as MemoryState,
    updatedAt: String(row.updated_at),
    content: String(row.content),
    metadata: JSON.parse(String(row.metadata)) as Record<string, JsonValue>,
    provenance: JSON.parse(String(row.provenance)) as RetrieveSource['provenance'],
  };
}

function toRecord(db: DatabaseSync, row: Row): StoredRow['record'] {
  const links = db
    .prepare('SELECT type, target FROM links WHERE source = ? ORDER BY ordinal')
    .all(String(row.id)) as Row[];
  return {
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
