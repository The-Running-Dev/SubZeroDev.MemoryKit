# ADR-0005: Portable storage plugins and bounded task discovery

Status: Accepted for this implementation, 2026-11-01.

The product must serve arbitrary applications, projects and LLM hosts. SQLite-specific
SDK construction prevented real storage substitution, and recent-only disclosure omitted
older facts even when a selector could recognize their relevance.

Make `StorageConfig` an SDK/CLI/profile choice. SQLite remains the default; managed local
Markdown is the second built-in. External absolute-path modules export `createStorage`
returning a contract-version-1 `StorageProvider` plus `TokenStore`. MemoryKit owns their
shared open/close lifecycle. HTTP/MCP servers select storage at startup, so requests cannot
load code. External configuration remains explicit on every open; store markers identify
only provider kind and never contain executable/module paths. Git remains an independent
history provider, composable with any conforming storage. Existing unmarked SQLite stores
continue opening without migration.

Markdown uses immutable content-addressed records and an atomic manifest under an exclusive
local filesystem lock. The manifest owns revision/idempotency state, token hashes, history
outbox, namespace policies and fencing. Flush record and manifest files before replacing
the manifest; readers hold the same lock. Collect unreachable old files on save/open and
clear current content copies on purge. Reject externally edited records. Never guess that
a lock is stale: process-crash recovery requires stopping all users before manually removing
the lock. This trades throughput and automatic recovery for inspectable current records
and a small auditable implementation. It is not an editor sync engine or network filesystem
backend. Filesystem directory-entry durability after power loss is OS/filesystem dependent.

Before selection, search all eligible authorized records with at most sixteen deterministic
task terms and eight optional model-generated queries. Fuse ranks and reserve recent slots;
limit disclosure to the existing 32 passages/64 KiB. Window long passages around task terms.
Model expansion receives the query only and cannot choose scopes or filters. Validate all
generated queries before searching. Selection still requires current IDs/revisions and exact
quotes and fails closed; omission reasons remain visible. These finite searches can still
miss facts; no exhaustive discovery or answerability claim follows.

Add an existing-login Codex command example alongside Claude and Ollama, and an opt-in real
quality harness over the existing corpus/heldout plus older-fact and adversarial cases.
Published measurements must state workflow eligibility transformations, skipped raw-search
features, false injections, errors, cost proxy and latency; historical quality gates remain
separate. Native acceptance tests consume installed, regenerated hooks with each storage choice.

`upgrade` regenerates profiles/fragments into a fresh directory with the current executable;
`doctor` opens the configured store and reports status. Neither edits host settings. Operators
review/merge new fragments and re-trust Codex hooks. This permits repeatable package upgrades
without overwriting working host configuration or changing acceptance/capture policy.
