# S25 — Bounded recall, indexed reads and replacement evidence

Owner-authorized continuation after S24, 2026-11-02.

## Outcome

Keep the SDK, CLI, MCP and HTTP storage contract portable while making model recall bounded
and replacement claims inspectable. Improve the independent command-model path without
changing acceptance, namespace, lifecycle, verification or abstention requirements.

## Implementation

- Apply a total recall deadline across discovery, selection, verification and retry. Forward
  cancellation to command providers and terminate their descendants when the deadline expires.
  Bound candidate count, passage characters and serialized provider input independently.
- Use a compact private index protocol in the supplied Codex and Ollama adapters. Restore
  identities, revisions and exact supplied quotes before returning the public protocol.
  Search individual generated aliases as well as phrases so conjunctive backends can find
  older paraphrased facts. Keep recent evidence within the disclosure budget.
- Retain PostgreSQL's authoritative snapshot and transactional writer lock, with indexed
  derived candidate rows. Use a generation marker and repeatable reads to avoid mixing state.
  Add an optional disposable Markdown candidate index with verified authoritative file reads.
- Add an explicit synthetic provider probe and local readiness assessment. Require complete
  model-quality evidence, cold latency, both native hosts and migration/rollback evidence
  matching the configured provider. Report failed gates without substituting focused retries.

## Acceptance and limits

Run typecheck, lint, the complete deterministic suite, live PostgreSQL conformance, installed
package consumers, release verification, lexical evaluation, real-model quality, native hosts
and installed migration/rollback. Preserve failed model runs and distinguish them from a clean
full run. Capture final package digests outside the checkout against a clean rebuilt commit.

The default cold p95 readiness threshold remains ten seconds. A bounded response does not mean
fast recall or immediate termination of an arbitrary noncooperative SDK provider. Current
PostgreSQL and Markdown opening/writing still perform linear work. Index terms are sensitive;
logical purge and disposable-index invalidation do not claim physical erasure. Local reports
are unsigned attestations and do not establish readiness for another model or package build.

1. Diagnose independent local Qwen failures using the unchanged full task gate. Preserve
   abstention, scope isolation, exact evidence and verification. Record remaining failures.
2. Bound a whole context request, propagate cancellation through provider phases, and reduce
   provider wire output to passage indices in the shipped adapters. Expose smaller disclosure
   budgets and measure uncached latency separately from repeated-query caching.
3. Add transactionally maintained PostgreSQL lexical candidate rows and an opt-in rebuildable
   Markdown index. Keep lifecycle/ranking/cursors in the shared state engine and test older
   writer fallback, correction, purge and rebuilds. Describe remaining linear paths honestly.
4. Assess replacement evidence through explicit doctor probes and configuration-bound quality,
   native-host and migration/rollback reports. Missing, partial or failed evidence blocks readiness.

No automatic capture, acceptance, personal ingestion, global host cutover, publication or merge
is authorized by this implementation. Synthetic acceptance checks use isolated host settings.
