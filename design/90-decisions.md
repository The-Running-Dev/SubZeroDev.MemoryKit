# Decision log

Append-only. Newest at the top. The rejected alternatives are the point — without them, every future session relitigates the same choice.

## Open
- npm package name and scope.

Reopen any entry below only on a demonstrable contradiction or a genuine blocker (user, 2026-10-25).

---

## 2026-10-25 — No batched Git exports for now

- Context: batching pending revisions into fewer commits was approved only if cutting git processes did not fix drain throughput. On CI Linux the baseline drained 15.6 revisions per second at 1k memories and 4.4 at 10k; with five processes per export and the revision index it drains 53.5 and 27.8, so 10k revisions take 6 minutes instead of 38.
- Chosen: keep one commit per revision. Batching would add ordering, idempotency and per-revision addressing rules inside a commit to win back a factor below two.
- Revisit when: drain at 10k falls under about 20 revisions per second on CI, or a workload needs bulk import at a higher rate. What still grows with the store is the per-export `update-index` and `write-tree` over the whole tree, which batching would amortize.
- Rejected: batching now, as complexity the numbers do not call for.

## 2026-10-25 — Revision index for historical reads

- Context: revision retrieval scanned the whole branch with `git log` and then ran `git show` per file, so it took 94 ms at 1k memories and 928 ms at 10k on CI Linux, growing with history.
- Chosen:
  - A rebuildable index file, `memorykit/revisions` inside the repository directory, with one line per commit: commit, first parent, memory id, revision and directory, each line ending in a truncated SHA-256 checksum. It is appended after each successful `update-ref` and rewritten from `git log --first-parent` when a read finds it short, damaged or wrong.
  - Entries record only facts a commit id fixes, so an entry is never stale for its commit. Branch membership is decided on every read by `rev-parse` and a walk of the parent links from the head, so entries of commits that are no longer on the branch are never used.
  - Every returned field is read from Git: one `cat-file --batch` returns the commit, `record.json` and content. A commit whose trailers do not match its entry, a missing object, or a requested revision absent from the walk triggers one rebuild and then the full scan.
  - A read is two git processes regardless of history length.
- Known limit: `list` takes the set of a memory's commits from the walk. A line that passes its checksum but names the wrong memory would hide a revision from `list` until the next rebuild; `get` of a missing revision always falls back to the scan.
- Rejected: storing the index in SQLite, which would make the store database hold history facts; `git notes` or a second ref, which add writes to every export; a full cache of record contents, which would become a second copy of history.

## 2026-10-25 — Fewer git processes per exported revision

- Context: the S12 baseline drained 15.6 revisions per second at 1k memories and 4.4 at 10k on CI Linux, and about 1.3 on Windows. A profile at 200 memories showed eleven `git` processes per export, each costing 66 to 84 ms on Windows, and a `read-tree` of the whole tree per export that grows with the repository.
- Chosen:
  - The provider remembers the commit it last moved the branch to and keeps its temporary index, which holds that commit's tree. When the entry's `after` is that commit, it skips reading the head, the scan and `read-tree`, and uses the commit as the compare-and-swap's old value. If another writer has moved the branch, the compare-and-swap is refused and the next attempt reads the head and scans as before, so a commit made by a drainer that crashed before its mark is still found.
  - The scan is skipped whenever the head is `after`, since the range between them is empty.
  - One `hash-object --stdin-paths` writes every blob, from files in the provider's scratch directory. The format file is written only with the first commit; later trees already hold it.
  - Exports run one at a time per provider, since they share the index. Any failure or refused compare-and-swap discards the kept index.
  - The happy path is five processes: `hash-object`, `update-index`, `write-tree`, `commit-tree` and `update-ref`. `bench/baseline.ts` now counts processes per exported and per retrieved revision and checks that every revision is a commit addressable by memory and revision.
- Rejected: `git fast-import`, which writes one pack per run and has no compare-and-swap of its own; `update-index --add` from a worktree, which brings line-ending and filter conversion back; writing objects in-process, against plumbing-only access to the repository.

## 2026-10-25 — Package and baseline as built (S12)

- Context: S12 needs an installed package exercised end to end on the CI matrix, a consumer limited to the public entry, and committed baseline numbers. Exporting each revision to Git spawns about ten `git` processes, which on the Windows development machine drains about 1.4 revisions per second, so 10k memories would take about two hours there.
- Chosen:
  - `scripts/check-package.ts` (`npm run check:package`) packs the package, installs the tarball into an empty directory, runs `memorykit init`, `create` and `get` through `npx`, then type-checks `tests/consumer/consumer.ts` against the installed declarations and runs it. CI runs it as a step on every matrix job.
  - The consumer imports only `subzerodev-memorykit` and asserts a deep import fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. It is excluded from the repository type check, since only an install resolves the package by name.
  - `bench/baseline.ts` (`npm run bench`) times creates while holding the drain lease, so they measure the write path alone, then drains the whole backlog in one timed sync. A fixed-seed generator makes every run write the same store.
  - The committed baseline in `bench/baseline.md` comes from the `bench` CI job on ubuntu-latest with Node 24, run by `workflow_dispatch` only, which writes the table to the job summary.
