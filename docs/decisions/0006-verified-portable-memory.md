# ADR-0006: Audited recall, portable snapshots and PostgreSQL

Status: Accepted for this implementation, 2026-11-01.

Memory must survive host and backend changes without reaccepting generated observations,
losing source attribution or resetting revision history. Recent task retrieval also needs
an explicit opportunity to abstain and repair citations before injection.

Add optional `RecallSelector.verify` after proposal identity validation. It receives only
proposed authorized passages and can remove proposals or repair exact contiguous quotes.
It cannot add IDs. Validate current eligibility/revision again before injection. Inject only
quoted evidence. Command profiles opt in through `recall.verification`; generated hook time
budgets account for discovery, selection and verification. The second model pass is an audit,
not a guarantee of truth, and adds latency/cost. Existing selectors remain compatible.

Add optional storage snapshot/restore methods and local administrator SDK/CLI archive APIs.
Archives preserve current records/policies and a retained Git bundle, with a drained outbox
anchor that continues sequence/history identities after restore. Validate structure/checksum,
restore to a new store and compare the result before exposing the directory. Exclude bearer
tokens and operation replay state; administrators reissue authorization and operation IDs.
Do not expose archive administration to remote HTTP/MCP requests. Do not overwrite a store,
convert in place, rewrite Git history, or load executable configuration from the archive.
Only retained local Git or no history is portable in this first format. Checksum is integrity,
not producer authentication; stop writers for an offline export and serialize administrators.

Extract Markdown's deterministic state operations into infrastructure-internal `storage-state`.
Keep Markdown's locking, persistence and integrity handling in its original module. Implement
an optional PostgreSQL plugin with a JSONB snapshot per logical store and row-locked writes.
This preserves transactional behavior with a compact implementation and shared conformance
suite. It deliberately trades indexing/throughput for modest-store portability; normalized
PostgreSQL tables, native FTS/vector search and distributed Git coordination are deferred.
Core SDK imports do not load `pg`; explicit subpath/module imports do. Plugin configuration
references an environment variable instead of persisting connection credentials.

Validate SQLite, Markdown and PostgreSQL across SDK, CLI, HTTP and MCP, including migration
pairs, token exclusion, concurrency/rollback, retained revisions and native host lifecycle.
Use synthetic upstream-serializer-generated claude-mem input, preserving user versus generated
attribution and candidate review. Report native/model quality evidence and limitations apart
from the historical raw retrieval quality gates.
