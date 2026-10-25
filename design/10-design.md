# Design — SubZeroDev.MemoryKit

Built on [00-brief.md](00-brief.md). Every choice here is recorded in [90-decisions.md](90-decisions.md). The architecture is final for v1: TypeScript on Node, SQLite storage, Git history, an embedded SDK, a CLI, an HTTP API and MCP over one application service, and providers that can be replaced. Signatures, schemas and error codes are in [20-contract.md](20-contract.md).

## Data model

### Memory (persisted; owned by the storage provider)

| Field | Type | Rules |
|---|---|---|
| id | ULID string | The core generates it at create. It is immutable and never reused, and it is distinct from revision numbers and history references. |
| namespace | slash-separated lowercase path | Set at create and immutable. It defines scope and is the unit of authorisation and retention policy. |
| key | optional string | The application's natural identity. It is unique within a namespace among memories that are not purged, so concurrent creates with the same key converge on one memory. |
| kind | string | An application-defined classifier, such as `lesson` or `world-event`. The core does not interpret it. |
| content | UTF-8 string | Size-bounded. |
| contentType | `text/plain`, `text/markdown` or `application/json` | `application/json` content must parse as JSON. |
| metadata | JSON object | Owned by the application. The core checks only its structure and size. |
| links | list of `{ type, target }` | `type` is a core relation name (`supersedes`, `derived_from`, `contradicts`, `validated_by`, `depends_on`, `related_to`, `belongs_to`) or an application type prefixed `x-`. `target` is a memory id. Only `supersedes` is interpreted. |
| state | `active`, `superseded`, `archived` or `tombstoned` | Interpreted by the core. |
| priorState | state or null | The state a tombstoned memory returns to when it is restored. Set only while the memory is tombstoned. |
| revision | positive integer | 1 at create. It goes up by exactly 1 on every change, including lifecycle changes. |
| provenance | `{ origin?, reason?, evidence[] }` | Asserted by the caller: who or what originated the observation, why it changed, and references to evidence. It is labelled as asserted and is never treated as identity. |
| actor | principal id | Set by the core from the authenticated principal on every revision. It is never taken from caller input. |
| createdAt, updatedAt | UTC timestamps | Taken from the clock of the process doing the write. They are not used for ordering; revisions are. |

`supersededBy` is derived on read from other memories' `supersedes` links and is not persisted. Search text is derived from content, kind and metadata values, and is maintained in the same transaction as the record.

**Lifecycle transitions** (any other transition is rejected):

| Operation | From | To |
|---|---|---|
| create | — | active |
| update | active, superseded, archived | unchanged |
| archive | active | archived |
| supersede (creates the replacement) | active, archived | superseded; the replacement is active and links `supersedes` to it |
| tombstone | active, superseded, archived | tombstoned (records priorState) |
| restore | tombstoned | priorState |
| restore | archived | active |
| purge | any | removed (only a purge record remains) |

### Revision (owned by the history provider)

A revision is a snapshot of a memory at one revision number, together with the operation that produced it, the operation id, the actor and the timestamp. It is identified by `(memoryId, revision)`. The provider's own reference, a Git commit id for example, is a separate `historyRef`.

What a revision holds depends on the namespace's history policy at the time of the write:
- **full:** everything.
- **metadata:** content and metadata values are replaced by a SHA-256 content hash and the list of metadata keys.
- **none:** no revision is produced.

### History outbox entry (owned by storage; one per revision bound for history)

| Field | Notes |
|---|---|
| seq | Monotonic and assigned inside the write transaction, so it follows commit order. |
| operationId, memoryId, revision, operation | |
| payload | The exact revision snapshot, already filtered by retention policy. It is cleared once exported. |
| status | `pending`, `exported` or `blocked`. |
| attempts, lastError | `lastError` holds an error code and a message, never content. |
| historyRef | Set when the entry is exported. |

Exported entries become a ledger: identity and `historyRef`, with no payload.

### Operation (owned by storage)

An operation records an idempotent write. It holds:
- `principalId` and `operationId`, which together are unique;
- a fingerprint of the canonical request;
- the outcome: memory id, revision and outbox seq;
- `createdAt`.

