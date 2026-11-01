# Portable storage and task discovery validation

This change separates current storage from retained history. SQLite and managed Markdown
implement the same storage/token contracts; explicit external modules can supply another
implementation through SDK, CLI and server startup configuration. Git remains an independent
history provider. This is infrastructure for replacing claude-mem across projects and hosts;
it does not establish complete feature or retrieval-quality parity.

The credential-free conformance matrix covers both backends through SDK, CLI, HTTP,
HTTPS/OIDC, MCP stdio and MCP HTTP: 132 scenarios. Additional tests cover independent and
multi-process writers, optimistic conflicts, exact replay, rollback, token revocation,
purge, Git history, external modules, scope isolation, and setup/capture/accept/upgrade/doctor.
Package validation installs the archive and loads an external module using only public exports.
The final local suite passed all 361 tests in 49 suites; typecheck, lint, installed-package
checks and release guards passed. CI repeats tests and package checks on Linux and Windows
with Node 22.18 and 24.

Native acceptance uses an installed archive and installed selector examples, existing logins,
isolated synthetic projects, and Markdown current storage. It regenerates configuration with
`upgrade` before testing the actual generated hooks. Capture stays off. Claude uses Haiku;
Codex uses its existing-login default model. See the harness for isolation and hook trust
details; global host configuration is never changed. Native fixtures use `history:none`;
separate conformance and installed-plugin tests exercise Git revision retention.

| Native host / selector     | Version | Markdown acceptance                       |
| -------------------------- | ------- | ----------------------------------------- |
| Codex / Codex              | 0.158.0 | [9/9 passed](portable-native-codex.json)  |
| Claude Code / Claude Haiku | 2.1.302 | [8/8 passed](portable-native-claude.json) |

Both include fresh processes, Git-origin project isolation, explicit shared scopes,
no-answer abstention, correction after restart, paraphrase and verbose-task recall.
Codex additionally executes the generated shell hook without the observation wrapper.
These are synthetic integration results, not broad retrieval quality scores.

```sh
node scripts/verify-native-recall.ts --cli /installed/package/dist/cli/main.js --host codex --codex /native/codex --storage markdown --selector /absolute/codex-recall.json --report /absolute/native-codex.json
```

Use `--host claude-code --claude /native/claude` and the Claude selector configuration for
the other host. Selector configurations point to the **installed** example scripts and set
`discovery:true`. The harness upgrades the original profile into a new directory before use.

## Real-model quality measurement

`scripts/verify-recall-quality.ts` measures unchanged corpus/heldout facts, queries and
expected revisions, adding only accepted metadata for workflow eligibility. Raw-search-only
features are skipped explicitly. Implicit scope enumeration intersects the reader's grants;
explicit unauthorized scopes are never widened. Four extra cases put relevant facts behind
1,000 newer notes, window a deep passage, and require adversarial no-answer abstention.
Payload bytes measure command traffic, not billable tokens. Model latency and choices can vary.

Historical reports from the first implementation are retained:
[Claude](portable-quality-claude-initial.json), [Codex](portable-quality-codex-initial.json).
Both missed the old-fact paraphrase; Codex also missed the old verbose task. Discovery used
strict all-word search, so expansions such as `bicycle storage` missed `bicycle is stored`.
Discovery now uses ranked any-term retrieval with backend word normalization, then reloads
and verifies current records. A regression exercises multiword/plural expansion on both backends.

Those historical reports also contain three `Forbidden` errors caused by the harness requesting
implicit namespaces outside the reader's grant. The harness correction changes only implicit
scope enumeration. Reports preserve that error rather than silently reclassifying the cases.
The existing quality gates remain separate; false injections and semantic misses must remain
visible even when host integration and storage conformance pass.

The final Claude run used 116 selector calls (418,438 input bytes, 15,596 output bytes),
with per-case latency p50 9.37 s and p95 14.21 s. Its 32 attempted corpus cases include
26 fully recalled answers, one partial answer (`dup-timeout`), one rejected citation
(`exact-cluster`), and four no-answer cases. Three of those four correctly abstained;
`none-scattered-words` selected two unrelated memories. Across the corpus, eight selected
memories were non-relevant. All 18 answerable heldout cases had full recall; all four
no-answer heldout cases abstained, with one extra non-relevant selection in an answerable case.
All four scale/adversarial cases passed. See the [final Claude report](portable-quality-claude-final.json).
The rejected citation fails closed with `ValidationFailed`; it is still a failed recall case.

The [final Codex report](portable-quality-codex-final.json) used 116 calls (418,401 input
bytes, 13,083 output bytes), with per-case latency p50 13.18 s and p95 17.56 s. All 28
answerable corpus cases had full recall and there were no errors, but eight non-relevant
memories were selected across the corpus. Only two of four corpus no-answer cases abstained;
`none-queue-current` and `none-scattered-words` returned unrelated memories. All 18 answerable
heldout cases had full recall, all four heldout no-answer cases abstained, and no heldout
non-relevant memories were selected. All four scale/adversarial cases passed.

Both providers now pass the previously failing old-fact paraphrase and verbose task behind
1,000 newer notes. These results do not pass every quality target: corpus precision and
abstention remain work for a subsequent change. Ten of the 42 corpus cases test raw-search-only
features and are explicitly skipped by each selector run; 32 corpus and 22 heldout cases run.

The [credential-free lexical evaluation](portable-lexical-eval.md) also ran with zero and
10,000 filler notes. All hard safety/error/response bounds passed. SQLite `retrieve` achieved
0.909 corpus recall@10 and 0.944 heldout recall@10; its no-answer return rate was 50% in both
sets, missing the 20% target. Strict `search` also missed its overall/paraphrase recall and MRR
targets. These raw retrieval measurements are distinct from the model-selected workflow above.

## Operational limits

Markdown is a managed local directory with linear scans and exclusive locks. It rejects manual
edits and needs manual lock recovery after a process crash. It is not a general Markdown editor
sync engine or a network/share backend. SQLite remains the throughput-oriented default.
Discovery and provider disclosure are bounded and can omit facts. Ollama has an adapter but no
installed local model was evaluated here. No PostgreSQL, object-store or remote filesystem
plugin is claimed as implemented. See [storage plugins](../storage-plugins.md) for contracts,
backup/recovery and repeatable installation.
