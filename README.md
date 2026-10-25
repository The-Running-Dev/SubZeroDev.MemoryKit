# SubZeroDev.MemoryKit

Durable, inspectable memory for applications and AI agents. One store holds memories with
identity, namespaces, a lifecycle and provenance; SQLite keeps the current state and a Git
repository keeps every revision. The same service is reached embedded in a process, from the
command line, over HTTP and over MCP. No database server and no AI service are needed.

## Prerequisites

- Node.js 22.18 or later (24 recommended)
- Git on the `PATH` for revision history (optional: a store can use in-memory history or none)

## Install

The package is not published yet. Pack it from a checkout and install the tarball:

```bash
npm pack
```

```bash
npm install ./subzerodev-memorykit-0.1.0.tgz
```

## Command line

```bash
npx memorykit init ./store
```

```bash
npx memorykit create --store ./store --namespace team/notes --kind note --content "Deploys run on Fridays"
```

```bash
npx memorykit search --store ./store --namespace "team/*" --text deploys
```

`npx memorykit --help` lists every command: update, archive, restore, tombstone, supersede,
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