- Rejected:
  - Running the benchmark in `npm test` or on every push: it takes minutes and its numbers are not pass or fail.
  - A local Windows baseline: the drain figure would describe process spawning on that machine, not the store.
  - Uploading the table as a workflow artifact: the job summary is readable without a download.

## 2026-10-25 — Purge as built (S11)

- Context: S11 adds purge on the SDK, HTTP and CLI. The contract's storage signature returned a boundary result and an outbox seq the service does not need, and did not say how a replay rebuilds its report or what happens to history the purge cannot wait for.
- Chosen:
  - `StorageProvider.purge(id, scope, PurgeRequest): Promise<PurgeOutcome>` in one transaction: replay check, revision check, discard of the memory's pending and blocked entries (exported, `history_ref = 'discarded'`, payload nulled), row deletion, the purge outbox entry, the operations row and the `purges` row.
  - The `purges.report` column stores the facts `{ pendingDiscarded, queued }`; the service derives the report on every call. Re-running the same operation id after history catches up reports `history_current_tree: removed`, which S11.2 relies on.
  - A history boundary the provider would remove is reported `failed` until the purge entry is persisted, with a detail saying to re-run the same operation id. The CLI exits 3 for that, as for any write with history pending.
  - No purge entry is queued without a history provider, or when the namespace policy is `none` and nothing of the memory was exported; history boundaries are then `not_modified`. A queued entry under policy `none` (exported earlier) is recorded as `metadata`.
  - Stored outcomes of earlier writes that name the purged id are scrubbed: the outcome is nulled when it is that memory, and the id is dropped from `related` otherwise. Replays of those writes then report only what still exists.
  - `operation()` skips discarded entries, so an operation whose entries were all discarded reports history `not_required`; `lastExportedRef` ignores them.
  - Git: a purge commit writes `record.json` as `{ id, namespace, purged: true, at }` and removes every content file; the provider advertises `purge.history` and the limitation `purge-keeps-past-revisions`. Past revisions are `retained`, remotes `not_modified`.
  - MemoryHistory drops every stored revision of the memory, so it reports past revisions `removed` (S11.5). Its refs now come from a counter, since a purge shrinks the list.
  - Visibility follows writes: any id the caller can read, write, tombstone or purge is `Forbidden` without `purge`; anything else is `NotFound`. Purge stays off MCP.
- Rejected:
  - Storing the rendered report: a replay could never report an export that completed after the first call.
  - Waiting for history inside the storage transaction, or failing the purge when history is down: the row and pending content would stay while the outage lasts.
  - Rewriting Git history to drop past revisions: out of scope for S11, and the report says they are retained.
  - Cancelling an export already in flight when the purge commits: it may still land, but the purge commit then replaces its tree, and past revisions are already reported retained, so the report stays true.

## 2026-10-25 — MCP as built (S10)

- Context: S10 serves the service over MCP on stdio and Streamable HTTP. The design left the accepted revisions open and did not say how tool schemas, validation, write options or the HTTP principal are handled.
- Chosen:
  - Only 2026-07-28 is accepted, on stdio and HTTP (`legacy: 'reject'` in SDK v2 2.4.0). A 2025-era request gets `-32022` with `data.supported: ["2026-07-28"]`. This settles the open question on MCP revisions.
  - Tool input schemas are hand-written JSON Schema passed through `fromJsonSchema` with a validator that accepts everything, so the service is the only validator and a bad input is the same domain error as on every other surface. No `outputSchema`.
  - Write tools take optional `operationId` and `waitForHistoryMs` beside the service input; they are taken off before the call because the service rejects unknown fields.
  - `memory_history` returns `{ revisions: [...] }`, because `structuredContent` must be an object.
  - `/mcp` is authenticated by the server's own authenticator before MCP dispatch, so 401/403 and the resource-metadata challenge are unchanged. Only the principal reaches the MCP handler (`authInfo.extra.principal`); the token is not forwarded.
  - HTTP uses `responseMode: 'json'`; the SDK logs once to stderr that this drops mid-call notifications, which these tools never send.
  - `subscriptions/listen` over HTTP is answered `-32601` before dispatch: no subscriptions are offered, and an open stream would hold `close()` forever. Each MCP request is aborted when its client disconnects.
  - `memorykit mcp --store <dir>` serves stdio for the embedded principal; stdout carries only protocol messages.
  - `@modelcontextprotocol/server` ^2.4.0 is a runtime dependency; `@modelcontextprotocol/client` is a dev dependency used only by tests.
  - The MCP conformance drivers run `init`, `status` and namespace calls through the SDK, since those are not MCP tools.
- Rejected:
  - Also answering 2025-era clients statelessly: a second protocol surface to test and secure for clients the design does not target.
  - Zod schemas or SDK-side validation: they turn bad input into protocol errors instead of domain codes.
  - Forwarding the bearer token to the MCP layer: nothing there needs it.

## 2026-10-25 — Remote access as built (S9)

