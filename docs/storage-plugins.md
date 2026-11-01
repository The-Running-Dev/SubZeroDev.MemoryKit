# Storage plugins and upgrades

Storage owns current records and transactional state. History owns retained revisions.
Choose them independently: SQLite + Git, Markdown + Git, either + no history, or your own
storage module + any existing history provider. Every LLM host sees the same SDK/CLI/HTTP/MCP
service and namespace/lifecycle rules. Adding a storage backend requires implementing its
contract; selecting a different LLM does not require a new storage adapter.

```sh
memorykit setup --store /absolute/store --storage markdown --history git --output /absolute/config-v1
memorykit doctor --profile /absolute/config-v1/memorykit.profile.json
```

SQLite remains the default and is identified by `memory.db`. Other stores identify their
provider kind in `memorykit.store.json`; old SQLite stores remain compatible. Selecting
a different provider for an existing store fails. This release does not convert existing
stores between backends. Back up the entire store directory with hosts stopped.

## External modules

An explicitly trusted ES module exports this public TypeScript interface:

```ts
import type { StoragePlugin } from 'subzerodev-memorykit';
export const createStorage: StoragePlugin['createStorage'] = async ({ path, initialize, options }) => {
  // Construct your provider; do not open it here.
  // return { storage: yourStorageProvider, tokens: yourTokenStore };
  throw new Error('Implement the storage and token contracts');
};
```

`StorageProvider` and `TokenStore` are exported from the root package. The factory receives
the store directory, whether initialization is requested, and a JSON options object.
MemoryKit opens/closes `storage`; tokens must share that lifecycle. The provider must implement
contract version 1 including transactions, optimistic revisions, exact operation replay,
namespace filtering, cursor binding, outbox leases/fencing, purge and token revocation.
Run `tests/conformance/scenarios.ts` through your driver plus backend-specific crash and
concurrency tests. The packaged `examples/markdown-storage-plugin.mjs` demonstrates composition
using the public Markdown implementation.

```sh
memorykit setup --store /absolute/store --storage-plugin /absolute/plugin.mjs --storage-options '{"busyTimeoutMs":5000}' --output /absolute/config
```

The SDK accepts `storage: {provider:'plugin', module:'/absolute/plugin.mjs', options:{...}}`.
For raw CLI, `serve` and `mcp`, pass the same flags on each start. A local workflow profile
persists that trusted configuration and generated MCP fragments carry it forward. Plugin
code runs as you; keep profiles/modules outside untrusted repositories. The store marker
never loads code. An external store without explicit plugin configuration fails closed.
Remote clients select no backend; the server owns that configuration.

## Managed Markdown behavior

Current records live in `markdown/records/<content-hash>.md`, with JSON front matter and
unaltered record content. `markdown/state.json` atomically identifies the current files and
stores namespace policies, operation outcomes, outbox state, fencing and token hashes.
Outcomes/outbox can contain duplicate content needed for replay/export; purge removes current
copies, while separate Git history follows the existing purge/redaction contract.

This is a managed directory: use MemoryKit APIs to edit it. Manual edits fail integrity checks.
Search scans local records; retrieval uses simple plural normalization and match-count ranking,
not SQLite's Porter/BM25 algorithm. Performance is intended for modest local stores. Use SQLite
for larger stores. UNC paths are rejected; avoid network shares and concurrently synced folders.

All readers/writers coordinate through an exclusive `markdown/.lock` directory. A busy store
times out instead of overwriting another writer. After a process crash, stop **every** MemoryKit
process using the store, back up the directory, then remove only that store's `.lock` directory.
On reopen, the last committed manifest is checked and unreachable record/temp files collected.
Never remove a lock while a host might still be using it. File contents are fsynced before
manifest replacement; directory-entry persistence after power loss depends on the filesystem.
Git history is a separate retained copy and is not a substitute for backups.

## Repeatable install and upgrade

Build an archive from the intended checkout with `npm ci`, `npm pack`. Install that exact
archive into a dedicated tools directory (`npm install /absolute/archive.tgz`), keeping its
lockfile. Use its `node_modules/.bin/memorykit` executable for the following commands:

```sh
memorykit upgrade --profile /absolute/config-v1/memorykit.profile.json --output /absolute/config-v2
memorykit doctor --profile /absolute/config-v2/memorykit.profile.json
memorykit context --profile /absolute/config-v2/memorykit.profile.json --text 'your known fact'
```

Upgrade preserves the profile's capture, acceptance, scope and provider choices and points
new fragments at the current installed CLI. Choose a fresh output directory every time.
Review/merge the fragments into Claude settings or Codex hooks, preserving unrelated groups;
review/re-trust Codex hooks through `/hooks`. Remove old MemoryKit groups once replacements are
active. Regenerate fragments after changing selector command timeouts or enabling discovery.
Doctor checks opening/status, not model login quality or host hook activation. Existing automatic
capture stays off unless explicitly enabled in the profile. For another project, an unpinned
profile follows Git origin; without a supported origin choose an explicit namespace.
