# Practical daily memory validation

S24 implements optional provider-call caching, a packaged storage conformance runner,
remote attributed review, and an installable `0.2.0-rc.1` candidate with a cutover and
rollback runbook. The implementation is separate from each provider's measured suitability.

## Checks

Local build, TypeScript, lint, release fixtures and installed archive checks passed.
The complete local suite ran 400 tests: 393 passed, five failed, and two skipped. One
provenance test incorrectly required immediate Git export rather than persisted storage;
that assertion was corrected, and its focused rerun passed. The remaining failures were
a Node out-of-memory crash, a delayed Git export, and two host-process failures. Focused
reruns passed all twelve update-validation transports and all three host/history cases.
The portable migration lifecycle test also now asserts an acknowledged history drain
before inspecting retained revisions; its focused rerun passed.

PostgreSQL's local run passed all six transport conformance suites and the public workflow
scenario. Its only failed test was the SQLite portable lifecycle timing assumption described
above. PostgreSQL CI separately passed. All Node 22.18/24 Linux/Windows test and release-quality jobs are green on implementation
commit `84ca26d`, including exact-archive installed consumers and source-bound candidate
verification: [CI](https://github.com/The-Running-Dev/SubZeroDev.MemoryKit/actions/runs/41356243834),
[release candidate](https://github.com/The-Running-Dev/SubZeroDev.MemoryKit/actions/runs/41356243829).
The benchmark and publication jobs are intentionally skipped for pull requests.

The retained `subzerodev-memorykit-0.2.0-rc.1.tgz` passed every installed consumer,
including the exported conformance runner and external storage plugin with Git history.
It contains 105 files, is 143,493 bytes, and has SHA-256
`cdd8ce265122b861e232e59da345ebcca8332658cc8182864ee238aaa6e29189`.
Candidate preparation independently compares every shipped file to a clean rebuilt source;
the manifest and tarball are retained together outside the checkout.

## Native hosts and replacement

The installed-package Claude Code acceptance run passed all 17 checks with Markdown
storage, including native compaction, corrected capture after restart, cross-host recall,
and managed uninstall. Its four descriptive measurements returned the expected exact,
paraphrase, verbose-task and no-answer results. See
[the native Claude report](practical-native-claude.json).

The installed replacement test passed all five checks: a pinned upstream serializer
fixture, attributed review and correction, read-only changed-source reconciliation,
SQLite-to-Markdown transfer with Git revisions, and rollback into fresh SQLite. See
[the replacement report](practical-replacement.json). This used synthetic data; no live
claude-mem database or user host settings were changed. Rollback restores MemoryKit,
not the upstream database, and archives exclude credentials and operation replay.

The installed-package Codex acceptance rerun passed all 18 checks with SQLite,
including actual compaction, recall after compaction, cross-host corrected capture recall
and managed uninstall. See [the native Codex report](practical-native-codex.json).
Native acceptance had exposed two capture replay problems: byte-offset observation IDs
collided when transcripts were rewritten, and file evidence references changed when
Codex relocated a resumed transcript. Identities now use timestamp, role, complete content
and an occurrence counter, with a stable session evidence reference. Both replay regressions
and the full native rerun pass. Upgrading an earlier capture profile can recapture retained
messages as candidates; review them before acceptance.

## Retrieval evidence

The first full verified Codex run measured 58 eligible cases with 10,000 newer filler
records and six task-shaped rewrites. It passed 56 and had two provider-process errors
(`correct-release-new` and `state-failover-default`), with no observed false injections.
Both cases passed a focused rerun. The failed full run and focused rerun remain available:
[full first run](practical-codex-quality.json),
[focused provider retry](practical-codex-provider-retry.json).
The focused retry does not establish a clean full gate.

The second complete run passed 57/58 cases, with a provider-process error on
`large-architecture` and no observed false injections. Its cold p50/p95 was
28.34/51.60 seconds; the immediate-repeat p50/p95 was 81/404 milliseconds.
It made 166 uncached provider calls, with no configured retries. See
[the second full run](practical-codex-quality-rerun.json).

The final complete Codex run passed **58/58**, with zero provider errors and zero false
injections. It used the same 10,000-record scale, task rewrites and verified selector.
Cold p50/p95 was 19.28/32.38 seconds; immediate cached repeats were 61/222 milliseconds.
It made 166 provider calls and 166 process attempts, with no configured retries.
The earlier failed runs remain above to expose process reliability rather than hide it.
See [the final full Codex run](practical-codex-quality-final.json).

The independent local-provider run uses Qwen 2.5 7B (`845dbda0ea48`) on CPU,
Ollama image `sha256:b2f0122c476bc9fe7ce679d8bb4bd555351e25e2554eefb156f61cb0a89cf429`,
a 4,096-token context and 1,000 newer filler records. Discovery and quote verification
are enabled, caching is disabled, and configured retries are zero. Each provider call
has a 110-second deadline (120 seconds at the command boundary). These settings and
hardware are part of the measured configuration, not a claim about all local models.

The full run completed all 58 cases and **failed**: 16 passed, 39 had provider timeouts,
and three completed without returning the relevant memory (`held-correct-release-afternoon`,
`old-paraphrase`, `old-verbose`). No false injections were observed; timeouts remain
failures, not successful abstentions. All-attempt p50/p95 was 125.61/195.32 seconds,
including failed attempts. It made 130 provider calls and 130 process attempts with zero
retries. See [the complete Qwen report](practical-qwen-quality.json). This exact CPU
configuration is blocked for daily use. The run does not isolate hardware latency from
provider/model behavior, and its 1,000-record scale differs from Codex's 10,000-record run.
The dedicated evaluation container was removed after completion.

The complete lexical evaluation is in [the baseline report](practical-lexical-eval.md).
Its hard exposure, obsolete-result and error thresholds passed, while several quality
targets remained unmet. Lexical search alone is insufficient evidence of replacement
quality. These corpus queries were used to select the lexical precision rule; the report
separates held-out queries and labels targets versus hard gates.

## Limits

All evaluations are synthetic fixtures. They do not establish suitability for arbitrary
personal data, every LLM, every project or every storage plugin. PostgreSQL and Markdown
compatibility checks are not search scalability or throughput claims. The public
conformance runner checks eleven service scenarios and does not exhaust crash recovery,
provider fault modes or token storage behavior.

The cache reuses identical provider requests for five minutes. Discovery, authorization,
eligibility, exact quote and current revision checks still run; cold inference retains its
cost. The SQLite cache bounds current values to 64 entries of at most 256 KiB each. Logical
eviction is not secure erasure, and pages, WAL files or backups can retain sensitive output.

Candidate manifests bind shipped bytes to a rebuilt clean source commit; they do not
attest model quality. This PR does not publish to npm, merge itself, ingest personal source
material, enable automatic capture, or cut over a live installation.