- Context: S9 adds TLS, the remote profile and OIDC bearer tokens. The contract fixes the shapes but not the token rules, key handling or how scopes become grants.
- Chosen:
  - Signatures RS256/384/512, PS256/384/512, ES256/384 and EdDSA, with Node's crypto only. `none` and HMAC are refused.
  - Keys come from the issuer's discovery document and JWKS. They are trusted for 10 minutes after a fetch and used until then even when the issuer is down. A key miss refreshes at most once every 30 seconds. With no usable key the answer is 503 `AuthenticationUnavailable`; an unknown key while keys are fresh is 401.
  - `iss` must equal the configured issuer exactly, `aud` must include the audience, `exp` and `nbf` allow 60 seconds of clock skew, and `sub` (at most 256 characters) is the principal id.
  - Only `mk:<permission>:<pattern>` scope items grant anything; others are ignored. Each permission takes the narrower of its pattern and a ceiling pattern holding it. Patterns that only partly overlap grant nothing.
  - `OidcAuthenticator` also takes optional `keyTtlMs`, `minRefreshIntervalMs` and `fetch`, beyond the contract's options.
  - The issuer must be https, or http on a loopback host (for tests and local issuers). The `jwks_uri` is held to the same rule, redirects are not followed, a key set with no usable key counts as a failed fetch, and the key TTL is never shorter than the refresh interval.
  - Protected-resource metadata has `resource` set to the audience, one authorization server and header bearer only. Remote 401s carry `WWW-Authenticate: Bearer resource_metadata="…"`, built from the request's Host when it is a bare host[:port], else from the bound address, so a wildcard bind or a proxy still names a reachable URL.
  - TLS works with either profile; without it only loopback is allowed. CLI `serve` takes `--tls-cert`/`--tls-key` and `--oidc-issuer`/`--oidc-audience`/`--oidc-ceiling`, each group all or none.
  - A self-signed localhost certificate is committed under `tests/fixtures/tls` (expires 2126). The certificate and key are checked as a pair before the store opens.
- Rejected:
  - A JWT library: a runtime dependency for what Node's crypto already verifies.
  - Unioning partially overlapping patterns: it would grant namespaces neither side named alone.
  - Refetching keys on every miss: forged key ids or an outage would turn every request into an issuer call.
  - Generating the test certificate at test time: it needs openssl on every runner.
  - A configured public base URL for the challenge: a contract option for what the Host already says; a spoofed Host only misleads the client that sent it.

## 2026-10-25 — HTTP service as built (S8)

- **Context:** S8 serves the store over HTTP API v1 with local tokens. The design left the listen default, Origin handling, body limits, status mapping for non-exported history, and the token CLI shape to the build.
- **Chosen:**
  - A write whose history is `pending` or `blocked` answers 202; a fully exported write answers 200 or 201. The body is the same `WriteOutcome` either way.
  - `waitForHistoryMs` is not carried over HTTP; the service applies its own configured wait.
  - `memorykit serve` listens on `127.0.0.1:7600` by default. A non-loopback host without TLS is refused with `ValidationFailed` on `tls`; TLS and the remote profile answer `Unsupported` (`server.remote`) until S9.
  - The Origin allow-list is empty by default. A request carrying a disallowed `Origin` gets 403 `Forbidden` (`reason: origin`) before its token is read; a request with no `Origin` is allowed. No CORS response headers or preflight handling: browser use is out of scope for v1.
  - Request bodies are capped at 4 MiB; a larger one gets 413 `LimitExceeded` and the connection is closed.
  - An unknown route or method is 404 `NotFound`. No purge route until S11.
  - Token secrets are `mk_` plus 32 random bytes in base64url; only their SHA-256 is stored. `token create|list|revoke` run against `--store` only, never over the API. Grants are checked when issued and again when a request is served.
  - `--grant` is `<permissions>:<pattern>`, split at the first `:`.
  - CLI commands reach a service with `--url` and read the token from the variable named by `--token-env`, so the secret never appears in a process list.
- **Rejected:**
  - 200 for pending history: hides that the export has not happened yet.
  - Passing tokens as a CLI argument: visible to other local users.
  - Answering preflight requests: no browser client is planned for v1, and an allow-list without CORS headers is the smaller surface.

## 2026-10-25 — Permissions as built (S7)
- **Context:** S2 to S6 already authorised every operation as it was built. S7 had to prove the rules end to end and settle what happens to a host-supplied principal that is malformed.
- **Chosen:**
  - `MemoryService.as(principal)` validates the principal (a non-empty id of at most 256 characters, a known profile, valid grant patterns, known permissions) and keeps a frozen copy. A malformed principal is `ValidationFailed` with a `principal.*` field, and a host changing its object later cannot widen an open client.
  - `history` and `revision` look the id up within the `history` grants only, so a visible id without `history` is `NotFound`, as the design's by-id rule says; transitions stay `Forbidden` for a visible id.
  - The `actor` on every revision is the client's principal id. Provenance is stored as given and never read for the actor.
  - The acceptance tests drive the SDK directly. The conformance surfaces get a principal only once S8 issues local tokens, so the cross-surface permission scenarios land with S8.
  - `purge` never being implied by `write` is tested with purge itself in S11.
