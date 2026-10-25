# Contract — SubZeroDev.MemoryKit

Contract version `1`. This file is the source of truth for signatures, schemas and errors. The design that motivates it is in [10-design.md](10-design.md).

## Invariants

1. **service:** Every adapter (SDK, CLI, HTTP, MCP stdio and MCP over HTTP) reaches memory only through `MemoryService`, and no adapter changes state any other way.
2. **service:** No call reaches a provider before `authorize` allows it. A request that names a namespace outside the caller's grants fails with `Forbidden`.
3. **storage-sqlite:** Every read and mutation by id carries the caller's permitted patterns inside the query, so a row outside them never leaves the provider. Such an id surfaces as `NotFound`.
4. **service:** Every mutation of an existing memory carries `expectedRevision`. The memory changes only when that equals its current revision, checked inside the write transaction.
5. **storage-sqlite:** The row, its links, its search text, its outbox entry and its operation record commit in one transaction, or none of them do.
6. **storage-sqlite:** `revision` starts at 1 and goes up by exactly 1 per committed change. `(memoryId, revision)` is never written twice.
7. **storage-sqlite:** At most one memory that is not purged holds a given `(namespace, key)`.
8. **service:** `(principalId, operationId)` maps to at most one outcome. Replaying it with the same fingerprint returns that outcome without changing state.
9. **service:** A write returns `history: "persisted"` only after the history provider has acknowledged its revision. Otherwise it returns `pending` or, under policy `none`, `not_required`.
10. **service:** Outbox entries are exported in strictly increasing `seq`. No entry is exported while an earlier one is `pending` or `blocked`.
11. **history providers:** `record` is idempotent by `operationId`. Recording an entry again produces no second revision and returns the original `historyRef`.
12. **service:** Retention filtering happens before an entry is enqueued, so content forbidden by policy never reaches a history provider.
13. **model:** Lifecycle changes follow only the transition table in 10-design. Every other change is `InvalidTransition`.
14. **model:** `actor` always comes from the authenticated principal and never from request input.
15. **storage-sqlite:** A store opens only on a local path that has FTS5 and WAL and a schema version no newer than the code's.
16. **history-git:** The history provider never rewrites or removes an existing commit, and never pushes.
17. **service:** A purge reports every boundary as `removed`, `retained`, `not_modified`, `outside_control`, `unsupported` or `failed`. It never reports a boundary removed that it did not remove.
18. **model:** Log records and errors never include content or metadata values.
19. **contracts:** No contract type carries a language-specific runtime type. Every value crossing a provider boundary is plain JSON data.

## Public surface

### model

