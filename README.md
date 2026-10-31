# SubZeroDev.MemoryKit

Durable, inspectable memory for applications and AI agents. One store holds memories with
identity, namespaces, a lifecycle and provenance; SQLite keeps the current state and a Git
repository keeps every revision. The same service is reached embedded in a process, from the
command line, over HTTP and over MCP. No database server and no AI service are needed.

## Prerequisites

- Node.js 22.18 or later (24 recommended)
- Git on the `PATH` for revision history (optional: a store can use in-memory history or none)

## Install

The package is not published yet. `subzerodev-memorykit` on npmjs is the proposed
distribution identity, pending owner approval; `private: true` still blocks publication.
See [the publication plan](docs/publishing.md) for the comparison, ownership checks and
release procedure. Pack it from a checkout and install the tarball:

```bash
npm ci
npm pack
```

```bash
npm install ./subzerodev-memorykit-0.1.0.tgz
```

## Command line

```bash
npx --no-install memorykit init ./store
```

```bash
npx --no-install memorykit create --store ./store --namespace team/notes --kind note --content "Deploys run on Fridays"
```

```bash
npx --no-install memorykit search --store ./store --namespace "team/*" --text deploys
```

`retrieve` takes the same filters and returns compact items with a bounded excerpt instead of
whole records, for a caller with a context budget; `get` fetches a record whole.

```bash
npx --no-install memorykit retrieve --store ./store --namespace "team/*" --text deploys
```

`npx --no-install memorykit --help` lists every command: update, archive, restore, tombstone, supersede,
purge, history and revision, operation status, namespace history policy, history sync, tokens,
`serve` (HTTP) and `mcp` (MCP over stdio). Exit code 3 means the write succeeded and its
history export is still pending.

## Embedded

```ts
import { initStore, openStore } from 'subzerodev-memorykit';

await initStore({ path: './store' });
const memory = await openStore({ path: './store' });
const { memory: note } = await memory.create({
  namespace: 'team/notes',
  kind: 'note',
  content: 'Deploys run on Fridays',
});
const found = await memory.search({ namespaces: ['team/*'], text: 'deploys' });
await memory.update({ id: note.id, expectedRevision: 1, content: 'Deploys run on Thursdays' });
const first = await memory.revision(note.id, 1);
await memory.close();
```

Every write takes the revision it expects, so concurrent writers never overwrite each other
silently, and an `operationId` makes a retried write return the first outcome. `connect(url,
{ token })` gives the same client over HTTP.

`initStore` creates storage and initializes the selected history provider; it does not write
a configuration file or persist a default policy. Pass configuration on every open. History
defaults to Git and the default namespace policy to `full`; a namespace's policy is persisted
on first write or explicit set, so changing an open-time default does not change existing ones.

The imports below use the current local/proposed name. A scoped choice would change both
the root specifier and the `/history-git` prefix; the API and `memorykit` binary stay the same.

For direct provider composition, use the public Git entry:

```ts
import { EMBEDDED_PRINCIPAL, MemoryService, SqliteStorage } from 'subzerodev-memorykit';
import { GitHistory } from 'subzerodev-memorykit/history-git';

const service = new MemoryService(
  new SqliteStorage({ path: './memory.db' }),
  new GitHistory({
    repository: './history.git',
    author: { name: 'My application', email: 'app@localhost' },
  })
);
await service.open();
const client = service.as(EMBEDDED_PRINCIPAL);
await client.create({ namespace: 'app', kind: 'note', content: 'hello' });
await service.close();
```

The root entry keeps Git unloaded when the SDK selects `memory` or `none`. Importing
`/history-git` explicitly loads the provider for composition; internal deep imports remain
blocked. History retries deduplicate by operation id, memory id and revision, so both records
from a supersede are exported once even though they share one operation id.

## Service

`memorykit serve --store ./store` listens on loopback with local tokens from `memorykit token
create`. With `--tls-cert`, `--tls-key` and the `--oidc-*` flags it serves remote clients with
bearer tokens from an OpenID Connect issuer. `/mcp` on the same listener and `memorykit mcp`
over stdio expose the memory tools to MCP clients.

<!-- BEGIN project-commands -->

## Install

```bash
npm install
```

## Build

```bash
npm run build
```

## Test

```bash
npm test
```

## Lint

```bash
npm run lint
```

## Run Locally

```bash
npm start
```

<!-- END project-commands -->

`npm run check:package` packs the package, installs it into an empty directory and runs it
end to end. `npm run bench` prints the baseline benchmark; [bench/baseline.md](bench/baseline.md)
holds the committed numbers.

## Architecture

- **src/** — the service, its providers (SQLite storage, Git and in-memory history) and its
  adapters (SDK, CLI, HTTP, MCP)
- **tests/** — acceptance tests per slice and one conformance suite run through every adapter
- **design/** — the brief, design, contract, slices and decision log