- **Rejected:**
  - Trusting the host's principal as given: one bad grant pattern would otherwise fail later, inside a query, as an internal error.
  - `Forbidden` for history on a visible id: it would tell a caller without `history` that the id exists in a namespace it can read, which the by-id rule does not distinguish.

## 2026-10-25 — Search as built (S6)
- **Context:** The contract fixes the query, the result shape and the scan budget, but leaves open what a cursor holds, how a partial page resumes, where the metadata filter runs and how a named pattern is authorised.
- **Chosen:**
  - A cursor is base64url JSON holding the last row a page examined (its bm25 rank with text, its `updatedAt` without) and its id, plus a SHA-256 fingerprint of the text, kinds, states, metadata and the namespace patterns the search ran with. A cursor from another query or principal scope is `ValidationFailed` (`invalid_cursor`).
  - A page that stops at the scan budget is `partial` / `scan_budget` and still carries a cursor, so following cursors reaches every match. The budget counts rows examined after the SQL scope, state and kind filters; the metadata filter runs on those rows in JS, by own-key strict equality.
  - Text is split on whitespace; each word holding a letter or digit is quoted for FTS5 and the words are ANDed. Text with no such word is `ValidationFailed` (`no_terms`), never an empty page.
  - A named pattern must be covered by one `read` grant: `*` only by `*`, a subtree `a/*` only by a subtree grant over `a`, an exact namespace by any grant matching it. An empty `namespaces` array is `ValidationFailed`.
  - The CLI repeats `--namespace`, `--kind` and `--state` for search; every other command rejects a repeated `--namespace` or `--kind`.
  - The default scan budget is 10,000 rows, set per store through `SqliteStorageOptions.scanBudget`.
- **Rejected:**
  - A time budget: `time_budget` stays in the contract, but nothing produces it until a provider needs one.
  - Offset cursors: inserts between pages shift them. Keyset cursors can still move a row whose bm25 rank changes between pages, because rank depends on the whole corpus; pages are stable while the corpus is.
  - Metadata filtering in SQL through `json_extract`: equality on mixed JSON types is easier to get exactly right in JS, and the budget bounds the cost.

## 2026-10-25 — Lifecycle as built (S5)
- **Context:** The contract names archive, restore, tombstone and supersede but leaves open how a supersede is recorded, which permission a restore needs, and what a transition may change besides the state.
- **Chosen:**
  - A supersede is one operation, `supersede`, with two writes: the replacement first (revision 1), then the target (its revision + 1, `superseded`). Each write gets its own outbox entry, so Git holds two commits sharing one `MemoryKit-Operation` trailer. The outcome's `memory` is the replacement and `related` holds the target.
  - The replacement's namespace defaults to the target's. An explicit namespace needs `write` there as well. A `supersedes` link to the target is added when the caller leaves it out, never duplicated.
  - Replacement validation errors name the field without a prefix (`content`, not `replacement.content`), matching create.
  - Transitions load the memory within the caller's `read`, `write` and `tombstone` patterns, then authorise before comparing the revision: `archive` needs `write`, `tombstone` needs `tombstone`, `restore` needs `tombstone` when the memory is tombstoned and `write` otherwise. A visible id without the permission is `Forbidden` (S7.4), never `RevisionConflict`; an id outside all three is `NotFound`.
  - A principal allowed to change a memory sees it in the outcome, so `tombstone` without `read` reveals the record it tombstones.
  - A transition takes an optional `provenance`, which replaces the memory's when given. Content, kind, metadata and links never change in a transition.
  - Replays load the outcome with the same patterns as the operation's first load, and leave out related records no longer visible under them.
  - An operation's history status is the worst of its outbox entries (`blocked`, then `pending`, then `persisted`); its ref is the last entry's.
  - An exported target's `supersededBy` may name a replacement in a namespace with policy `none`: only the opaque id leaves, never its content.
  - The CLI transitions take an id and `--expected-revision` only; record flags fail with `UsageError`. The text output prints one line per related record.
- **Rejected:** Recording a supersede as a create plus a separate transition (two operations, so a crash could leave the replacement without the superseded target); prefixing replacement field names; letting a transition edit fields.

---

## 2026-10-25 — Git export hardening from the S4 review (S4)
- **Context:** Review of the S4 provider found ways an export could duplicate commits, write outside the repository, crash the host or block on an outage.
- **Chosen:**
  - The actor is percent-encoded in its `MemoryKit-Actor` trailer and decoded on read, so a principal id with a line break or comma cannot forge a trailer.
  - Inherited `GIT_*` variables are dropped from the git environment; only the identity, index and prompt variables the provider sets are passed.
  - Only an `update-ref` refusal that names a moved, existing or locked ref counts as contention; any other exit 128 fails with `git_failed`. The format check uses `ls-tree`, so a failed read is not taken as a missing format file.
  - A failed object write during an attempt (two drainers writing the same loose object collide on Windows) retries the attempt.
  - A provider error may carry `details.outage: true`. The drainer never blocks an entry for an outage, however many attempts it takes; `git_unavailable` is one.
- **Rejected:**
  - Rejecting control characters in principal ids at the service: tokens and OIDC subjects arrive in S8 and S9, and the provider should not depend on that.

