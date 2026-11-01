# ADR-0007: Managed hooks, review and derived embedding caches

Status: Accepted for this implementation, 2026-11-01.

Daily replacement requires repeatable host administration, explicit review, observable retrieval
cost and a reversible migration. Keep these application/infrastructure concerns outside the
durable domain contract and selected storage provider.

Manage only exact hook groups recorded in a local installation manifest. Preserve unrelated
settings, refuse ambiguous/modified ownership, serialize installers with a lock and retain backups.
Replace files atomically and attempt rollback if the manifest fails; cross-file crash recovery
remains administrative. Installation never grants host trust. Doctor distinguishes configuration,
current generated commands, an explicit no-write execution probe and last invocation receipts.

Expose candidate review through an authorized MemoryClient. Acceptance/rejection use optimistic
updates; correction uses atomic supersede with retained attribution and explicit reviewer metadata.
Suggest only exact normalized-text duplicates within the same namespace, bounded and reported.
No semantic merge, implicit acceptance or source deletion.

Add an optional EmbeddingIndex port and SQLite infrastructure implementation. Cache document
vectors keyed by model, identity, namespace, revision and content, with caller-isolated buckets.
Prune only complete candidate scans; recheck current eligibility/revision before output. Vectors
are sensitive derived data and require explicit deletion handling. This is bounded candidate
caching, not an ANN search service or a replacement for storage plugin indexes.

Retry a command selector at most once, only on timeout, with explicit adapter exit 75 support.
Keep malformed output failures visible. Extend the Codex example's inner timeout and account for
all stages/retries in host budgets. Measure a two-call discovery/selection configuration against
the full task gate before claiming audit-call removal is safe.

Reconcile explicitly selected claude-mem export rows by stable capture identity, content and
evidence. Preserve accepted/corrected lifecycle; report missing/changed/ambiguous/partial rows.
Coverage success is distinct from review and answerability. Validate pinned upstream synthetic
exports through review, cross-backend archives and fresh-store rollback, plus actual installed
native hosts and an independent local model. Retain failed evidence. No automatic change to
live claude-mem, global host settings, personal source data or accepted private memories.
