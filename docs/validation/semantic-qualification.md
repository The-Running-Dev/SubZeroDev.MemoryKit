# Semantic recall qualification, 2026-11-05

MemoryKit passes the full retrieval quality gate with the updated Codex executable. Daily replacement readiness remains blocked by cold latency. Qwen also has six retrieval failures.

| Provider and profile | Passed | Cold p50 | Cold p95 |
| --- | ---: | ---: | ---: |
| Qwen 2.5 7B, prior CPU run | 44/58 | 68.2 s | 120.1 s |
| Qwen, initial GPU-assisted run | 50/58 | 16.3 s | 25.6 s |
| Qwen, subject expansion and index-only verification | 52/58 | 11.4 s | 15.9 s |
| Qwen, shipped verifier requiring quoted evidence | 52/58 | 14.3 s | 29.2 s |
| Codex, prior qualification | 57/58 | 21.1 s | 54.8 s |
| Updated Codex, initial run | 52/58 | 28.9 s | 55.0 s |
| Updated Codex, final isolated selector | 58/58 | 21.5 s | 37.8 s |

All final measurements used SQLite, task queries, 1,000 newer filler records, uncached requests, discovery and independent verification, and zero retries. The 58 cases cover corpus, held-out and old-record tasks. Ten raw-search scenarios are outside this acceptance suite. Cold time includes all provider phases and subprocess startup; the Ollama service may keep weights resident. These are single runs on a shared Windows laptop. The move from CPU to GPU, concurrent load, prompt changes and different passage budgets prevent attributing the speedup to a single change. The readiness threshold stays at 10 s cold p95.

## Qwen

Ollama used Qwen 2.5 7B (model ID 845dbda0ea48) on an NVIDIA T1200 Laptop GPU with 4 GB VRAM. The shipped run used 21 GPU layers, four CPU threads, 4,096 context tokens, 128 generation tokens, a 120 s total deadline, and at most 12 passages of 384 characters within 16,384 bytes. The faster index-only run used 18 GPU layers and eight passages. It admitted unsupported context for five queries, including the adversarial no-answer case. The shipped verifier requires a verbatim span and dropped that to one affected query. Both old-record queries, the error-code question, the certificate abstention and the adversarial case passed.

Of the six remaining failures, an invoice-queue troubleshooting record was injected for a bare queue topic. Two stale-premise queries missed the current broker or release schedule. Three queries retrieved only one of two required records: the architecture overview and summary, duplicate timeout evidence, and competing audit-retention values. There were no provider errors or deadlines. An experimental sentence-number verifier recovered the duplicate but regressed both old-record cases; it was discarded.

[Full quoted-evidence run](semantic-qwen-qualified.json) · [Index-only run](semantic-qwen-final.json) · [Initial GPU run](semantic-qwen-full.json)

## Codex and native hosts

The selector used codex-cli 0.166.0-alpha.6 with gpt-6.1-sol, low reasoning effort, 16 passages of 1,024 characters, 24,576 bytes and a 60 s total deadline. The final run completed all 165 provider calls without retries, deadlines, or false injections. The initial run had five command-provider failures and one deadline. A trial host-skill feature emitted a startup warning as an error event and was removed before the final run. Unexpected tool and error events still fail closed.

Fresh-process native acceptance passed all 18 checks on Codex with SQLite and all 17 on Claude Code 2.1.302 with Markdown, including correction, compaction and cross-host transfer. These tests used the Codex selector. The first Claude run exceeded its deadline on a captured correction. Both final native runs used the package from 68c5f2e. Its installed files match the package from 79b20e4 except for the Ollama adapter, which neither native run invokes.

[Final Codex run](semantic-codex-final.json) · [Initial Codex run](semantic-codex-full.json) · [Native Codex](semantic-final-native-codex.json) · [Native Claude Code](semantic-final-native-claude-code.json)

## Package and readiness

The shipped archive passed installed-package, CLI, consumer, hooks, storage-plugin and Git-history checks. All five migration and rollback checks passed. The local serial suite passed 410 tests with three skips and no failures; the live PostgreSQL run passed 84 with three skips. The provider contract test covers CPU/GPU options, subject expansion, exact quote extraction and unsupported quotes. The PR runs typecheck, lint, tests and release checks on Linux and Windows.

The installed doctor passed provider health, quality, both native hosts, installation, and migration/rollback. Only cold latency blocks this Codex configuration. Qwen requires both better retrieval and lower latency. The evidence is synthetic. No cutover or publication was performed.

[Archive identity](semantic-qualified-candidate.json) · [Migration and rollback](semantic-qualified-replacement.json) · [Installed doctor](semantic-readiness.json)