## 2026-10-25 — Git history as built (S4)
- **Context:** S4 makes Git the default history and needs provider health in status; building it settled details the design left open.
- **Chosen:**
  - With no `history` config a store uses Git at `<path>/history.git`. `initStore` creates the repository, and providers load by dynamic import, so a store on `memory` or `none` never loads the Git module (S3.1 still holds).
  - Provider health is `historyQueue.lastError`: the code of the oldest pending entry's last failed export (`git_unavailable`, `git_failed`, `contention`), read from the outbox. It is a contract addition to `HistoryQueue`, so it reaches `status()`, `syncHistory()` and the CLI (`history error:` line).
  - The branch moves with `update-ref <ref> <new> <old>` (empty old value when the branch is absent). A refused swap exits 128; the export rescans for its commit and retries up to 8 times, then fails retryably with `contention`.
  - A revision's `at` comes from `record.json` `updatedAt`, since Git dates keep whole seconds.
  - A missing `git` executable does not stop a store opening: exports stay pending with `git_unavailable`. A repository of an unknown format does stop it, and `MemoryService.open` closes storage when the history provider fails to open.
  - Every git call passes `-c core.hooksPath=<repo>/memorykit-no-hooks -c commit.gpgSign=false` and uses plumbing only.
- **Rejected:**
  - Holding the last provider error in the service: a CLI `status` in another process would never see it.
  - `update-ref --stdin` transactions: the same compare-and-swap with more code.

## 2026-10-25 — Outbox and history surfaces as built (S3)

- **Context:** S3 needed contract details the design leaves open: how the drain lease ends, how old operations go, how retries are counted, and who may call the new admin and status surfaces.
- **Chosen:**
  - Storage contract additions: `releaseDrainLease`, `pruneOperations(before)`, `nextOutbox` returning the entry with its attempt count, and `tx.supersededBy` so the outbox payload carries the derived field. `HistoryProviderError(message, retryable, details)`; the problem code is `details.reason` when present.
  - The SDK default provider stays `none` until S4 ships Git; `memory` is selectable for tests and embedding. MemoryHistory reports `purgeCoverage` unsupported until S11.
  - `status` needs any read grant; `syncHistory` and `setNamespacePolicy` need admin on `*` and the namespace. `getNamespace` returns the effective policy, `full` when none is set.
  - `close` waits for an in-flight drain. The `operation` CLI command exits 0 whatever the history state; writes and `history-sync` exit 3 while history is pending or blocked.
  - The CLI takes its `openStore` as an injected dependency so tests can drive a provider that lives only in one process.
- **Rejected:** a lease that expires only by TTL, which leaves a closed store's lease blocking the next open for 30 s; counting attempts in the service, which forgets them on restart; letting any principal force a drain.

## 2026-10-25 — Replays re-check write access; stored outcomes keep content (S2)

- **Context:** review of S2 found a replay returned the stored outcome before any grant check, and that `operations.outcome` holds the full record whatever the namespace history policy.
- **Chosen:** a replay re-loads the memory within the caller's current write grants and is NotFound when it is not visible. The stored outcome stays whole; it is local SQLite state under the same protection as the row itself, and S3's retention redaction and later purge clear it with the row.
- **Rejected:** storing a policy-redacted outcome, which would make a replay differ from the first answer; skipping the check on replay, which lets a revoked principal read content.

## 2026-10-25 — `supersedes` links stay plain links until S5 (S2)

- **Context:** create and update accept any link type, so a `supersedes` link changes another record's derived `supersededBy` without a lifecycle transition, including a self-link.
- **Chosen:** keep S2 as is; S5's supersede operation owns the transition, and from S5 a plain write that adds a `supersedes` link is refused.
- **Rejected:** refusing `supersedes` in S2 before the operation that replaces it exists.

## 2026-10-25 — Replays return the stored outcome; schema 2 keeps it (S2)
- **Context:** the design says a replayed operation returns its stored outcome, but schema 1's `operations` table kept only the memory id and revision, so a replay after a later write would have returned the later revision.
- **Chosen:** schema 2 adds `operations.outcome`, the JSON of the memory record and related records as written. A replay returns it, with `supersededBy` derived and history status re-read at replay time. Operations recorded under schema 1 have no outcome and replay from the current row. Purge (S8) must clear `outcome` on the purged memory's operations, since it holds content.
- **Rejected:** rebuilding the outcome from history — history may be `none` or `metadata`; returning the current row — a retry after a later write would report a revision the request never produced.

## 2026-10-25 — What an update may change (S2)
- **Context:** the contract lists the fields of `UpdateInput` but not what an update that names none of them does, nor how the CLI treats a malformed `--expected-revision`.
- **Chosen:** `namespace` and `key` cannot be updated, so an input naming them fails with `ValidationFailed` (the CLI refuses the flags as a usage error). Provenance, like links and metadata, is replaced whole when given. An update that names no field still writes a new revision, which records the actor and time. A non-integer `--expected-revision` is passed through and fails as `ValidationFailed`, exit 1, matching the SDK.
- **Rejected:** a no-op update returning the current revision unchanged — it would hide a client bug and break the revision-plus-one rule; key renames — the key is the natural identity that concurrent creates converge on.

