# Decision log

Append-only. Newest at the top. The rejected alternatives are the point — without them, every future session relitigates the same choice.

## Open
- npm package name and scope.
- Which MCP protocol revisions besides 2026-07-28 the server answers — set by what the TypeScript SDK v2 server supports, checked in the MCP slice.

Reopen any entry below only on a demonstrable contradiction or a genuine blocker (user, 2026-10-25).

---

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
