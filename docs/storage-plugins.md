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
a different provider for an existing store fails. Use the verified export/import commands below to migrate into a new store. Back up the entire
store directory with hosts stopped.

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
Retrieval uses simple plural normalization and match-count ranking, not SQLite's Porter/BM25
algorithm. Search scans local records by default. To enable a rebuildable candidate index,
set `"storage":{"provider":"markdown","searchIndex":true}` in the profile, or pass that
storage configuration to `initStore`/`openStore`. Regenerate hooks after profile changes.
The option is configuration, not part of portable memory content; carry it explicitly to each
reader. CLI, SDK, MCP and HTTP use the same configured backend.

The optional `markdown/search.sqlite` contains terms, identities, scopes and lifecycle/link
metadata, not authoritative content or credentials. It is sensitive derived data. Queries
load matching record files and related superseders, rechecking their hashes and applying the
usual service filters. Opening a store still checks all current files; writes and manifest
processing remain linear. This is an indexed read path, not a general scaling guarantee.
Missing/corrupt indexes rebuild from verified files. Current writers invalidate the index
before publishing writes, including purge and writers with indexing disabled. Stop all users
before manually removing a closed index and its `-journal` sidecar. Older binaries may leave
derived terms until the next rebuild; upgrade every writer before relying on invalidation.
Logical deletion does not securely erase SQLite free pages, filesystem copies or backups.
UNC paths are rejected; avoid network shares and concurrently synced folders.

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
Apply them with `memorykit install --profile <new-profile> --host <host> --settings <settings>`
for managed ownership checks and preservation of unrelated groups. Review/re-trust Codex hooks
through `/hooks`. Use `uninstall` with the old profile before changing ownership paths. Regenerate fragments after changing selector command timeouts or enabling discovery.
Doctor checks opening/status by default. Its explicit `--provider-probe` and `--readiness`
options are described in the [portable guide](portable-memory.md). Existing automatic
capture stays off unless explicitly enabled in the profile. For another project, an unpinned
profile follows Git origin; without a supported origin choose an explicit namespace.

## PostgreSQL plugin

Install the optional `pg` dependency (included by normal npm installs). Pass the absolute path
of the installed package's `dist/storage-postgres/index.js` as `--storage-plugin`. Set
`MEMORYKIT_POSTGRES_URL` in the server/host environment; configuration stores only the variable
name, never the URL or password:

```sh
memorykit setup --store /absolute/store --storage-plugin /absolute/package/dist/storage-postgres/index.js --storage-options '{"connectionStringEnv":"MEMORYKIT_POSTGRES_URL","storeId":"team-memory"}' --history git --output /absolute/config
```

The SDK can also import `PostgresStorage` from `subzerodev-memorykit/storage-postgres`.
Logical `storeId` must be new at initialization; reopening never silently creates a missing
store. The plugin now creates/upgrades `memorykit_search_rows_v1` and its GIN/scope indexes
under a schema advisory lock. The plugin connection needs schema CREATE and table
SELECT/INSERT/UPDATE/DELETE privileges, including index creation; deploy schema upgrades with
an appropriately authorized connection. It does not silently fall back after a permissions
failure. Use PostgreSQL connection settings appropriate to your server, including
TLS where required. Errors omit connection details. `timeoutMs` bounds connection, lock and
statement waits (default 10000, maximum 120000).

The authoritative state remains one JSONB snapshot per logical store, with serialized writes.
A transactionally maintained row mirror indexes exact and plural-normalized terms with GIN,
and filters scope/lifecycle before returning candidates. Final metadata filtering, ranking,
cursors and supersession projections retain the shared state engine's semantics. Reads use
a repeatable-read transaction; mirror changes, authoritative state and the version marker
commit atomically. If an older snapshot-only writer drops the marker, reads use authoritative
rows until a current writer/open rebuilds the mirror. This is lexical candidate indexing,
not PostgreSQL linguistic full-text or vector search. Untargeted reads, opening, writes and
snapshot serialization can still process the full store. Tokens, replay, policies, leases
and outbox state share the same database transaction. Purge removes current mirror rows;
database dead tuples, WAL, replicas and backups follow PostgreSQL retention procedures.

Git history remains local to the configured store directory. Keep one authoritative service
with that directory; pointing multiple independently initialized history directories at the
same PostgreSQL store is not a distributed deployment. Back up both PostgreSQL and the local
Git directory. Other storage plugins can implement different layouts without changing hosts.

## Verified backend migration

Stop every writer, drain history with `memorykit history-sync --store /absolute/source`, then
export to a new file. Use the same explicit plugin flags on source operations when applicable.

```sh
memorykit export-store /absolute/archive.json --store /absolute/source
memorykit import-store /absolute/archive.json --store /absolute/destination --storage markdown
```

The destination must
be a new directory and, for PostgreSQL, a new logical `storeId`. SDK administrators use
`exportStore(sourceConfig)` and `importStore(destinationConfig, archive)`. These operations
are deliberately local administration APIs, unavailable to HTTP/MCP clients.

The versioned archive contains current records (including inactive states), IDs, keys,
revisions, provenance, candidate/accepted/rejected metadata, namespace policies and the full
retained Git main history bundle. Revision identity continues at the destination. Tokens and
operation replay caches are excluded; issue new tokens and use new operation IDs. Git history
can retain previously purged content under its existing purge contract. Treat archives as
sensitive backups. Checksums detect corruption, not an untrusted producer's authenticity.

Export refuses undrained/blocked history and detects a changed snapshot. Import validates
structure/checksum/Git bundle, restores in a staging directory, rechecks the snapshot, then
moves it to the destination. Do not run competing administrators on the same destination.
It never updates the source or replaces an existing populated destination. A failed PostgreSQL
import can reserve the new logical ID; retry with another new ID after investigating. Custom
storage plugins must implement optional `snapshot`/`restoreSnapshot` to support migration;
normal contract-version-1 plugins remain compatible. In-memory/custom history archives are
unsupported. Migrations require enough memory/disk for a complete snapshot and Git bundle.


## Packaged compatibility checks

Import `runStorageConformance` from `subzerodev-memorykit/conformance`. It runs the same shared
service scenarios used by the transport tests, always against fresh temporary directories,
with Git history. It returns a versioned report with case names and pass/fail, omitting plugin
error details that might contain credentials. Git must be installed.

```js
import { runStorageConformance } from 'subzerodev-memorykit/conformance';
const report = await runStorageConformance({ provider: 'markdown' });
if (!report.passed) throw new Error(JSON.stringify(report));
```

For plugins backed by a remote database, pass a synchronous factory that returns a new logical
store identity for every case. Never use an existing production store. The runner deletes only
its local directories; you must remove the disposable database rows/stores afterward. The
packaged `examples/check-storage-plugin.mjs <trusted-config.json>` illustrates SQLite, Markdown
and the included PostgreSQL plugin's `storeId` convention. Other plugins must adapt the factory
to their own isolation options. Modules run trusted code. Compatibility does not certify
throughput, every token-store behavior, crash durability or backend-specific fault recovery.