## 2026-10-25 — Input bounds the contract leaves open (S1)
- **Context:** the contract fixes namespaces and the four `Limits`, but not the length or alphabet of keys, kinds and operation ids, nor whether unknown input fields are accepted.
- **Chosen:** `key` at most 512 characters and `kind` at most 128, neither empty nor containing control characters; operation ids match `[A-Za-z0-9._:-]{1,128}`; serialized provenance counts against `maxMetadataBytes`; unknown fields in a create input fail with `ValidationFailed`. Structural checks run before limit checks, so an input that is both malformed and oversize reports `ValidationFailed`.
- **Rejected:** unbounded keys and kinds — they become Git path components and index entries; silently dropping unknown fields — a misspelt field would be lost without an error; a separate provenance limit — one more knob with no use case yet.

## 2026-10-25 — Problem documents use `urn:memorykit:error:<Code>` as their type (S1)
- **Context:** the contract defines the problem JSON fields but not the value of `type`, and the value is public on the CLI and HTTP surfaces.
- **Chosen:** `type` is `urn:memorykit:error:` followed by the error code. A non-MemoryKit error is reported as `Internal` with the fixed title "Internal error", so no content or stack reaches a caller.
- **Rejected:** `about:blank` — loses the code in the type field; an `https://` URL — implies a documentation site that does not exist.

## 2026-10-25 — Memory identity is a core-generated ULID, with an optional application key
- **Context:** the seed's identity-scheme question; concurrent creates must not duplicate an identity.
- **Chosen:** the core generates a ULID for every memory. An application may also give a `key` that is unique per namespace, so concurrent creates for the same natural identity converge (`AlreadyExists` with the existing id). Namespaces are lowercase paths, immutable after create.
- **Rejected:** application-supplied ids as the primary identity — collisions across applications, and no uniform format; UUIDv4 — not time-ordered; mixed-case namespaces — collide on case-insensitive filesystems in Git paths.

## 2026-10-25 — Every mutation of an existing memory requires the expected revision
- **Context:** premise 2 allows unguarded updates; a stale writer must not undo a tombstone.
- **Chosen:** no unguarded updates. Every update, transition and purge names `expectedRevision`. Operation ids make retries idempotent per principal.
- **Rejected:** an optional "force" or last-writer-wins mode — reintroduces silent overwrites.

## 2026-10-25 — Links live on the record; supersede creates the replacement
- **Chosen:** links are part of the source memory and are revised with it. `supersede` creates the replacement and moves the target to `superseded` in one transaction. Revisions number every change, including lifecycle changes.
- **Rejected:** a separate link resource with its own revisions — two concurrency domains for one record; superseding with an existing memory — not needed for v1.

## 2026-10-25 — Git export: bare repository, plumbing commits, compare-and-swap, trailers
- **Context:** the outbox requires idempotent export with no duplicate commits, even if a drain lease expires while its holder is stalled.
- **Chosen:**
  - The repository is bare. Each revision is one commit built with plumbing commands, and the branch moves by an atomic `update-ref` compare-and-swap.
  - Idempotency comes from a `MemoryKit-Operation` trailer, scanned back to the last acknowledged reference.
  - Each memory is stored as `record.json` plus its content file, byte for byte.
  - Global `seq` order applies; a permanently failing entry blocks the queue visibly until an operator retries it.
- **Rejected:** a working-tree repository with `git commit` — hooks, index locks and a working tree users might edit; Markdown with front matter — lossy for JSON content, and Markdown is a later storage provider; per-memory export order that skips blocked entries — harder to reason about for v1; a custom lock file around Git — the custom locking already rejected.

## 2026-10-25 — Ids outside the caller's grants are NotFound; named namespaces are Forbidden
- **Chosen:** storage applies the caller's permitted patterns inside the query, so protected rows never leave the provider. An id outside them is `NotFound`; a request naming an ungranted namespace is `Forbidden`.
- **Rejected:** `Forbidden` for ids — reveals that the id exists; loading and then checking — the provider returns protected data first (S-D).

## 2026-10-25 — Purge, namespace policy and history sync are not MCP tools in v1
- **Chosen:** MCP exposes the memory, search, history and operation tools. Purge and the administrative operations are available through the SDK, the CLI and HTTP only.
- **Rejected:** every operation over MCP — puts destructive and administrative actions in agent tool lists for no v1 need. Revisit when an agent use case needs them.

## 2026-10-25 — Remote grants come from the token scope, capped per issuer
- **Chosen:** a JWT's `scope` claim carries `mk:<permission>:<pattern>` grants, intersected with a ceiling configured for the issuer. Local-service tokens are stored as SHA-256 hashes with their grants.
- **Rejected:** a server-side table of principals to grants — duplicates the identity provider's job; trusting the scope with no ceiling — a misconfigured issuer could grant everything.

## 2026-10-25 — Architecture selection is final for v1
- **Context:** the approaches checkpoint, reviewed by the user with Codex and Sol.
- **Chosen:** TypeScript/Node core; SQLite as the first storage provider; Git as the first history provider; embedded SDK, CLI, HTTP API and MCP over one service; every provider replaceable through MemoryKit contracts.
- **Rejected:** further redesign rounds — no new evidence justifies them.

