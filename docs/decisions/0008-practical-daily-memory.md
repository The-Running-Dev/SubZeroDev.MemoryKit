# ADR-0008: Reusable recall calls, packaged contracts and remote review

Status: Accepted for this implementation, 2026-11-01.

Cache optional provider calls rather than rendered context. Exact request keys include the
task, provider id, query, ordered passages with identities/revisions/namespaces/content and
verification proposals. CLI buckets additionally bind store/backend configuration, credential
digest, explicit scopes, candidate policy and the full configured provider command. SDK callers
must isolate equivalent identities themselves. Expansion reuse cannot widen selected scopes.
Discovery, eligibility, quote checks and final current-record validation still run. Concurrent
context remains a sequence of reads, not a transactional snapshot.

The SQLite implementation retains at most 64 values of at most 256 KiB each per file for five
minutes. Values can contain sensitive generated queries and exact quotes. Eviction is logical,
not secure erasure; expired pages/WAL/backups may retain bytes. Keep the file in a private local
directory, clear the current bucket or remove the complete closed cache and sidecars when
required. Never enable it implicitly or cache errors. Cold model calls retain their cost and
latency. Bounded search concurrency preserves ordered rank accumulation and waits for every
in-flight search before propagating an error.

Move the existing service scenarios into a shipped conformance module, preserving the suite
used by transport tests. The public runner owns fresh local directories and omits error details
that could contain credentials. External backend factories must allocate fresh logical stores;
the caller owns their cleanup. Git is required. This checks service semantics, not every provider
fault mode, token-store capability, throughput or crash durability guarantee.

Review operations share one validator/workflow across SDK, CLI, HTTP and MCP. Mutations require
current revisions and service permissions; asserted source attribution is retained, not verified.
Duplicate suggestions and targets remain bounded exact normalized text in the same namespace.
There is no multi-record duplicate transaction. Review uses optimistic concurrency; unlike raw
service writes it has no operation-id replay contract. HTTP rejects idempotency keys for review.

Use a real prerelease package version and bind candidate archives to a clean source commit and
checksum. Candidate manifests attest archive identity only. CI, native hosts and model evidence
remain distinct; a completed local-model run can fail the quality gate. Publication and live
cutover remain separately authorized actions.
