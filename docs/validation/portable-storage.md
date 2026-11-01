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

Native acceptance uses an installed archive and installed selector examples, existing logins,
isolated synthetic projects, and Markdown current storage. It regenerates configuration with
`upgrade` before testing the actual generated hooks. Capture stays off. Claude uses Haiku;
Codex uses its existing-login default model. See the harness for isolation and hook trust
details; global host configuration is never changed.

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

## Operational limits

Markdown is a managed local directory with linear scans and exclusive locks. It rejects manual
edits and needs manual lock recovery after a process crash. It is not a general Markdown editor
sync engine or a network/share backend. SQLite remains the throughput-oriented default.
Discovery and provider disclosure are bounded and can omit facts. Ollama has an adapter but no
installed local model was evaluated here. No PostgreSQL, object-store or remote filesystem
plugin is claimed as implemented. See [storage plugins](../storage-plugins.md) for contracts,
backup/recovery and repeatable installation.
