# Slices — SubZeroDev.MemoryKit

Ordered riskiest assumption first. Each slice is one reviewable PR and leaves the system runnable. Each slice adds its scenarios to the shared conformance suite, and that suite runs against every adapter that exists at the time. Criterion ids are stable.

## S1 — Persist and retrieve a memory without a server
Status: done
Delivers: A conventional application, or a person at a terminal, creates a memory in a new store, exits, starts again and gets back the same memory with the same identity. No server runs and no model is involved.
Touches: project setup (TypeScript on Node, test runner, project commands in AGENTS.md and CLAUDE.md through the organisation's add-project-language script); model (MemoryRecord, ids, namespaces, errors, Limits); contracts (StorageProvider, partial: open, write, get); storage-sqlite (schema 1: memories, links, memories_fts, namespaces, operations, migrations); service (create, get); sdk (initStore, openStore); cli (init, create, get, `--json`); conformance (harness, SDK and CLI drivers)
Depends on: none
Acceptance:
  - S1.1 `initStore({ path })` on an empty directory creates a store; opening it reports WAL mode and FTS5 available. On a Node build without FTS5, opening fails with `StoreUnavailable`, `details.reason = "fts5_missing"`.
  - S1.2 `create({ namespace: "demo", kind: "note", content: "hello" })` returns `storage: "persisted"`, `history: "not_required"`, a 26-character ULID id, revision 1 and state `active`. A new process then calls `get(id)` and receives an equal record.
  - S1.3 `memorykit init <dir>`, then `memorykit create --store <dir> --namespace demo --kind note --content hello --json`, then `memorykit get <id> --store <dir> --json` in a separate process prints the same record and exits 0.
  - S1.4 `get` of an unknown id fails with `NotFound`; the CLI exits 1 and puts the problem JSON on stderr.
  - S1.5 `namespace: "Demo"`, `contentType: "application/json"` with content `{bad`, and content over `maxContentBytes` each fail with `ValidationFailed` or `LimitExceeded`, and no row is written.
  - S1.6 Opening a store whose `user_version` is greater than the code's fails with `StoreVersionTooNew`.
  - S1.7 One conformance scenario (create, then get) passes through both the SDK and CLI drivers from a single scenario definition.
Out of scope: update, search, history, lifecycle, any listener.

## S2 — Concurrent updates never silently overwrite
Status: todo
Delivers: Two clients that read the same revision cannot both update it. The second gets a conflict, and retries of the same request are safe.
Touches: service (update, idempotency, fingerprints); storage-sqlite (transactions, expected-revision checks, key uniqueness, operations table); model (RevisionConflict, AlreadyExists, IdempotencyMismatch); cli (update, `--operation-id`); conformance
Depends on: S1
Acceptance:
  - S2.1 Two separate OS processes both read revision 1 and both call `update` with `expectedRevision: 1`. Exactly one succeeds with revision 2. The other fails with `RevisionConflict`, `details.currentRevision = 2`. The stored content is the winner's.
  - S2.2 `update` with the same `operationId` and the same body twice returns the same outcome both times, and the revision is 2, not 3.
  - S2.3 Reusing an `operationId` with a different body fails with `IdempotencyMismatch`.
  - S2.4 Two processes concurrently `create` with `namespace: "demo", key: "k1"`. One succeeds; the other fails with `AlreadyExists`, `details.id` equal to the winner's id.
  - S2.5 A writer holding the lock past the busy timeout makes the other writer fail with `StoreBusy`, `retryable: true`, and nothing is persisted for the failed write.
  - S2.6 S2.1 to S2.3 pass through the SDK and CLI drivers.
Out of scope: history, lifecycle transitions.

## S3 — Every revision reaches a history provider through a durable outbox
Status: todo
Delivers: Each change is queued for history atomically with the change itself. A test history provider, with no Git at all, shows both the earlier and the current revision. Writes report honestly whether history has caught up.
Touches: contracts (HistoryProvider, OutboxEntry, HistoryEntry, ProviderDescriptor); storage-sqlite (outbox, drain_lease, queue); service (drainer, outcomes, operation status, history, revision, namespace policies and retention filtering, status); history-memory; sdk (history config); cli (history, revision, operation, status, namespace, history-sync); conformance
Depends on: S2
Acceptance:
  - S3.1 With `MemoryHistory`, create and then update a memory. `history(id)` returns revisions 1 and 2 in order, and `revision(id, 1)` returns the original content. No Git module is loaded, which is checked through the loaded module list.
  - S3.2 With a history provider rigged to fail retryably, `update` returns `storage: "persisted"`, `history: "pending"`, and the CLI exits 3. After the process is killed and the store reopened with a healthy provider, the open-time drain exports the entry, and `operation(opId)` reports `history: "persisted"`.
  - S3.3 Three updates while history is failing leave three pending entries. After recovery the provider holds revisions 2, 3 and 4, each with its exact content, so no intermediate revision is lost.
  - S3.4 A provider that records successfully but where the process dies before the mark: the next drain calls `record` again, the provider returns the same `historyRef`, and the revision count does not change.
  - S3.5 A non-retryable provider error marks the entry `blocked`. `status()` shows `historyQueue.blocked` with its seq and error code, and later entries are not exported. `syncHistory({ retryBlocked: true })` after the fault is fixed exports all of them in seq order.
  - S3.6 Under a namespace with policy `metadata`, the provider receives a record without content, with `contentHash` equal to the SHA-256 of the content. Under policy `none`, writes return `history: "not_required"` and `history(id)` fails with `HistoryNotRetained`.
  - S3.7 Two processes draining at once: exactly one holds the lease, and a mark carrying a stale fencing token returns false.
Out of scope: Git, lifecycle operations other than create and update.

## S4 — Git records the history, and survives crashes without duplicate commits
Status: todo
Delivers: Revisions become readable commits in a bare Git repository. A crash at any point recovers without losing or duplicating a revision.
Touches: history-git; sdk (git default, init creates `history.git`); service (provider health in status); conformance
Depends on: S3
Acceptance:
  - S4.1 After create and update in a store with Git history, `git -C <store>/history.git log main` shows two commits. Their subjects are `create demo/<id> r1` and `update demo/<id> r2`, and their `MemoryKit-Operation` trailers equal the operation ids. `git show main:demo/<id>/content.txt` prints the current content.
  - S4.2 Through `GitHistory`, `history(id)` and `revision(id, 1)` return the same results the S3.1 scenario gives with `MemoryHistory`, from one shared scenario.
  - S4.3 A fault injected after `update-ref` and before the mark: on restart the drain marks the entry without a new commit, and the commit count stays 2.
  - S4.4 Two drainers racing on the same entry, with an expired lease, produce exactly one commit, and the branch history stays linear.
  - S4.5 With `git` missing from PATH, writes return `history: "pending"` and `status()` names the provider error. Restoring PATH and calling `syncHistory()` exports everything.
  - S4.6 A repository whose `.memorykit/format` is `2` fails to open with `UnsupportedContractVersion`.
  - S4.7 Repository hooks (`reference-transaction`, `post-commit`) are not run during an export.
Out of scope: purge, push, remotes.

## S5 — Lifecycle: archive, supersede, tombstone and restore
Status: todo
Delivers: Applications can retire, replace, delete and restore memories, keeping current knowledge separate from obsolete knowledge. A stale writer cannot undo a delete.
Touches: model (transition table, InvalidTransition); service (archive, restore, tombstone, supersede, supersededBy); storage-sqlite (links, priorState); cli (archive, restore, tombstone, supersede); conformance
Depends on: S4
Acceptance:
  - S5.1 `supersede({ id: A, expectedRevision: 1, replacement: {...} })` returns a new memory B with a `supersedes A` link. `get(A)` shows `superseded` at revision 2 with `supersededBy: [B]`. Git holds commits for both, from one write.
  - S5.2 `tombstone` on A at revision 2 gives revision 3, `tombstoned`, `priorState: "superseded"`. Then `update` with `expectedRevision: 2` fails with `RevisionConflict`, and `restore` at revision 3 brings it back to `superseded`.
  - S5.3 `archive` on a tombstoned memory fails with `InvalidTransition`, and the revision is unchanged.
  - S5.4 After tombstoning, `history(id)` still lists every revision, including the tombstone revision.
  - S5.5 S5.1 to S5.3 pass through the SDK and CLI drivers.
Out of scope: search exclusion (S6), purge (S11).

## S6 — Bounded, deterministic lexical search
Status: todo
Delivers: Applications find memories by words, kind, state and metadata. Results are bounded, come back in the same order every time, and say plainly whether anything may be missing.
Touches: service (search); storage-sqlite (memories_fts maintenance, keyset cursors, scan budget); cli (search); conformance
Depends on: S5
Acceptance:
  - S6.1 With 30 memories in `demo` (10 containing "lighthouse"), `search({ text: "lighthouse", limit: 4 })` returns 4 items, then 4, then 2 through `nextCursor`, each page `complete`. The 10 ids are distinct, and repeated runs give the same order.
  - S6.2 A tombstoned memory containing "lighthouse" is absent by default and present with `states: ["tombstoned"]`. A superseded one is present only with `states: ["superseded"]`.
  - S6.3 `metadata: { priority: "high" }` and `kinds: ["lesson"]` narrow the results correctly. An update changes searchability inside the same transaction, so a search immediately after it sees the new content.
  - S6.4 With `scanBudget: 5` and 30 matches, the result is `completeness: "partial"` with `partialReason: "scan_budget"`.
  - S6.5 `limit: 101` fails with `LimitExceeded`.
  - S6.6 With no `text`, ordering is `updatedAt` descending, then id.
Out of scope: ranking beyond FTS5 bm25, embeddings.

## S7 — Namespaces and permissions are enforced in the core
Status: todo
Delivers: A host gives each caller a principal limited to certain namespaces and permissions. Requests outside those grants are refused before any protected data leaves storage.
Touches: access (Principal, Grant, authorize, permittedPatterns, EMBEDDED_PRINCIPAL); service (authorisation on every operation); storage-sqlite (RowScope in every by-id query and search); sdk (openStore with a principal); conformance
Depends on: S6
Acceptance:
  - S7.1 A principal with `read` and `write` on `team/a/*` creates in `team/a/notes`. Creating in `team/b` fails with `Forbidden`.
  - S7.2 `get` of a `team/b` id fails with `NotFound`, and the storage spy shows the query carried the `team/a/*` scope and returned no row.
  - S7.3 `search({ namespaces: ["team/b"] })` fails with `Forbidden`. `search({ text: "x" })` with no namespaces returns only `team/a` matches.
  - S7.4 `write` without `tombstone` cannot tombstone (`Forbidden` for a visible id), and `write` never permits `purge`, `admin` or `history`.
  - S7.5 `actor` on every revision is the principal id, even when the request's provenance claims another origin name.
Out of scope: authentication and listeners (S8, S9).

## S8 — A local service with an HTTP API
Status: todo
Delivers: Applications on the same machine reach a store through a loopback HTTP service that authenticates them with locally issued tokens. A typed client gives them the same interface as embedded use.
Touches: authn (LocalTokenAuthenticator); contracts (TokenStore); storage-sqlite (tokens); http (v1 routes, problem+json, Idempotency-Key, 202 for pending history); server (serve, local profile, Origin check, drainer loop); sdk (connect); cli (serve, token create, list and revoke; `--url`/`--token-env` for every command); conformance (HTTP driver)
Depends on: S7
Acceptance:
  - S8.1 `memorykit serve --store <dir> --listen 127.0.0.1:0` starts. `memorykit token create --principal app1 --grant "read,write:demo/*"` prints a secret once, and a create through `connect(url, { token })` succeeds.
  - S8.2 A request with no token gets 401 `Unauthenticated`, and a revoked token gets 401. `serve` with a non-loopback host and no TLS refuses to start.
  - S8.3 A request with `Origin: http://evil.example` gets 403 before authentication.
  - S8.4 A conflict returns 409 problem+json with `code: "RevisionConflict"` and `details.currentRevision`. A pending-history write returns 202 with `history: "pending"`.
  - S8.5 Every conformance scenario so far passes through the SDK, CLI and HTTP drivers.
  - S8.6 A client disconnecting during a write, then retrying with the same `Idempotency-Key`, receives the stored outcome, and only one revision exists.
Out of scope: OIDC, TLS, MCP.

## S9 — Remote access over TLS with OIDC
Status: todo
Delivers: Applications on other machines reach the service over HTTPS with tokens from a standard identity provider, and can only do what their scopes grant.
Touches: authn (OidcAuthenticator, scope parsing, ceiling); access (parseScopeClaim, intersectGrants); server (TLS, remote profile, protected-resource metadata); cli (serve with `--tls-cert`, `--tls-key`, `--oidc-issuer`, `--oidc-audience`, `--oidc-ceiling`); conformance (HTTP driver over TLS against a local test issuer)
Depends on: S8
Acceptance:
  - S9.1 Against a test OIDC issuer with a JWKS endpoint, a token with audience `memorykit-test` and scope `mk:read:demo/* mk:write:demo/*` creates and reads over HTTPS (S-B).
  - S9.2 Wrong audience, wrong issuer, an expired token, and a token signed with an unknown key each get 401. With the issuer offline and no cached key, the result is 503 `AuthenticationUnavailable`.
  - S9.3 Scope `mk:purge:*` with a ceiling of `read,write:demo/*` cannot purge (403). A token without `mk:read` for `team/b` gets `NotFound` for `team/b` ids (S-D).
  - S9.4 `GET /.well-known/oauth-protected-resource` returns the issuer and resource.
Out of scope: token issuance, client registration, reverse-proxy TLS.

## S10 — AI agents use the same memory over MCP
Status: todo
Delivers: An agent on the same machine (stdio) or another machine (Streamable HTTP) creates and retrieves memory through MCP, with the same results and permissions as every other interface.
Touches: mcp (tools, stdio binding, Streamable HTTP binding on the service, 2026-07-28 opt-in); server (mount `/mcp`); cli (mcp); conformance (MCP stdio and MCP over HTTP drivers)
Depends on: S9
Acceptance:
  - S10.1 An MCP client over stdio calls `server/discover`, then `memory_create`. A second client process, over Streamable HTTP with a local token, calls `memory_get` and receives an equal record (A5).
  - S10.2 Over remote HTTP with an OIDC token lacking the namespace, `memory_get` returns `isError: true`, `code: "NotFound"`. A missing token returns HTTP 401 before MCP dispatch (S-C).
  - S10.3 The full conformance suite passes through all five drivers: SDK, CLI, HTTP, MCP stdio and MCP over HTTP (A10, S-J).
  - S10.4 The tool list contains no purge, namespace or history-sync tool.
  - S10.5 A request naming an unsupported protocol version gets error `-32022` listing the supported versions.
Out of scope: MCP resources, prompts, subscriptions.

## S11 — Purge with an honest coverage report
Status: todo
Delivers: An administrator removes a memory's content from current storage and from the current history tree, and gets a report that says exactly what was removed and what was not.
Touches: service (purge, PurgeReport); storage-sqlite (purge, purges table, discarding pending entries); history-git (purge commit, purgeCoverage); history-memory (purgeCoverage); http (purge route); cli (purge); conformance (SDK, CLI, HTTP)
Depends on: S10
Acceptance:
  - S11.1 Purge of a memory with Git history reports: `current_storage: removed`, `pending_history: removed`, `history_current_tree: removed`, `history_past_revisions: retained`, `history_remotes: not_modified`, `external_copies: outside_control`. After it, `get(id)` gives `NotFound`, and `git show main:<ns>/<id>/record.json` shows `purged: true`.
  - S11.2 A purge while history is failing discards that memory's pending entries, so its content never reaches Git after recovery, and `pending_history: removed` is reported.
  - S11.3 A principal with `write` and `tombstone` but not `purge` gets `Forbidden`.
  - S11.4 Re-running a purge with the same operation id returns the same report. A purge with a stale `expectedRevision` fails with `RevisionConflict`.
  - S11.5 With `MemoryHistory`, the report reflects that provider's advertised capabilities, not Git's (S-I).
Out of scope: rewriting history, cleaning remotes.

## S12 — Installable package and measured baselines
Status: todo
Delivers: A developer installs MemoryKit from a packed tarball with no database or AI service and runs it end to end. Baseline numbers exist for later comparison.
Touches: package metadata (bin, exports, engines); a baseline benchmark script; README usage
Depends on: S11
Acceptance:
  - S12.1 `npm pack`, then installing the tarball into an empty directory, then `npx memorykit init`, `create` and `get` works on Node 22.18 and 24, on Windows and Linux CI.
  - S12.2 A consumer test that imports only the package's public entry type-checks and runs without importing SQLite or Git modules by path (A4).
  - S12.3 The benchmark prints median and p95 for create, get, search, revision retrieval and drain throughput at 1k and 10k memories, plus database and repository size. The results are committed as the baseline.
Out of scope: publishing to npm (needs the package name), performance targets.