```ts
export type MemoryId = string;            // ULID, 26 chars, Crockford base32
export type Namespace = string;           // 1-8 segments of [a-z0-9][a-z0-9._-]{0,63}, joined by "/"
export type NamespacePattern = string;    // "a/b" exact | "a/b/*" subtree | "*"
export type MemoryState = 'active' | 'superseded' | 'archived' | 'tombstoned';
export type ContentType = 'text/plain' | 'text/markdown' | 'application/json';
export type CoreLinkType = 'supersedes' | 'derived_from' | 'contradicts' | 'validated_by' | 'depends_on' | 'related_to' | 'belongs_to';
export type LinkType = CoreLinkType | `x-${string}`;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Operation = 'create' | 'update' | 'archive' | 'supersede' | 'tombstone' | 'restore' | 'purge';
export type Permission = 'read' | 'write' | 'tombstone' | 'history' | 'purge' | 'admin';

export interface Link { type: LinkType; target: MemoryId }
export interface Evidence { ref: string; note?: string }
export interface Provenance { origin?: { kind: string; name: string; version?: string }; reason?: string; evidence: Evidence[] }

export interface MemoryRecord {
  id: MemoryId; namespace: Namespace; key: string | null; kind: string;
  content: string; contentType: ContentType; metadata: Record<string, JsonValue>;
  links: Link[]; state: MemoryState; priorState: MemoryState | null; revision: number;
  provenance: Provenance; actor: string; createdAt: string; updatedAt: string;   // ISO 8601 UTC
  supersededBy: MemoryId[];                                                         // derived
}

export interface Limits {
  maxContentBytes: number;     // default 262144
  maxMetadataBytes: number;    // default 16384
  maxLinks: number;            // default 64
  maxPageSize: number;         // default 100
}

export abstract class MemoryKitError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly retryable: boolean;
  readonly details: Record<string, JsonValue>;
}
export type ErrorCode =
  | 'ValidationFailed' | 'LimitExceeded' | 'Unauthenticated' | 'AuthenticationUnavailable' | 'Forbidden'
  | 'NotFound' | 'AlreadyExists' | 'RevisionConflict' | 'InvalidTransition' | 'IdempotencyMismatch'
  | 'HistoryNotRetained' | 'HistoryUnavailable' | 'Unsupported' | 'UnsupportedContractVersion'
  | 'StoreBusy' | 'StoreUnavailable' | 'StoreVersionTooNew' | 'Internal';
// One subclass per code, named <Code>Error, e.g. RevisionConflictError.

export function newMemoryId(): MemoryId;
export function parseNamespace(value: string): Namespace;                    // throws ValidationFailed
export function matchesPattern(pattern: NamespacePattern, ns: Namespace): boolean;
export function nextState(op: Operation, from: MemoryState | null, prior: MemoryState | null): MemoryState; // throws InvalidTransition
```

### access

```ts
export interface Grant { pattern: NamespacePattern; permissions: Permission[] }
export interface Principal { id: string; profile: 'embedded' | 'local' | 'remote'; grants: Grant[] }

export const EMBEDDED_PRINCIPAL: Principal;   // id "embedded", every permission on "*"
export function authorize(p: Principal, permission: Permission, ns: Namespace): void;   // throws Forbidden
export function permittedPatterns(p: Principal, permission: Permission): NamespacePattern[];
export function parseScopeClaim(scope: string): Grant[];                      // "mk:<permission>:<pattern>" tokens
export function intersectGrants(requested: Grant[], ceiling: Grant[]): Grant[];
```

### service

