# Bounded recall and indexed replacement readiness

Synthetic local validation, 2026-11-02 through 2026-11-03. This continues S24; it does not switch an existing
claude-mem installation or enable automatic capture. Model checks use existing host logins
or the isolated local Ollama service. No personal memory corpus is involved.

## What changed

Recall has one total deadline across discovery, selection, verification and retry, with
bounded passage count, passage characters and serialized input. The supplied adapters use
a private passage-index response and restore exact supplied evidence before public workflow
validation. Discovery searches individual generated aliases so conjunctive search backends
can find older paraphrased facts. Verification and no-answer checks remain enabled.

PostgreSQL now reads indexed candidate rows while retaining its authoritative JSONB state,
transactional writer lock and shared lifecycle/ranking logic. Markdown can opt into a
disposable SQLite candidate index; selected records still come from verified Markdown files.
Neither change removes linear opening/writing work. Terms in derived indexes are sensitive.

`doctor --provider-probe --readiness <manifest>` combines an explicit synthetic provider
health check with configuration-bound full quality, cold latency, both native hosts,
migration/rollback and current owned local installation. The default cold p95 limit remains
10 seconds. Missing or failed evidence blocks readiness. Reports are unsigned local
attestations, not a guarantee about another provider, backend, executable or package build.

## Deterministic and storage validation

- Complete suite: 409 tests, 406 passed, zero failed, three skipped; 49 suites. Node 26.12.1
  on Windows. The separate PostgreSQL-only run below exercises optional live integration.
- Live PostgreSQL: 87 tests, 84 passed, zero failed, three intentionally non-PostgreSQL
  cases skipped; six suites. Includes shared conformance, portable transfers, transactions,
  old-writer fallback and SDK/CLI/MCP/HTTP workflow composition.
- Typecheck, lint, release verification, compact adapter validation, total-deadline tests,
  Markdown candidate-read/rebuild tests and readiness failure/happy-path tests passed.
- Installed-package checks exercise public entries, consumers, portable CLI, hooks and
  storage/history plugin composition. The final archive passed on Node 24.22.1 and 26.12.1
  on Windows. Earlier Node 24 attempts failed to launch child processes; the completed
  rerun passed every assertion. Migration and rollback cover pinned synthetic upstream
  export, attributed review, correction, reconciliation and SQLite/Markdown/Git round trips.
  See [migration evidence](bounded-replacement.json).

These counts are separate runs, not a combined unique-test count. The synthetic readiness
unit fixture adjusts its own latency to exercise a passing branch; it is not model evidence.

The 1,000-memory Git baseline exported and verified every revision. Search p95 was 12.83 ms;
history drain was 0.6 revisions/s while model checks were also running. A prior attempt stopped
after an export error with 685 pending entries and an internal diagnostic; that result is not
counted as a pass. The diagnostic rerun completed without reproducing it. Benchmark cleanup now
closes the client before retrying temporary-directory removal on Windows. See
[completed benchmark](bounded-benchmark-1000.md). The optional 10,000-revision Git benchmark
was not repeated; the separate retrieval evaluation did use 10,000 fillers.

## Retrieval evidence and limits

The first full compact Codex run measured 58 eligible cases with 10,000 newer fillers:
seven failures, including one irrelevant injection for the bare subject query “message
queue”, plus deadline/provider errors. The injected passage described an invoice-queue error
and did not identify the requested subject. See [failed full run](bounded-codex-before.json).

The selector prompt was tightened to require a substantive fact about a bare queried subject,
while preserving synonymous subjects, category members, false-premise corrections and
questions embedded in longer tasks. The focused retry passed five cases including the
no-answer regression, paraphrase, correction and old verbose task. See
[focused evidence](bounded-codex-focused.json). Focused retries do not replace the full gate.

Raw lexical `search` remains below its semantic targets: overall recall 0.735, paraphrase
recall zero and MRR 0.691. The distinct stemmed `retrieve` path reports overall recall 0.909,
paraphrase recall 0.714 and MRR 0.870 on its fitted evaluation. Hard scope/lifecycle/error
checks pass. At 10,000 fillers, search p95 was 27.588 ms and cold open plus search p95 was
408.410 ms. These in-process measurements do not include model recall. See
[lexical evaluation](bounded-lexical-eval.md).

The final full Codex run passed 57 of 58 cases with 1,000 newer fillers, discovery and
verification enabled, and zero false injections. `dup-timeout` exceeded the total deadline
at 60,090 ms. Cold p50 was 21,145 ms and p95 was 54,776 ms. The run made 165 command attempts
with no retry. This fails both the complete-quality requirement and the unchanged 10,000 ms
cold p95 threshold. See [final full evidence](bounded-codex-final.json).

The independent Qwen 2.5 7B full compact run passed 44 of 58 cases with 1,000 newer fillers:
six deadlines, two false-injection cases and six other semantic misses. Cold p50 was
68,179 ms and p95 was 120,088 ms. It made 158 command attempts with no retry. See
[full Qwen evidence](bounded-qwen-before.json). This improves on the earlier S24 result,
but model settings and resource conditions differ, so it is not a controlled comparison.

After tightening the prompt, the six-case Qwen diagnostic passed two cases. The previously
irrelevant log-request-ID injection was fixed and the bare queue query abstained, but the
session-store case hit the deadline, RabbitMQ was missed, and both older paraphrase/verbose
cases still missed the bicycle fact. Their generated aliases contained related categories
but omitted the term needed by the lexical candidate search. The focused run does not
replace a full qualification run. See [Qwen diagnostic](bounded-qwen-focused.json).

These failures remain visible. This candidate is not qualified as a complete claude-mem
replacement, and no failed gate is waived.