The caller may supply the operation id or let the core generate one. Records are pruned after a retention window, 7 days by default.

### Namespace (owned by storage)

A namespace has a name, a history policy (`full`, `metadata` or `none`) and a creation time. The first write to a namespace creates it with the store's default policy, which is `full`. An administrator can change the policy. A change applies only to revisions written after it.

### Principal

A principal has an id, an authentication profile and grants. Each grant is a namespace pattern with a set of permissions:
- **Patterns:** `a/b` matches exactly that namespace; `a/b/*` matches `a/b` and every namespace below it; `*` matches everything.
- **Permissions:** `read`, `write`, `tombstone`, `history`, `purge` and `admin`. Each is granted separately; `purge` and `admin` are never implied by `write`.

How the principal is established depends on the profile:
- **Embedded:** the host supplies the principal. By default it is `embedded`, granted everything on `*`. The host can pass a narrower one so its logical scope is validated.
- **Local service:** the principal comes from a locally issued bearer token. The store keeps only the token's hash, principal and grants.
- **Remote service:** the principal comes from a JWT issued by a configured OIDC issuer. The issuer, audience, expiry and signature are validated. Grants come from the token's `scope` claim (`mk:<permission>:<pattern>`), intersected with a ceiling configured for that issuer.

### Purge record (owned by storage)

A purge record holds the memory id, the namespace, the operation id, the principal, the time and the coverage report. It holds no content.

### Store

A store is a directory holding the database, the default history repository and the configuration. There is one authoritative store per directory, and it must be on a local filesystem.

## Module boundaries

| Module | Owns | Depends on | Exposes |
|---|---|---|---|
| model | Record types, validation, the lifecycle transition table, namespace and pattern syntax, ULIDs, typed errors | nothing | Types, validators, transition rules, error classes |
| access | Principals, grants, the authorisation decision | model | `authorize`, `permittedPatterns` |
| contracts | Provider interfaces (storage, search, history, token store), capability descriptors, contract versions | model | Interfaces, plus the versioned external data representation of records and revisions |
| service | The application service: operation orchestration, idempotency, outcomes, the history drainer | model, access, contracts | `MemoryService` and the `MemoryClient` interface |
| storage-sqlite | Storage, search and the token store on SQLite (`node:sqlite`), including the outbox, operations and migrations | model, contracts | `SqliteStorage` |
| history-git | Revision export and inspection through the installed `git` executable | model, contracts | `GitHistory` |
| history-memory | An in-memory history provider for tests; consumers can use it too | model, contracts | `MemoryHistory` |
| sdk | The composition root: builds a store from configuration for embedded use, plus an HTTP client that implements the same `MemoryClient` | service, providers, model | `openStore`, `connect` |
| authn | Local-token and OIDC JWT authenticators | access, contracts | `Authenticator` implementations |
| http | Mapping between HTTP requests and responses and service calls, including error mapping | service, model | A request handler |
| mcp | MCP tool definitions mapped to service calls; stdio and Streamable HTTP bindings | service, model | `createMcpServer`, plus stdio and HTTP bindings |
| server | The listener, TLS, Origin checks, per-request authentication, mounting http and mcp, running the drainer | http, mcp, authn, sdk | `serve` |
| cli | Commands, argument parsing and output formatting; embedded through `openStore` or remote through `connect` | sdk, server | The `memorykit` executable |
| conformance (tests only) | Scenarios written against `MemoryClient`, plus one driver per adapter | sdk, cli, server | The shared acceptance suite |

The dependency direction runs `model → access → contracts → service → (http, mcp) → server → cli`, with `sdk` as the composition root between service and the adapters. Providers depend only on `model` and `contracts`. `service` never imports a provider, and no adapter holds business rules. The graph is acyclic.

## Control flow

### 1. A write arrives through any adapter

This covers create, update, archive, supersede, tombstone and restore.