```ts
export interface WriteOptions { operationId?: string; waitForHistoryMs?: number }
export type HistoryStatus = 'persisted' | 'pending' | 'blocked' | 'not_required';
export interface WriteOutcome {
  operationId: string; memory: MemoryRecord;
  storage: 'persisted'; history: HistoryStatus; historyRef: string | null;
  related: MemoryRecord[];      // supersede: the superseded target
}

export interface CreateInput {
  namespace: Namespace; key?: string; kind: string; content: string; contentType?: ContentType;
  metadata?: Record<string, JsonValue>; links?: Link[]; provenance?: Provenance;
}
export interface UpdateInput {
  id: MemoryId; expectedRevision: number;
  kind?: string; content?: string; contentType?: ContentType; metadata?: Record<string, JsonValue>;
  links?: Link[]; provenance?: Provenance;            // omitted fields keep their value; links and metadata are replaced whole
}
export interface TransitionInput { id: MemoryId; expectedRevision: number; provenance?: Provenance }
export interface SupersedeInput { id: MemoryId; expectedRevision: number; replacement: CreateInput }   // replacement.namespace defaults to the target's

export interface SearchQuery {
  namespaces?: NamespacePattern[]; text?: string; kinds?: string[]; states?: MemoryState[];   // states default ['active']
  metadata?: Record<string, string | number | boolean | null>;   // top-level equality
  limit?: number; cursor?: string;
}
export interface SearchResult {
  items: MemoryRecord[]; nextCursor: string | null;
  completeness: 'complete' | 'partial'; partialReason?: 'scan_budget' | 'time_budget';
}

export interface RevisionSummary { revision: number; operation: Operation; operationId: string; actor: string; at: string; historyRef: string }
export interface RevisionSnapshot extends RevisionSummary { record: MemoryRecord | RedactedRecord }
export type RedactedRecord = Omit<MemoryRecord, 'content' | 'metadata'> & { contentHash: string; metadataKeys: string[] };

export type PurgeBoundary = 'current_storage' | 'pending_history' | 'history_current_tree' | 'history_past_revisions' | 'history_remotes' | 'external_copies';
export type BoundaryResult = 'removed' | 'retained' | 'not_modified' | 'outside_control' | 'unsupported' | 'failed';
export type HistoryBoundary = Extract<PurgeBoundary, `history_${string}`>;
export interface PurgeReport { operationId: string; memoryId: MemoryId; boundaries: Record<PurgeBoundary, { result: BoundaryResult; detail?: string }> }

export interface OperationStatus { operationId: string; memoryId: MemoryId; revision: number; storage: 'persisted'; history: HistoryStatus; historyRef: string | null }
export interface StoreStatus {
  contractVersion: 1; storage: ProviderDescriptor; history: ProviderDescriptor | null;
  historyQueue: { pending: number; blocked: { seq: number; operationId: string; error: string } | null };
}
export interface NamespaceInfo { name: Namespace; historyPolicy: HistoryPolicy }
export type HistoryPolicy = 'full' | 'metadata' | 'none';

export interface MemoryClient {
  create(input: CreateInput, opts?: WriteOptions): Promise<WriteOutcome>;
  get(id: MemoryId): Promise<MemoryRecord>;
  update(input: UpdateInput, opts?: WriteOptions): Promise<WriteOutcome>;
  archive(input: TransitionInput, opts?: WriteOptions): Promise<WriteOutcome>;
  restore(input: TransitionInput, opts?: WriteOptions): Promise<WriteOutcome>;
  tombstone(input: TransitionInput, opts?: WriteOptions): Promise<WriteOutcome>;
  supersede(input: SupersedeInput, opts?: WriteOptions): Promise<WriteOutcome>;
  purge(input: { id: MemoryId; expectedRevision: number }, opts?: { operationId?: string }): Promise<PurgeReport>;
  search(query: SearchQuery): Promise<SearchResult>;
  history(id: MemoryId): Promise<RevisionSummary[]>;
  revision(id: MemoryId, revision: number): Promise<RevisionSnapshot>;
  operation(operationId: string): Promise<OperationStatus>;
  status(): Promise<StoreStatus>;
  getNamespace(ns: Namespace): Promise<NamespaceInfo>;
  setNamespacePolicy(ns: Namespace, policy: HistoryPolicy): Promise<NamespaceInfo>;   // admin
  syncHistory(opts?: { retryBlocked?: boolean; budgetMs?: number }): Promise<StoreStatus['historyQueue']>;   // admin
}

export interface ServiceConfig { limits?: Partial<Limits>; historyWaitMs?: number; operationRetentionDays?: number; drainBudgetMs?: number; maxExportAttempts?: number }
export class MemoryService {
  constructor(storage: StorageProvider, history: HistoryProvider | null, config?: ServiceConfig);
  open(): Promise<void>;                          // verifies providers, starts a drain
  close(): Promise<void>;                         // stops the drainer, best-effort drain within budget
  as(principal: Principal): MemoryClient;
}
```

### contracts