## 2026-10-25 — TypeScript on Node is the v1 language
- **Context:** D3. AgentKit and GodComplex (including its engine package) are TypeScript, so both can embed MemoryKit directly; other languages use HTTP, MCP or the CLI. All four Tier 1 MCP SDKs support the 2026-07-28 specification; the TypeScript v2 SDK needs an explicit opt-in to speak it.
- **Chosen:** TypeScript on Node, minimum Node 22.18 to match AgentKit's floor. In-process providers are TypeScript in v1.
- **Rejected:** Go — best single-binary distribution, but neither existing consumer could embed it; C#/.NET — strongest built-in authentication, but neither existing consumer could embed it; Python — weakest packaging for a CLI and service, no consumer fit.
- **Revisit when:** a consumer that must embed MemoryKit is not JavaScript or TypeScript, or the out-of-process provider protocol is designed.

## 2026-10-25 — SQLite is the first storage provider
- **Context:** D4. The file-and-journal approach meant building a crash-safe store, write-ahead journal, cross-process locking, stale-lock recovery, revision checks, interrupted-write recovery and search — a database, reimplemented.
- **Chosen:** SQLite in WAL mode: transactions, crash recovery, cross-process write serialisation and FTS5 lexical search. The database lives on a local filesystem; remote users reach it only through the service. Built-in `node:sqlite` is preferred, so there is no native dependency.
- **Rejected:** files plus a custom journal and locking — reinvents SQLite; Markdown files as the store — kept as a possible later provider, not built in v1; one owner per store as a universal restriction — narrows the agreed concurrency premise.
- **Revisit when:** `node:sqlite` lacks FTS5 or WAL behaviour on a supported Node version (fallback: a maintained native SQLite binding), or measurements show SQLite is the bottleneck.

## 2026-10-25 — A transactional outbox carries revisions to history
- **Context:** premise 1. Retrying "on next open" is too weak: pending history must survive crashes, keep the exact revision, and recover without duplicate commits.
- **Chosen:** each write commits the memory change and an outbox entry holding the exact revision snapshot in one SQLite transaction. The history provider drains entries in sequence order, one drainer per store, and each export is idempotent by operation identity. A write reports history persisted only once its entry is exported.
- **Rejected:** writing Git directly inside the request with no outbox — a crash between storage and Git loses the revision; one pending marker per memory — later updates overwrite earlier unexported revisions; distributed transactions — out of proportion.

## 2026-10-25 — Git history is readable revision files
- **Context:** inspectability without making Markdown the store.
- **Chosen:** the Git provider writes one human-readable file per memory into its own repository and commits once per exported revision, with MemoryKit identifiers in commit trailers. It drives the installed `git` executable. No push in v1.
- **Rejected:** a pure-JavaScript Git implementation — narrower feature coverage, and purge work later needs full Git; Git as canonical state — rejected with premise 1.

## 2026-10-25 — Three security profiles, one authorisation model
- **Context:** OIDC everywhere would make local use need an identity provider.
- **Chosen:** embedded trusts the host process and OS; local service binds loopback only and authenticates with locally issued bearer tokens; remote service requires TLS and validates JWTs from a configured OIDC issuer. All three resolve to a principal with namespace grants, and authorisation is identical.
- **Rejected:** OIDC for every mode — forces an identity provider on local users; no authentication for the local service — any local process could act as any principal; a custom identity provider — unnecessary.

## 2026-10-25 — One service process hosts the HTTP API and remote MCP
- **Chosen:** a single listener serves the versioned HTTP API and MCP over Streamable HTTP through the same service and authenticator. MCP over stdio runs embedded.
- **Rejected:** separate API and MCP processes — two deployments enforcing one policy; MCP as the only remote interface — conventional applications would need an MCP client.

## 2026-10-25 — Retention policy per namespace: full, metadata or none
- **Context:** content must not enter permanent Git history when policy forbids it.
- **Chosen:** each namespace has a history policy: `full` exports content, `metadata` exports everything except content and metadata values (recording a content hash), `none` exports nothing and history is not required. Default `full`.
- **Rejected:** a single store-wide policy — namespaces mix sensitive and ordinary memory; deferring retention — the brief requires it before content reaches history.

## 2026-10-25 — `AGENTS.md` is the canonical instruction entry point
- **Context:** `AGENTS.md` and `CLAUDE.md` both held scaffold content, so `ensure-project-files.ts` reported the shared-contract pointer as Ambiguous.
- **Chosen:** add the shared-contract section and a pointer to `design/` to `AGENTS.md`; add an `@AGENTS.md` import to `CLAUDE.md` so Claude Code reads it. Both files otherwise unchanged.
- **Rejected:** putting the pointer in `CLAUDE.md` — other agents would not see it; replacing `CLAUDE.md` with a bare import — destroys content the user asked to keep; duplicating the pointer in both — two copies drift.