1. **Authenticate (service mode only).** The server checks Origin against its allow-list, which applies to MCP over HTTP and to browsers. It then authenticates the bearer token. A failure here stops the request before anything else runs.
2. **Decode.** The adapter turns the request into a service call: principal, input, `expectedRevision` (required when the memory already exists) and operation id.
3. **Validate.** The service checks structure and limits. A failure returns `ValidationFailed` or `LimitExceeded`, and no provider is called.
4. **Authorise.** For create, the caller names the namespace; without the needed permission the result is `Forbidden`, and no provider is called. For an existing id, storage loads the memory only within the caller's permitted patterns. An id outside them is `NotFound`, so its existence is not revealed.
5. **Transact.** The service runs one storage write transaction:
   1. Look up `(principal, operationId)`. If it exists with the same fingerprint, return the stored outcome, with history status re-read. If the fingerprint differs, return `IdempotencyMismatch`.
   2. Load the current row. If the revision is not `expectedRevision`, return `RevisionConflict` with the current revision.
   3. Check the lifecycle transition, or return `InvalidTransition`.
   4. Write the new row at revision + 1 and update its links and search text. Look up the namespace policy. Unless the policy is `none`, enqueue an outbox entry with the filtered snapshot. Record the operation.
   5. Commit. Any error rolls the whole transaction back, nothing persists, and the error is returned.
6. **Export.** The service signals the drainer (path 3) and waits up to `historyWaitMs`, 5 s by default, for this entry to be exported.
7. **Report.** The outcome is `{ storage: persisted, history: persisted | pending | blocked | not_required }`. `historyRef` is included when history is persisted. HTTP answers 200 or 201 when history is persisted or not required, and 202 when it is pending or blocked. MCP returns the same outcome in the tool result.

**Supersede** runs the same path. It creates the replacement and moves the target to `superseded` in one transaction, which produces two revisions and two outbox entries.

### 2. A read arrives

**Get.**
1. Authenticate, then authorise `read`.
2. Storage loads the id only within the caller's readable patterns.
3. A tombstoned memory is returned with its state. A purged or invisible id is `NotFound`.

**Search.**
1. Namespaces the caller names must all be readable, otherwise the result is `Forbidden`. If none are named, the search covers all readable patterns.
2. The pattern constraint is part of the storage query itself, so rows outside it never leave the provider.
3. States default to `active`.
4. Results are bounded (default 20, maximum 100). Ordering is deterministic: lexical rank then id when there is a text query, otherwise `updatedAt` descending then id.
5. The provider stops at its scan budget. The result carries `completeness`:
   - `complete`: every match is in this page or reachable through `nextCursor`.
   - `partial`: the budget stopped the search, so matches may be missing. A reason is given.

**History.**
1. Authorise `history`.
2. Storage confirms the memory is visible to the caller, including when it is tombstoned.
3. The history provider lists or returns revisions.
4. A namespace whose policy is `none` gives `HistoryNotRetained`.

### 3. History drain and recovery

The drain runs:
- after each write commits, in the process that wrote;
- when the store opens;
- periodically, with backoff, in the service;
- on `history sync`.

1. **Lease.** Acquire the store's drain lease in a storage transaction. The lease records a holder, a fencing token and an expiry. If another holder's lease is live, return; that holder drains.
2. **Pick.** If any entry is `blocked`, stop and report it. Otherwise take the pending entry with the lowest seq.
3. **Record.** Call `history.record(entry, after)`, where `after` is the `historyRef` of the previous exported entry. The provider must be idempotent by operation id.
4. **Mark.** Mark the entry exported with its `historyRef`, conditional on the fencing token. If the lease has been lost, stop without exporting anything more.
5. **On failure.**
   - A retryable error increments `attempts` and backs off, and the entry stays pending.
   - A non-retryable error, or exhausting the attempt limit, marks the entry `blocked`. Draining halts and status shows it. An operator fixes the cause and runs `memorykit history-sync --retry-blocked`.
6. **Repeat** until no entries are left or the time budget is spent.

**Git provider.** The repository is bare, and every change goes through plumbing commands:
1. Read the branch head H.
2. Scan the commits from H back to `after` for a `MemoryKit-Operation` trailer matching the entry. If one is found, return that commit.
3. Otherwise:
   1. Write the record and content blobs.
   2. Build the tree in a temporary index.
   3. Create the commit with `commit-tree`, using a fixed author and committer and the revision's timestamp.
   4. Move the branch from H to the new commit with an atomic compare-and-swap (`update-ref <new> <H>`).
