# Daily replacement validation — S23

Measured on Windows, 2026-11-01, using temporary synthetic projects, stores and host homes.
No live claude-mem database, global Claude/Codex settings or personal memories were changed.
The package remains private and unpublished. This report supplements
[verified portability](verified-portability.md); it does not erase the historical S18/S21
raw-search failures or establish universal quality for arbitrary models.

## Implemented acceptance boundaries

- Managed installation owns exact hook groups in a manifest, preserves unrelated settings,
  supports repeatable upgrade/removal and refuses drift. Backups and a settings lock support
  recovery; replacing settings and manifest together is not a crash-atomic transaction.
  Doctor separates configuration, a no-write command probe and an invocation receipt.
  A probe or receipt does not establish successful retrieval or host trust.
- Review exposes original provenance, source roles and generated/curated status. Accept/reject,
  correction and normalized exact duplicate resolution require an expected revision. Correction
  supersedes the original rather than overwriting it. Duplicate suggestions are bounded and
  stay within one namespace; semantic deduplication is not implemented.
- Optional persistent document vectors use the public EmbeddingIndex port and SQLite plugin.
  Model/namespace/record/revision/content keys and principal-scoped CLI buckets isolate reuse.
  Current records are checked before output. Complete scans prune stale keys; partial scans
  preserve unseen entries. Purge prevents stale injection immediately, but vector-file physical
  erasure is separate. This is bounded candidate caching, not global ANN search.
- Read-only reconciliation audits the explicitly selected upstream export for missing, changed,
  ambiguous and partial source coverage. A matched superseded source still counts as retained.
  Coverage success is distinct from review completion, retrieval quality and live cutover.

## Native hosts and installed package

| Acceptance                              | Result           | Evidence                                     |
| --------------------------------------- | ---------------- | -------------------------------------------- |
| Claude Code 2.1.302                     | 17 checks passed | [Native report](daily-native-claude.json)    |
| Codex CLI 0.158.0                       | 18 checks passed | [Native report](daily-native-codex.json)     |
| Upstream import/review/migrate/rollback | 5 checks passed  | [Replacement report](daily-replacement.json) |

Both native runs exercise installed CLI code with regenerated, managed hooks: restart recall,
project/shared scope isolation, candidate exclusion, native Stop capture, explicit review,
correction, native PreCompact, cross-host recall of the corrected capture, invocation receipts
and uninstall. Codex also checks the unwrapped generated command. The four descriptive recall
measurements in each native report all returned the expected result.

Tests use existing host logins with isolated temporary homes. Codex's hook trust bypass applies
only to the reviewed synthetic test hooks. Real installation requires the host's ordinary trust
review; see the official [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks).
The native reports precede a small diagnostic-receipt atomic-write hardening; the final package
was rebuilt and checked separately with the same public workflows and generated-command tests.

The replacement harness imports the fixture produced by the pinned actual upstream exporter
over synthetic API responses. It checks user/assistant attribution, accept/reject/correct,
retained source evidence and history, a read-only changed-source audit, SQLite to Markdown with
Git history, and rollback into a fresh SQLite store. It does not restore an upstream database,
test a personal export, or prove that an upstream search query enumerates every stored row.

## Codex quality and cost

The verified Codex task gate **passed all 58 measured cases** with 1,000 newer filler records:
no provider errors, zero false injections, complete no-answer abstention and exact results for
the four scale/adversarial cases. Ten raw-search-only cases were explicitly skipped. Six short
topic queries use the existing task-query disambiguations; records and relevance labels were
not changed. This run used SQLite, discovery and verification enabled, a 90-second internal
deadline, a 110-second outer deadline and one permitted timeout retry.
[Full report](daily-codex-verified-quality.json).

There were **166 logical calls and 166 process attempts: zero actual retries**. Median query
latency was **19.79 s**, p95 **31.86 s**. The report was produced by the earlier telemetry format:
its `cost.retries: 1` is the configured retry allowance, not an observed retry. The current script
separates `configuredRetries` from actual `retries = processAttempts - calls`. Input/output byte
counts are 444,491/19,360; they do not measure provider tokens or billing. This establishes
completion for this gate with the longer deadline, not lower latency than previous verified runs.