## 2026-10-25 — v1 search is lexical and bounded
- **Context:** premise 6, adjudicated.
- **Chosen:** exact ID lookup, lexical matching, scope, lifecycle-state and metadata filters, bounded results, deterministic order, explicit complete/partial indicators. A query that hits a resource limit says its results may be incomplete; permission filtering never leaks content or metadata.
- **Rejected:** embeddings, vector databases, graph engines or LLM ranking as mandatory parts — they need infrastructure the install footprint forbids, and belong to optional future providers.

## 2026-10-25 — Every adapter goes through one application service
- **Context:** premise 5, adjudicated, with the HTTP API added.
- **Chosen:** embedded SDK, CLI, HTTP API, MCP stdio and MCP over HTTP call the same application service; equivalent authorised requests give equivalent records, identities, lifecycle and concurrency behaviour, domain errors and ordering. One shared conformance suite runs against all five.
- **Rejected:** per-adapter business rules — writes would diverge by transport; per-adapter acceptance logic — duplicated tests drift; identical wire formats across HTTP and MCP — unnecessary, only the domain meaning must match.

## 2026-10-25 — In-process providers are a v1 limitation, not an invariant
- **Context:** premise 4, partially agreed.
- **Chosen:** v1 providers run in-process in the core's language. Contracts carry no language-specific types and use a versioned external data representation, so an out-of-process, language-neutral provider protocol can follow.
- **Rejected:** cross-language provider hosting in v1 — no v1 provider needs it; same-language providers as a permanent rule — would close the provider ecosystem to other languages.

## 2026-10-25 — The core interprets lifecycle and `supersedes`, nothing else
- **Context:** premise 3, agreed.
- **Chosen:** the core interprets active, superseded, archived and tombstoned, and the `supersedes` link. Other relations (`derived_from`, `contradicts`, `validated_by`, `depends_on`, application-defined) are typed links stored without interpretation. Application metadata is application-owned; the core validates structure only.
- **Rejected:** core semantics for every relation, or graph processing in ordinary operations — that is a graph engine, which v1 defers.

## 2026-10-25 — Optimistic concurrency by expected revision
- **Context:** premise 2, agreed, with remote clients added.
- **Chosen:** the caller names the expected revision; conflicting guarded updates are rejected; concurrent creates cannot duplicate an identity; the same rules hold across processes sharing a store and for remote clients through the service. Locks are provider-internal and never in the public API.
- **Rejected:** last-writer-wins — silently loses updates (A8, S-E); distributed multi-node locking — v1 has one authoritative instance per store.

## 2026-10-25 — Storage owns live state; history failure is a reported partial outcome
- **Context:** premise 1, agreed with conditions (D5).
- **Chosen:** storage holds live state; the history provider records revisions. Under a history-required policy, a write whose history fails returns a partial outcome and leaves a durable pending-history operation carrying record identity, expected revision and operation identity; recovery at service start or on an authorised request retries it idempotently, without duplicate revisions. Outcomes distinguish storage persisted, history persisted, history pending, failed.
- **Rejected:** Git as the canonical store — makes Git a mandatory dependency, against the history abstraction; reporting success once storage persists — a false success (A7); distributed transactions between storage and history — infrastructure out of proportion to v1.

## 2026-10-25 — Tombstone and purge are separate operations
- **Context:** Git cannot guarantee erasure from history, clones, remotes, backups or caches.
- **Chosen:** ordinary delete tombstones (identity kept, excluded from active retrieval, history inspectable, reversible when authorised, not undone by a stale writer). Purge is separately authorised, removes what providers can, and reports exactly which boundaries were covered and which were not. Retention policy is applied before content enters history. Each provider advertises its deletion and purge capabilities. v1 may report full historical purge as unsupported.
- **Rejected:** delete meaning permanent erasure — undeliverable under Git and dishonest about copies; rewriting shared history or force-pushing as a side effect of delete or purge — breaks clones and commit identities without consent; Git's limits as every provider's contract — ties the contract to one provider.

## 2026-10-25 — Authorisation is enforced at the service boundary
- **Context:** an in-process library cannot stop its host, or any process with the same filesystem access, from reading the store.
- **Chosen:** embedded mode validates logical scope and operation requirements and does not claim to be a security boundary; service mode authenticates every request and authorises the operation before any provider runs, under an OS identity that owns the storage. Permissions separate read, write, delete/tombstone, history, purge and administration; purge and administration are never implied by write. Authentication uses an established mechanism — OAuth/OIDC or a supported gateway for remote MCP — with issuer, audience and permission validation, TLS, and `Origin` checks. The residual bypass for local processes sharing the service's identity is documented.
- **Rejected:** treating the SDK as a security boundary — false; a custom identity provider — unnecessary to ship v1; trusting caller-supplied agent names — not proof of identity.

## 2026-10-25 — Three deployment modes; remote access is v1
- **Context:** the brief assumed a single machine, contradicting a platform that exposes an API and an MCP server.
- **Chosen:** embedded, local-service and remote-service modes on the same core semantics. One authoritative instance per store may serve many remote clients.
- **Rejected:** single-machine only — fails S-B and S-C; multi-node replication, clustering or consensus — remote access is not distributed storage, and v1 does not need it.