4. If the compare-and-swap fails, re-read and start again from step 1.

Hooks are disabled for these commands.

**What each crash window leaves behind:**
- **Before the storage commit:** the transaction is rolled back. Nothing is persisted and nothing is pending.
- **After the storage commit, before export:** the entry is pending and is drained on the next open or service start.
- **After the Git compare-and-swap, before the mark:** the next drain finds the trailer and marks the entry without committing again.
- **While Git is writing objects:** unreferenced objects are left behind. They are harmless and are removed by Git's own garbage collection.

## Distribution

- **Channel.** The npm registry. There is one package containing the library entry points (`openStore`, `connect`, the provider classes and the contracts) and a `memorykit` executable. The package name is open.
- **Requirements.**
  - Node 22.18 or later. Opening a store checks that the built-in SQLite has FTS5 and WAL.
  - A `git` executable on PATH, needed only when the Git history provider is configured.
- **First install.**
  - Install the library with `npm install`, or the CLI globally or through `npx`.
  - `memorykit init <dir>` creates a store: the database, a bare history repository and the configuration, with history policy `full`.
  - `memorykit serve` runs the service.
  - `memorykit token create` issues a local-service token.
- **Upgrade.**
  - Upgrades go through npm.
  - The database records its schema version. Migrations only move forward and run when the store opens, in one transaction. A store written by a newer schema refuses to open with `StoreVersionTooNew`.
  - The history repository records its format version.
  - The HTTP API is versioned in its path (`/v1`). Providers declare the contract version they implement, and it is checked when the store opens.
- **Not in v1.** Standalone binaries, container images and operating-system service installers. The run commands are documented instead.

## Failure modes

| Boundary | What fails | Detection | Response and what the user sees | State left behind |
|---|---|---|---|---|
| SQLite open | Missing or foreign file, newer schema, no FTS5, path on a network share (a UNC path) | Checks when the store opens | The store refuses to open with `StoreUnavailable` or `StoreVersionTooNew`, naming the reason | Unchanged |
| SQLite write | Lock held past the busy timeout | `SQLITE_BUSY` | `StoreBusy`, which is retryable; the client retries with the same operation id | Nothing persisted |
| SQLite write | Disk full or I/O error | SQLite error | Rollback, then `StoreUnavailable` | Nothing persisted |
| Process | Crash during a transaction | WAL recovery on the next open | The client got no outcome; retrying with the same operation id is safe | The transaction is absent |
| Process | Crash after the commit, before export | A pending outbox entry | Drained on the next open or service start; `getOperation` shows `history: pending` until then | A durable pending entry |
| Git | Executable missing, repository unreadable, I/O error | Non-zero exit or spawn error | Retryable: backoff, and writes return `history: pending`; status names the provider error | Pending entries accumulate, and none are lost |
| Git | Compare-and-swap race lost to another drainer | `update-ref` fails | Re-read and re-scan inside the provider; invisible to the user | One commit |
| Git | Crash between the ref update and the mark | The next drain finds the trailer | The entry is marked exported without a new commit | No duplicate |
| Git | Permanent export failure (corrupt repository, rejected path) | Non-retryable error, or the attempt limit is reached | The entry is `blocked` and draining halts; status shows the entry and its error; writes return `blocked`; `memorykit history-sync --retry-blocked` after the repair | Blocked and pending entries are kept |
| History read | Provider failure while inspecting history | Provider error | `HistoryUnavailable`, which is retryable; reads of current state are unaffected | Unchanged |
| Drain lease | The holder stalls past its expiry | The lease expires | Another drainer takes over; the stale holder's mark fails its fencing check and it stops; the Git compare-and-swap prevents double commits | No duplicate |
| OIDC | JWKS endpoint unreachable | Fetch fails | Cached keys are used until they expire; with no usable key the result is `AuthenticationUnavailable` (503, retryable) and the request is denied | Unchanged |
| Token | Invalid, expired, or wrong issuer or audience | Validation | `Unauthenticated` (401, with a `WWW-Authenticate` header pointing at the resource metadata) | Unchanged |
| Authorisation | Namespace or permission missing | `authorize` | `Forbidden` (403) when the caller named the namespace; `NotFound` when an id resolves outside the grants | Unchanged |
| Origin | Disallowed `Origin` header | Header check | 403 before authentication | Unchanged |
| Input | Too large or malformed | Validation | `LimitExceeded` or `ValidationFailed`, before any provider is called | Unchanged |
| TLS | Certificate missing or invalid on a non-loopback listener | Checks at start-up | The service refuses to start | Not listening |
| Client | Disconnects while a request is in flight | Socket closes | The operation still completes; a retry with the same operation id returns the stored outcome | Consistent |
| Search | Scan budget exceeded | Provider counter | `completeness: partial` with a reason | Unchanged |
| Purge | One boundary fails | Per-boundary result | The coverage report marks that boundary failed and what succeeded stays done; purge can be re-run with the same operation id | Partly purged, and reported |