```ts
export interface ProviderDescriptor {
  id: string; version: string; contractVersions: number[];
  capabilities: string[];          // e.g. "search.lexical", "history.record", "purge.current", "purge.history"
  limitations: string[];
}

export interface RowScope { patterns: NamespacePattern[] }   // permitted patterns; the provider must apply them in the query
export interface StoredRow { record: Omit<MemoryRecord, 'supersededBy'> }
export interface OutboxEntry {
  seq: number; operationId: string; memoryId: MemoryId; revision: number; operation: Operation;
  actor: string; at: string; namespace: Namespace; policy: Exclude<HistoryPolicy, 'none'>;
  payload: MemoryRecord | RedactedRecord | null;   // null for purge entries
}
export interface WriteBatch {
  rows: StoredRow[]; outbox: Omit<OutboxEntry, 'seq'>[];
  operation: { principalId: string; operationId: string; fingerprint: string; memoryId: MemoryId; revision: number };
}
export interface StorageTransaction {
  findOperation(principalId: string, operationId: string): Promise<{ fingerprint: string; memoryId: MemoryId; revision: number; seq: number | null } | null>;
  load(id: MemoryId, scope: RowScope): Promise<StoredRow | null>;
  findByKey(ns: Namespace, key: string): Promise<MemoryId | null>;
  namespacePolicy(ns: Namespace, defaultPolicy: HistoryPolicy): Promise<HistoryPolicy>;   // creates on first use
  commit(batch: WriteBatch, expected: { id: MemoryId; revision: number | null }[]): Promise<{ seqs: number[] }>;   // throws RevisionConflict / AlreadyExists
}
export interface PurgeRequest { principalId: string; operationId: string; fingerprint: string; expectedRevision: number; at: string; queueHistory: boolean }
export interface PurgeOutcome { namespace: Namespace; pendingDiscarded: number; queued: boolean; replayed: boolean }   // a replay returns what the first attempt recorded
export interface StorageProvider {
  readonly descriptor: ProviderDescriptor;
  open(): Promise<void>; close(): Promise<void>;
  write<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T>;
  get(id: MemoryId, scope: RowScope): Promise<StoredRow | null>;
  supersededBy(ids: MemoryId[]): Promise<Record<MemoryId, MemoryId[]>>;
  search(query: Required<Pick<SearchQuery, 'states' | 'limit'>> & Omit<SearchQuery, 'namespaces'> & RowScope): Promise<SearchResult>;
  operation(principalId: string, operationId: string): Promise<OperationStatus | null>;
  setNamespacePolicy(ns: Namespace, policy: HistoryPolicy): Promise<NamespaceInfo>;
  getNamespace(ns: Namespace): Promise<NamespaceInfo | null>;
  // outbox
  acquireDrainLease(holder: string, ttlMs: number): Promise<{ token: number } | null>;
  nextOutbox(): Promise<OutboxEntry | { blocked: OutboxEntry; error: string } | null>;
  lastExportedRef(): Promise<string | null>;
  markExported(seq: number, historyRef: string, leaseToken: number): Promise<boolean>;   // false: lease lost
  markFailed(seq: number, error: { code: string; message: string }, block: boolean, leaseToken: number): Promise<boolean>;
  unblock(): Promise<number>;
  queue(): Promise<StoreStatus['historyQueue']>;
  // purge
  purge(id: MemoryId, scope: RowScope, request: PurgeRequest): Promise<PurgeOutcome>;   // throws NotFound / RevisionConflict / IdempotencyMismatch
}

export interface HistoryEntry extends OutboxEntry { after: string | null }   // historyRef of the previously exported entry
export interface HistoryProvider {
  readonly descriptor: ProviderDescriptor;
  open(): Promise<void>; close(): Promise<void>;
  record(entry: HistoryEntry): Promise<{ historyRef: string }>;    // idempotent by operationId
  list(memoryId: MemoryId, ns: Namespace): Promise<RevisionSummary[]>;
  get(memoryId: MemoryId, ns: Namespace, revision: number): Promise<RevisionSnapshot | null>;
  purgeCoverage(): Record<HistoryBoundary, BoundaryResult>;
}
export class HistoryProviderError extends MemoryKitError { readonly retryable: boolean }

export interface TokenStore {
  issue(principalId: string, grants: Grant[]): Promise<{ tokenId: string; secret: string }>;   // secret shown once
  verify(secret: string): Promise<Principal | null>;
  revoke(tokenId: string): Promise<void>;
  list(): Promise<{ tokenId: string; principalId: string; grants: Grant[]; createdAt: string; revokedAt: string | null }[]>;
}
```

### sdk

