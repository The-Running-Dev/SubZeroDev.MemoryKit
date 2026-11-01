// Shared deterministic storage contracts; each backend owns atomic persistence.
import { randomBytes } from 'node:crypto';
import type { Grant, Principal } from '../access/index.ts';
import type {
  HistoryPolicy,
  NamespaceInfo,
  OutboxEntry,
  PurgeRequest,
  RowScope,
  StorageProvider,
  StorageSnapshot,
  StorageRetrieve,
  StorageSearch,
  StorageTransaction,
  StoredOutcome,
  StoredRow,
  TokenInfo,
  TokenStore,
} from '../contracts/index.ts';
import {
  AlreadyExistsError,
  IdempotencyMismatchError,
  InternalError,
  NotFoundError,
  RevisionConflictError,
  StoreBusyError,
  StoreUnavailableError,
  ValidationFailedError,
  canonicalJson,
  matchesPattern,
  metadataText,
  retrievedItem,
  searchTerms,
  sha256Hex,
  MAX_RETRIEVE_BYTES,
} from '../model/index.ts';

export type RecordRow = StoredRow['record'];
type Entry = OutboxEntry & {
  status: 'pending' | 'blocked' | 'exported';
  attempts: number;
  ref: string | null;
  error: string | null;
};
type Op = {
  principalId: string;
  operationId: string;
  fingerprint: string;
  memoryId: string;
  revision: number;
  seq: number | null;
  outcome: StoredOutcome | null;
  at: string;
  purge?: { namespace: string; pendingDiscarded: number; queued: boolean };
};
export interface State {
  version: 1;
  files: Record<string, string>;
  operations: Op[];
  namespaces: NamespaceInfo[];
  outbox: Entry[];
  sequence: number;
  tokens: (TokenInfo & { hash: string })[];
  lease: { holder: string | null; token: number; expires: number };
}
export const emptyState = (): State => ({
  version: 1,
  files: {},
  operations: [],
  namespaces: [],
  outbox: [],
  sequence: 0,
  tokens: [],
  lease: { holder: null, token: 0, expires: 0 },
});
// A deliberately small lexical normalization; no claim of SQLite's Porter/BM25 parity.
const plural = (word: string) =>
  word.endsWith('ies')
    ? word.slice(0, -3) + 'y'
    : word.endsWith('s') && !word.endsWith('ss')
      ? word.slice(0, -1)
      : word;
const visible = (r: RecordRow, scope: RowScope) =>
  scope.patterns.some((p) => matchesPattern(p, r.namespace));
function replacements(rows: RecordRow[], ids: string[], scope: RowScope) {
  return Object.fromEntries(
    ids.map((id) => [
      id,
      rows
        .filter(
          (r) =>
            visible(r, scope) && r.links.some((l) => l.type === 'supersedes' && l.target === id)
        )
        .map((r) => r.id)
        .sort(),
    ])
  );
}