Logs and errors name the operation, the provider, the memory id, the revision, the outcome and the error code. They never include content or metadata values.

## Concurrency and ordering

- **Database.** Each store has one SQLite database in WAL mode. Every mutation runs in a `BEGIN IMMEDIATE` transaction with a 5 s busy timeout. Readers never block the writer. Several processes on the same machine can open one store (embedded applications, the CLI, the service), and they serialise through SQLite.
- **Optimistic concurrency.** Every mutation of an existing memory must carry `expectedRevision`. It is checked inside the transaction, and a mismatch is `RevisionConflict` carrying the current revision. There are no unguarded updates, so a stale writer cannot undo a tombstone.
- **Create.**
  - The id is always generated, so two creates without a key make two memories.
  - Two concurrent creates with the same `(namespace, key)`: one wins, and the other gets `AlreadyExists` with the existing id.
  - A tombstoned memory keeps its key; a purge releases it.
- **Idempotency.** Operation ids are unique per principal. A retry with the same id and the same request returns the original outcome. A retry with the same id and a different request is `IdempotencyMismatch`.
- **History order.** `seq` is assigned in commit order, the drain exports in `seq` order, and the compare-and-swap keeps the Git branch linear. So each memory's revisions appear in history in revision order. The lease allows one drainer per store, and fencing plus the compare-and-swap cover lease expiry.
- **Remote clients.** They all reach the store through the one service process, so the same rules apply.
- **Reads.** A read sees the state committed when its statement starts. Separate pages of results are not one snapshot. For a given state, ordering is deterministic.

## Alternatives considered

1. **Approved: SQLite storage, a transactional outbox, Git as exported history, one application service.** Storage and history are atomic where it matters (the revision and its pending export commit together). History lags but is never lost or duplicated. Concurrency, crash recovery and search come from a proven database. Git stays a replaceable provider.
2. **Markdown files with a write-ahead journal and custom locks.** This is the most inspectable live state. But it rebuilds a database (atomic writes, cross-process locks, stale-lock recovery, interrupted-write repair, a search index) with less assurance. Rejected for v1. Markdown remains a possible later storage provider.
3. **Git as the canonical store.** One system holds both state and history. But Git becomes mandatory, concurrent writers turn into merge conflicts, search needs a separate index anyway, and purge would mean rewriting history. Rejected by premise 1.
4. **Write to storage, then to Git, inside the request, with a per-memory retry marker.** No outbox table. But a crash between the two loses a revision, and a later update overwrites an earlier revision that was never exported. Rejected.
5. **Separate implementations per adapter, with MCP as its own memory server.** Each transport could be tuned on its own. But the business rules would diverge and acceptance would be duplicated. Rejected by premise 5.
6. **Another core language (Go, C#, Python).** Rejected at the approaches gate; see the entry in 90-decisions.

## Open questions

- The npm package name and scope. This does not block building.
- Whether the remote profile accepts TLS that a reverse proxy terminates. v1 requires native TLS on any non-loopback listener.
- Whether the exported outbox ledger is ever pruned. It is kept for now, and its growth is measured in the baseline slice.