```ts
export interface StoreConfig {
  path: string;                                         // store directory
  history?: { provider: 'git'; repository?: string } | { provider: 'memory' } | { provider: 'none' };   // default git at <path>/history.git
  defaultHistoryPolicy?: HistoryPolicy;                 // default 'full'
  service?: ServiceConfig;
}
export function initStore(config: StoreConfig): Promise<void>;                    // throws StoreUnavailable when the path is a store already
export function openStore(config: StoreConfig, principal?: Principal): Promise<MemoryClient & { close(): Promise<void> }>;
export function connect(url: string, opts: { token?: string; fetch?: typeof fetch }): MemoryClient;
export class SqliteStorage implements StorageProvider { constructor(opts: { path: string; busyTimeoutMs?: number; scanBudget?: number }) }
export class GitHistory implements HistoryProvider { constructor(opts: { repository: string; branch?: string; gitPath?: string; author?: { name: string; email: string } }) }
export class MemoryHistory implements HistoryProvider { constructor() }
```

### authn and server

```ts
export interface Authenticator { authenticate(headers: Headers): Promise<Principal> }   // throws Unauthenticated / AuthenticationUnavailable
export class LocalTokenAuthenticator implements Authenticator { constructor(tokens: TokenStore) }
export class OidcAuthenticator implements Authenticator {
  constructor(opts: { issuer: string; audience: string; ceiling: Grant[]; clockToleranceSec?: number })
}
export interface ServeOptions {
  store: StoreConfig; listen: { host: string; port: number };
  tls?: { certFile: string; keyFile: string };          // required when host is not loopback
  auth: { profile: 'local' } | { profile: 'remote'; issuer: string; audience: string; ceiling: Grant[] };   // remote requires tls
  allowedOrigins?: string[];
}
export function serve(opts: ServeOptions): Promise<{ url: string; close(): Promise<void> }>;
```

### HTTP API v1

Bearer token in `Authorization`. `Idempotency-Key` sets `operationId`. Bodies are JSON with the shapes above.

| Method and path | Service call | Success |
|---|---|---|
| `POST /v1/memories` | create | 201, or 202 if history is pending: `WriteOutcome` |
| `GET /v1/memories/{id}` | get | 200 `MemoryRecord` |
| `PUT /v1/memories/{id}` | update (body without `id`) | 200, or 202 |
| `POST /v1/memories/{id}/archive`, `/restore`, `/tombstone`, `/supersede` | transitions | 200, 201 for supersede, or 202 |
| `POST /v1/memories/{id}/purge` | purge | 200 `PurgeReport` |
| `POST /v1/search` | search | 200 `SearchResult` |
| `GET /v1/memories/{id}/history` | history | 200 `RevisionSummary[]` |
| `GET /v1/memories/{id}/history/{revision}` | revision | 200 `RevisionSnapshot` |
| `GET /v1/operations/{operationId}` | operation | 200 `OperationStatus` |
| `GET /v1/status` | status | 200 `StoreStatus` |
| `GET`, `PUT /v1/namespaces/{ns}` | namespace policy (ns URL-encoded) | 200 `NamespaceInfo` |
| `POST /v1/history/sync` | syncHistory | 200 queue |
| `GET /.well-known/oauth-protected-resource` | remote profile only | 200 RFC 9728 metadata |

Errors use `application/problem+json` (RFC 9457): `{ type, title, status, code, retryable, details }`.

### MCP server

Specification 2026-07-28 only, stateless, through the TypeScript SDK v2. A request in any other revision gets error `-32022` with `data.supported: ["2026-07-28"]`. It runs over stdio (embedded, principal `EMBEDDED_PRINCIPAL` or the one configured) and over Streamable HTTP at `/mcp` on the service listener, using the same authenticator.

The tools are `memory_create`, `memory_get`, `memory_update`, `memory_archive`, `memory_restore`, `memory_tombstone`, `memory_supersede`, `memory_search`, `memory_history`, `memory_revision` and `memory_operation`. Each takes the matching service input as its `inputSchema` and returns `structuredContent` shaped as the service result. Write tools also take optional `operationId` and `waitForHistoryMs`, and `memory_history` returns `{ revisions }`, since `structuredContent` is an object.