The two-call discovery/selection experiment measured all 58 task cases with 1,000 newer filler
records. It made 116 logical calls, with median 13.04 s and p95 19.20 s. It **failed** because
`none-queue-current` injected one unsupported memory. Keep verification enabled for the tested
daily configuration. [Failed experiment](daily-codex-fast-quality.json).

The longer inner Codex deadline replaces the earlier hard 55-second cutoff. Profiles can opt
into one timeout-only retry. Malformed output and other command failures are not retried.
Generated hook budgets account for discovery, selection, verification and the retry allowance;
worst-case waiting can be several minutes. Payload bytes are not provider token/cost accounting.

## Actual independent local model

Ollama ran in an owned temporary CPU-only Docker container at loopback. Image digest:
`sha256:b2f0122c476bc9fe7ce679d8bb4bd555351e25e2554eefb156f61cb0a89cf429`.
Models were explicitly downloaded for this opt-in acceptance run; the packaged adapter does not
download models. Official setup: [Ollama Docker](https://github.com/ollama/ollama/blob/main/docs/docker.mdx).

- **Qwen2.5 7B**, model ID prefix `845dbda0ea48`, passed all three installed-package smoke
  checks: exact recall with candidate/foreign-project exclusion, unsupported-question abstention,
  and reviewed correction after reopening. Discovery was off and verification on. Query times
  were 141.44 s, 5.12 s and 29.03 s on this loaded CPU host. These include multiple calls and
  initial model loading. [Actual report](daily-local-7b-smoke.json),
  [official model](https://ollama.com/library/qwen2.5:7b).
- **Qwen2.5 1.5B**, model ID prefix `65ec06548149`, failed the four scale/adversarial cases.
  All four calls errored with the default 25-second internal deadline; raising it to 100 seconds
  still produced four timeouts. Median/p95 query times were 33.93/49.47 s and 103.36/103.88 s,
  respectively. Neither is a relevance pass. [Default-deadline report](daily-local-quality.json),
  [longer-deadline report](daily-local-long-quality.json),
  [official model](https://ollama.com/library/qwen2.5:1.5b).

The first 1.5B small-store smoke run failed unsupported-question abstention: one returned
memory where zero was expected. The original harness stopped at that assertion before writing
JSON; [its stderr](daily-local-1.5b-first-failure.txt) is retained with the workspace path removed.
After the harness was changed to record every check, a fresh-store repeat passed all three
checks in 43.06 s, 22.34 s and 25.48 s. [Repeat report](daily-local-1.5b-smoke.json).
This is mixed evidence for the same small scenario, not a stable quality pass; retain the first
failure and the separate scale failures when assessing this model.

The 7B smoke test proves actual independent-provider integration for these small cases, not
the full 58-case gate, large-context performance, a recommended default model or automatic
capture quality. No local model has passed that full gate here. Model/server chat context limits
still matter. Containers/model layers created for these tests are removed after acceptance.

## Repository checks

On Node 26.12.1:

- Typecheck, lint, build and non-publishing release guards passed.
- Full suite with `node --test --test-concurrency=4 "tests/**/*.test.ts"`: **386 tests,
  385 passed, one PostgreSQL skip, zero failures**. The earlier default-concurrency full run
  before two final coverage additions passed 383 of 384 tests with the same skip. A later
  unbounded repeat was stopped during resource contention and is not counted as a pass.
- PostgreSQL 18 contract/transport/transaction/migration matrix: **82/82 passed**, using
  `MEMORYKIT_ONLY_POSTGRES=1` and the three CI test files with concurrency two. This covers
  the PostgreSQL case skipped by the ordinary suite.
- Final packed tarball passed archive validation, installed CLI, memory/none public-entry
  isolation, typed portable-workflow consumers, storage plugins and Git history composition.
- Focused managed-hook, review, reconciliation, cache and timeout-provider tests: **18/18
  passed**. Cache tests check reopened reuse, revision invalidation, actual vector pruning,
  mutation before output and conservative retention on partial scans.

The owned Ollama container/model layers were removed, and the previously stopped test PostgreSQL
container was returned to stopped state. No unrelated containers were changed.

Reproduce the opt-in model/host checks with the commands in
[portable memory](../portable-memory.md#reproducing-acceptance-and-quality-checks).
Select explicit installed executables/models and synthetic test stores. Standard CI does not
require host logins or download models.