export abstract class StateStorage implements StorageProvider, TokenStore {
  abstract readonly descriptor: StorageProvider['descriptor'];
  abstract open(): Promise<void>;
  abstract close(): Promise<void>;
  protected abstract use<T>(
    change: boolean,
    fn: (state: State, rows: RecordRow[]) => T | Promise<T>
  ): Promise<T>;
  snapshot(): Promise<StorageSnapshot> {
    return this.use(false, (s, rows) => {
      if (s.outbox.some((e) => e.status !== 'exported'))
        throw new StoreBusyError('Drain history before exporting');
      const last = s.outbox.filter((e) => e.ref && e.ref !== 'discarded').at(-1);
      let anchor: StorageSnapshot['anchor'] = null;
      if (last) {
        const { status, attempts, error, ref, ...entry } = last;
        void status;
        void attempts;
        void error;
        anchor = { entry, ref: ref! };
      }
      return {
        records: [...rows].sort((a, b) => a.id.localeCompare(b.id)),
        namespaces: [...s.namespaces].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0
        ),
        anchor,
      };
    });
  }
  restoreSnapshot(snapshot: StorageSnapshot): Promise<void> {
    return this.use(true, (s, rows) => {
      if (
        rows.length ||
        s.operations.length ||
        s.outbox.length ||
        s.namespaces.length ||
        s.tokens.length
      )
        throw new StoreUnavailableError('Migration requires an empty destination');
      rows.push(...structuredClone(snapshot.records));
      s.namespaces = structuredClone(snapshot.namespaces);
      if (snapshot.anchor) {
        s.outbox.push({
          ...structuredClone(snapshot.anchor.entry),
          status: 'exported',
          ref: snapshot.anchor.ref,
          attempts: 0,
          error: null,
        });
        s.sequence = snapshot.anchor.entry.seq;
      }
    });
  }
  write<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    return this.use(true, async (s, rows) => {
      const tx: StorageTransaction = {
        findOperation: async (p, o) =>
          s.operations.find((x) => x.principalId === p && x.operationId === o) ?? null,
        load: async (id, scope) => {
          const record = rows.find((r) => r.id === id && visible(r, scope));
          return record ? { record } : null;
        },
        findByKey: async (ns, key) =>
          rows.find((r) => r.namespace === ns && r.key === key)?.id ?? null,
        supersededBy: async (ids) => replacements(rows, ids, { patterns: ['*'] }),
        namespacePolicy: async (ns, policy) => {
          let found = s.namespaces.find((n) => n.name === ns);
          if (!found) {
            found = { name: ns, historyPolicy: policy };
            s.namespaces.push(found);
          }
          return found.historyPolicy;
        },
        commit: async (batch, expected) => {
          for (const { id, revision } of expected) {
            const current = rows.find((r) => r.id === id)?.revision ?? null;
            if (revision !== current) {
              if (current === null || revision === null)
                throw new InternalError('Unexpected memory revision', { id });
              throw new RevisionConflictError('The memory has changed', {
                id,
                currentRevision: current,
              });
            }
          }
          for (const { record } of batch.rows) {
            const collision = rows.find(
              (r) =>
                record.key !== null &&
                r.id !== record.id &&
                r.namespace === record.namespace &&
                r.key === record.key
            );
            if (collision)
              throw new AlreadyExistsError('The key is already taken', {
                namespace: record.namespace,
                key: record.key,
                id: collision.id,
              });
            const index = rows.findIndex((r) => r.id === record.id);
            if (index < 0) rows.push(structuredClone(record));
            else rows[index] = structuredClone(record);
          }
          const seqs = batch.outbox.map((entry) => {
            const seq = ++s.sequence;
            s.outbox.push({
              ...entry,
              seq,
              attempts: 0,
              status: 'pending',
              error: null,
              ref: null,
            });
            return seq;
          });
          s.operations.push({
            ...batch.operation,
            seq: seqs.at(-1) ?? null,
            at: new Date().toISOString(),
          });
          return { seqs };
        },
      };
      return fn(tx);
    });
  }
  get(id: string, scope: RowScope) {
    return this.use(false, (_, rows) => {
      const record = rows.find((r) => r.id === id && visible(r, scope));
      return record ? { record } : null;
    });
  }
  supersededBy(ids: string[], scope: RowScope) {
    return this.use(false, (_, rows) => replacements(rows, ids, scope));
  }
  private matches(query: StorageSearch, rows: RecordRow[], any = false) {
    const terms = searchTerms(query.text ?? '').flatMap(
      (t) => t.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
    );
    return rows
      .filter((r) => {
        if (
          !visible(r, query) ||
          !query.states.includes(r.state) ||
          (query.kinds && !query.kinds.includes(r.kind))
        )
          return false;
        if (
          query.metadata &&
          Object.entries(query.metadata).some(
            ([k, v]) => canonicalJson(r.metadata[k] ?? null) !== canonicalJson(v)
          )
        )
          return false;
        const words = new Set(
          (
            (r.kind + ' ' + r.content + ' ' + metadataText(r.metadata))
              .toLowerCase()
              .match(/[\p{L}\p{N}_]+/gu) ?? []
          ).map((w) => (any ? plural(w) : w))
        );
        return (
          terms.length === 0 ||
          (any ? terms.some((t) => words.has(plural(t))) : terms.every((t) => words.has(t)))
        );
      })
      .sort((a, b) => {
        const score = (r: RecordRow) => {
          const words = new Set(
            (r.content + ' ' + r.kind + ' ' + metadataText(r.metadata))
              .toLowerCase()
              .match(/[\p{L}\p{N}_]+/gu)
              ?.map(plural)
          );
          return terms.filter((t) => words.has(plural(t))).length;
        };
        return (
          (any ? score(b) - score(a) : 0) ||
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.id.localeCompare(b.id)
        );
      });
  }
  private page(query: StorageSearch, rows: RecordRow[], any: boolean) {
    const { cursor: _cursor, limit: _limit, ...criteria } = query;
    void _cursor;
    void _limit;
    if ('excerptChars' in criteria) delete criteria.excerptChars;
    const fingerprint = sha256Hex(canonicalJson({ ...criteria, any }));
    let offset = 0;
    if (query.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString()) as {
          fingerprint: string;
          offset: number;
        };
        if (
          parsed.fingerprint !== fingerprint ||
          !Number.isSafeInteger(parsed.offset) ||
          parsed.offset < 0
        )
          throw new Error();
        offset = parsed.offset;
      } catch {
        throw new ValidationFailedError('Invalid search cursor', {
          field: 'cursor',
          reason: 'invalid',
        });
      }
    }
    const matched = this.matches(query, rows, any);
    return {
      matched,
      offset,
      cursor: (next: number) =>
        next < matched.length
          ? Buffer.from(JSON.stringify({ fingerprint, offset: next })).toString('base64url')
          : null,
    };
  }
  search(query: StorageSearch) {
    return this.use(false, (_, rows) => {
      const p = this.page(query, rows, false);
      const selected = p.matched.slice(p.offset, p.offset + query.limit);
      const by = replacements(
        rows,
        selected.map((r) => r.id),
        { patterns: query.readable }
      );
      return {
        items: selected.map((r) => ({ ...r, supersededBy: by[r.id]! })),
        nextCursor: p.cursor(p.offset + selected.length),
        completeness: 'complete' as const,
      };
    });
  }
  retrieve(query: StorageRetrieve) {
    return this.use(false, (_, rows) => {
      const p = this.page(query, rows, true);
      const terms = searchTerms(query.text).flatMap(
        (t) => t.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
      );
      const by = replacements(
        rows,
        p.matched.map((r) => r.id),
        { patterns: query.readable }
      );
      const items = [];
      let bytes = 512;
      for (const row of p.matched.slice(p.offset, p.offset + query.limit)) {
        const words = new Set(
          (
            (row.content + ' ' + row.kind + ' ' + metadataText(row.metadata))
              .toLowerCase()
              .match(/[\p{L}\p{N}_]+/gu) ?? []
          ).map(plural)
        );
        const matched = terms.filter((t) => words.has(plural(t)));
        const positions = matched
          .map((t) => row.content.toLowerCase().indexOf(t))
          .filter((n) => n >= 0);
        const item = retrievedItem(
          row,
          by[row.id]!,
          0,
          matched,
          positions.length ? Math.min(...positions) : -1,
          query.excerptChars
        );
        const size = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (bytes + size > MAX_RETRIEVE_BYTES) break;
        bytes += size;
        items.push(item);
      }
      return {
        items,
        nextCursor: p.cursor(p.offset + items.length),
        completeness: 'complete' as const,
      };
    });
  }
  operation(principalId: string, operationId: string) {
    return this.use(false, (s) => {
      const op = s.operations.find(
        (o) => o.principalId === principalId && o.operationId === operationId
      );
      if (!op) return null;
      const entries = s.outbox.filter(
        (e) =>
          e.seq <= (op.seq ?? 0) &&
          e.operationId === operationId &&
          e.actor === principalId &&
          e.ref !== 'discarded'
      );
      const history = entries.some((e) => e.status === 'blocked')
        ? ('blocked' as const)
        : entries.some((e) => e.status === 'pending')
          ? ('pending' as const)
          : entries.length
            ? ('persisted' as const)
            : ('not_required' as const);
      return {
        operationId,
        memoryId: op.memoryId,
        revision: op.revision,
        storage: 'persisted' as const,
        history,
        historyRef: history === 'persisted' ? (entries.at(-1)?.ref ?? null) : null,
      };
    });
  }
  pruneOperations(before: string) {
    return this.use(true, (s) => {
      const count = s.operations.length;
      s.operations = s.operations.filter((o) => o.at >= before);
      return count - s.operations.length;
    });
  }
  setNamespacePolicy(name: string, historyPolicy: HistoryPolicy) {
    return this.use(true, (s) => {
      const found = s.namespaces.find((n) => n.name === name);
      if (found) found.historyPolicy = historyPolicy;
      else s.namespaces.push({ name, historyPolicy });
      return { name, historyPolicy };
    });
  }
  getNamespace(ns: string) {
    return this.use(false, (s) => s.namespaces.find((n) => n.name === ns) ?? null);
  }
  purge(id: string, scope: RowScope, request: PurgeRequest) {
    return this.use(true, (s, rows) => {
      const prior = s.operations.find(
        (o) => o.principalId === request.principalId && o.operationId === request.operationId
      );
      if (prior) {
        if (prior.fingerprint !== request.fingerprint || !prior.purge)
          throw new IdempotencyMismatchError('Operation id already used', {
            operationId: request.operationId,
          });
        return { ...prior.purge, replayed: true };
      }
      const index = rows.findIndex((r) => r.id === id && visible(r, scope));
      if (index < 0) throw new NotFoundError('Memory not found', { id });
      const row = rows[index]!;
      if (row.revision !== request.expectedRevision)
        throw new RevisionConflictError('Memory has changed', {
          id,
          currentRevision: row.revision,
        });
      let pendingDiscarded = 0;
      for (const e of s.outbox.filter((e) => e.memoryId === id && e.status !== 'exported')) {
        e.status = 'exported';
        e.ref = 'discarded';
        e.payload = null;
        e.error = null;
        pendingDiscarded++;
      }
      const policy = s.namespaces.find((n) => n.name === row.namespace)?.historyPolicy ?? 'none';
      const queued =
        request.queueHistory &&
        (policy !== 'none' ||
          s.outbox.some(
            (e) => e.memoryId === id && e.status === 'exported' && e.ref !== 'discarded'
          ));
      const seq = queued ? ++s.sequence : null;
      if (seq !== null)
        s.outbox.push({
          seq,
          operationId: request.operationId,
          memoryId: id,
          revision: row.revision + 1,
          operation: 'purge',
          actor: request.principalId,
          at: request.at,
          namespace: row.namespace,
          policy: policy === 'none' ? 'metadata' : policy,
          payload: null,
          status: 'pending',
          attempts: 0,
          ref: null,
          error: null,
        });
      rows.splice(index, 1);
      for (const o of s.operations)
        if (o.outcome) {
          if (o.outcome.memory.id === id) o.outcome = null;
          else o.outcome.related = o.outcome.related.filter((r) => r.id !== id);
        }
      const facts = { namespace: row.namespace, pendingDiscarded, queued };
      s.operations.push({
        ...request,
        memoryId: id,
        revision: row.revision + 1,
        seq,
        outcome: null,
        purge: facts,
      });
      return { ...facts, replayed: false };
    });
  }
  acquireDrainLease(holder: string, ttlMs: number) {
    return this.use(true, (s) => {
      if (s.lease.holder !== null && s.lease.holder !== holder && s.lease.expires > Date.now())
        return null;
      s.lease = {
        holder,
        token: s.lease.token + 1,
        expires: Date.now() + Math.max(0, Math.floor(ttlMs)),
      };
      return { token: s.lease.token };
    });
  }
  releaseDrainLease(token: number) {
    return this.use(true, (s) => {
      if (s.lease.token === token) {
        s.lease.holder = null;
        s.lease.expires = 0;
      }
    });
  }
  nextOutbox() {
    return this.use(false, (s) => {
      const entry = ({
        status,
        ref,
        error,
        ...value
      }: Entry): OutboxEntry & { attempts: number } => {
        void status;
        void ref;
        void error;
        return value;
      };
      const blocked = s.outbox.find((e) => e.status === 'blocked');
      if (blocked) return { blocked: entry(blocked), error: blocked.error ?? 'HistoryUnavailable' };
      const next = s.outbox.find((e) => e.status === 'pending');
      return next ? entry(next) : null;
    });
  }
  lastExportedRef() {
    return this.use(
      false,
      (s) =>
        s.outbox.filter((e) => e.status === 'exported' && e.ref !== 'discarded').at(-1)?.ref ?? null
    );
  }
  markExported(seq: number, ref: string, token: number) {
    return this.use(true, (s) => {
      if (!this.holds(s, token)) return false;
      const e = s.outbox.find((e) => e.seq === seq && e.status === 'pending');
      if (e) {
        e.status = 'exported';
        e.ref = ref;
        e.payload = null;
        e.error = null;
      }
      return true;
    });
  }
  markFailed(seq: number, error: { code: string; message: string }, block: boolean, token: number) {
    return this.use(true, (s) => {
      if (!this.holds(s, token)) return false;
      const e = s.outbox.find((e) => e.seq === seq && e.status === 'pending');
      if (e) {
        e.attempts++;
        e.error = error.code;
        if (block) e.status = 'blocked';
      }
      return true;
    });
  }
  private holds(s: State, token: number) {
    return s.lease.holder !== null && s.lease.token === token && s.lease.expires > Date.now();
  }
  unblock() {
    return this.use(true, (s) => {
      let n = 0;
      for (const e of s.outbox)
        if (e.status === 'blocked') {
          e.status = 'pending';
          e.attempts = 0;
          n++;
        }
      return n;
    });
  }
  queue() {
    return this.use(false, (s) => {
      const b = s.outbox.find((e) => e.status === 'blocked');
      return {
        pending: s.outbox.filter((e) => e.status === 'pending').length,
        blocked: b
          ? { seq: b.seq, operationId: b.operationId, error: b.error ?? 'HistoryUnavailable' }
          : null,
        lastError: s.outbox.find((e) => e.status === 'pending')?.error ?? null,
      };
    });
  }
  issue(principalId: string, grants: Grant[]) {
    return this.use(true, (s) => {
      const tokenId = 'tok_' + randomBytes(12).toString('hex');
      const secret = 'mk_' + randomBytes(32).toString('base64url');
      s.tokens.push({
        tokenId,
        principalId,
        grants,
        hash: sha256Hex(secret),
        createdAt: new Date().toISOString(),
        revokedAt: null,
      });
      return { tokenId, secret };
    });
  }
  verify(secret: string): Promise<Principal | null> {
    return this.use(false, (s) => {
      const t = s.tokens.find((t) => t.hash === sha256Hex(secret) && t.revokedAt === null);
      return t ? { id: t.principalId, profile: 'local', grants: t.grants } : null;
    });
  }
  revoke(tokenId: string) {
    return this.use(true, (s) => {
      const t = s.tokens.find((t) => t.tokenId === tokenId);
      if (!t) throw new NotFoundError('Token not found', { tokenId });
      t.revokedAt ??= new Date().toISOString();
    });
  }
  list() {
    return this.use(false, (s) =>
      s.tokens
        .map(({ hash, ...t }) => {
          void hash;
          return t;
        })
        .sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.tokenId.localeCompare(b.tokenId)
        )
    );
  }
}