Domain errors return `isError: true` with `structuredContent: { code, retryable, details }`. Authentication failures on HTTP are HTTP 401 or 403, before MCP dispatch. Purge, namespace policy and history sync are not MCP tools in v1.

### CLI

`memorykit <command> [--store <dir> | --url <url> --token-env <VAR>] [--json]`.

The commands are `init`, `create`, `get`, `update`, `archive`, `restore`, `tombstone`, `supersede`, `purge`, `search`, `history`, `revision`, `operation`, `status`, `namespace get|set`, `history-sync`, `token create|list|revoke`, `serve` and `mcp` (stdio).

With `--json`, the output is exactly the service result as JSON. Exit codes:
- 0: success.
- 3: success, but history is pending.
- 1: a domain error, with the problem JSON on stderr.
- 2: a usage error.

## Persisted schemas

### SQLite (`<store>/memory.db`, WAL, `PRAGMA user_version` = schema version, starting at 1)

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY, namespace TEXT NOT NULL, key TEXT, kind TEXT NOT NULL,
  content TEXT NOT NULL, content_type TEXT NOT NULL, metadata TEXT NOT NULL,       -- JSON
  provenance TEXT NOT NULL,                                                       -- JSON
  state TEXT NOT NULL CHECK (state IN ('active','superseded','archived','tombstoned')),
  prior_state TEXT, revision INTEGER NOT NULL CHECK (revision >= 1), actor TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX memories_ns_key ON memories(namespace, key) WHERE key IS NOT NULL;
CREATE INDEX memories_ns_state_updated ON memories(namespace, state, updated_at DESC, id);

CREATE TABLE links (
  source TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, type TEXT NOT NULL, target TEXT NOT NULL,
  ordinal INTEGER NOT NULL, PRIMARY KEY (source, ordinal)
) STRICT;
CREATE INDEX links_target ON links(target, type);

CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, kind, content, metadata_text, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE namespaces (name TEXT PRIMARY KEY, history_policy TEXT NOT NULL CHECK (history_policy IN ('full','metadata','none')), created_at TEXT NOT NULL) STRICT;

CREATE TABLE operations (
  principal_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  memory_id TEXT NOT NULL, revision INTEGER NOT NULL, seq INTEGER, created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, operation_id)
) STRICT;

CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL, memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL, operation TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL,
  namespace TEXT NOT NULL, policy TEXT NOT NULL, payload TEXT,                    -- JSON; NULL once exported or for purge
  status TEXT NOT NULL CHECK (status IN ('pending','exported','blocked')),
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, history_ref TEXT,
  UNIQUE (memory_id, revision, operation)
);
CREATE INDEX outbox_status ON outbox(status, seq);

