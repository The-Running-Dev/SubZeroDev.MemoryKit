# S23 — Daily memory replacement

Owner-authorized continuation of S22, 2026-11-01. Supersedes S22's no-persistent-vector-copy
restriction only for an explicitly configured derived embedding cache. Historical raw retrieval
gates and earlier verification reports remain unchanged.

1. Managed Claude/Codex install, repeatable owned-group upgrade and uninstall. Preserve other
   settings, detect ownership drift, back up changes, diagnose execution separately from trust.
2. Candidate review queue with original attribution/evidence and revision-guarded accept, reject,
   correct and normalized exact duplicate resolution. Corrections retain original source records.
3. Codex timeout handling and bounded timeout-only retries; full task recall gate and measured
   two-call experiment. Optional persistent EmbeddingIndex with scoped buckets, revision/content
   keys, conservative pruning and final current-record validation.
4. Read-only source reconciliation and installed-package replacement acceptance using pinned
   synthetic upstream export, review, SQLite/Markdown plus retained Git and fresh-store rollback.
   Actual native hosts must recall a correction captured by the other host. Exercise a real
   independent local model and report its actual quality/failures without widening claims.

Acceptance includes unit/lifecycle tests, the existing transport/storage conformance suites,
packed consumers, release guard, actual native host and model reports. No publication, merge,
automatic source ingestion or live global host configuration changes are authorized here.
See [ADR-0007](../docs/decisions/0007-managed-memory-replacement.md) for boundaries and
[daily replacement validation](../docs/validation/daily-replacement.md) for measured results.
