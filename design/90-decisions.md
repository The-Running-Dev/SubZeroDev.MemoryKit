# Decision log

Append-only. Newest at the top. The rejected alternatives are the point — without them, every future session relitigates the same choice.

## Open
- Implementation language and runtime (D3) — to be chosen at `/design`'s approaches gate.
- History retention profiles (full, metadata-only, no persistent content history) — whether v1 supports them.
- Authentication profile for a local-only listener.
- Which MCP protocol revisions the server answers.

---

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