CREATE TABLE drain_lease (id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT, token INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;

CREATE TABLE purges (memory_id TEXT PRIMARY KEY, namespace TEXT NOT NULL, principal_id TEXT NOT NULL, operation_id TEXT NOT NULL, at TEXT NOT NULL, report TEXT NOT NULL) STRICT;

CREATE TABLE tokens (token_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, grants TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, revoked_at TEXT) STRICT;
```

- `secret_hash` is the SHA-256 of a 32-byte random secret, so a constant-time lookup by hash is safe. The secret is shown once.
- Outbox `seq` uses `AUTOINCREMENT`, so seqs are never reused after a purge.
- A purge deletes the `memories` row and its `links` and `memories_fts` rows. It nulls the `payload` of that memory's pending outbox entries and marks them exported with `history_ref = 'discarded'`. It then inserts one `purge` outbox entry, unless the store has no history provider or the namespace policy is `none` and nothing of the memory was exported, and a `purges` row whose `report` holds `{ pendingDiscarded, queued }`. The service derives the `PurgeReport` from that and the purge entry's history status on every call.
- **Existing data:** none, since this is schema 1. Each later migration bumps `user_version` and runs forward-only when the store opens, in one transaction.

### Git history repository (`<store>/history.git`, bare, branch `main`)

- **Tree.**
  - `<namespace>/<id>/record.json` holds the record without content. Its keys are sorted, it is indented with 2 spaces and it ends with a trailing newline. Under policy `metadata`, it carries `contentHash` and `metadataKeys` in place of the values.
  - `<namespace>/<id>/content.<txt|md|json>` holds the content byte for byte. It is absent under policy `metadata`.
  - `.memorykit/format` contains `1`.
- **Purge.** A purge commit replaces `record.json` with `{ id, namespace, purged: true, at }` and deletes the content file. Earlier commits are not modified.
- **Commit.** The subject is `<operation> <namespace>/<id> r<revision>`. The trailers are `MemoryKit-Operation: <operationId>`, `MemoryKit-Memory: <id>`, `MemoryKit-Revision: <n>`, `MemoryKit-Actor: <principal>` and `MemoryKit-Seq: <seq>`. Author and committer are configurable (default `MemoryKit <memorykit@localhost>`), and both dates are the revision's `at`.
- **Existing data:** none at format 1. The provider refuses a repository whose format is newer, with `UnsupportedContractVersion`.

## Error semantics

| Code | Raised by | When | Retryable | Caller does | HTTP |
|---|---|---|---|---|---|
| ValidationFailed | model, service | Malformed input, a bad namespace, link or content type, or invalid JSON content | no | Fix the input | 400 |
| LimitExceeded | service | Size, link or page-size limits exceeded | no | Shrink the request | 413 |
| Unauthenticated | authn | Credentials missing, invalid, expired, or with the wrong issuer or audience | no | Get valid credentials | 401 |
| AuthenticationUnavailable | authn | The issuer's keys cannot be obtained | yes | Back off and retry | 503 |
| Forbidden | access | A named namespace or permission is not granted, or the Origin is disallowed | no | Request a grant | 403 |
| NotFound | service | The id does not exist, is purged or is outside the grants; or an operation id is unknown | no | Stop, or search again | 404 |
| AlreadyExists | storage | `(namespace, key)` is taken; `details.id` holds the existing id | no | Use or restore the existing memory | 409 |
| RevisionConflict | storage | `expectedRevision` is not the current revision; `details.currentRevision` holds it | after re-read | Re-read, reconcile, retry with the new revision | 409 |
| InvalidTransition | model | The lifecycle operation is not allowed from the current state | no | Read the state and pick a valid operation | 409 |
| IdempotencyMismatch | service | An operation id is reused with a different request | no | Use a new operation id | 422 |
| HistoryNotRetained | service | The namespace's history policy is `none` | no | None; there is no history | 404 |
| HistoryUnavailable | history | The provider failed while being read | yes | Retry later | 503 |
| Unsupported | service | The provider lacks the capability (`details.capability`) | no | Use another operation or provider | 501 |
| UnsupportedContractVersion | contracts | A provider or repository declares an incompatible contract or format | no | Upgrade MemoryKit or the provider | 500 at open |
| StoreBusy | storage | The busy timeout was exceeded | yes | Retry with the same operation id | 503 |
| StoreUnavailable | storage | The store cannot be opened or written (missing, foreign, network path, no FTS5, I/O error) | depends on `details.reason` | Fix the environment | 503 |
| StoreVersionTooNew | storage | The schema is newer than the code | no | Upgrade MemoryKit | 500 at open |
| Internal | any | An invariant was violated | no | Report the bug; the operation id is in `details` | 500 |

History export failures are never thrown at the writer. They appear as `history: "pending"` or `history: "blocked"` in outcomes and status. Every error carries `code`, `retryable` and `details`, and none is a bare string.

## Unresolved

- npm package name and scope.
- Accepting TLS terminated by a reverse proxy for the remote profile.
- Pruning of the exported outbox ledger.
