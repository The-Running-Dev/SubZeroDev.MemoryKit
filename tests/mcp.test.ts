import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { PERMISSIONS, type Grant } from '../src/access/index.ts';
import { MCP_PROTOCOL_VERSION, MCP_TOOLS } from '../src/mcp/index.ts';
import { initStore, openStore, openTokenStore, type StoreConfig } from '../src/sdk/index.ts';
import { serve } from '../src/server/index.ts';
import { CLI, tempDir } from './helpers.ts';
import { startIssuer, type TestIssuer } from './oidc-issuer.ts';
import { CERT_FILE, KEY_FILE, trustingFetch } from './tls.ts';

const AUDIENCE = 'memorykit-test';
const DEMO: Grant[] = [{ pattern: 'demo/*', permissions: ['read', 'write'] }];
const closers: (() => Promise<void>)[] = [];

const newClient = () =>
  new Client(
    { name: 'memorykit-test', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } }
  );

async function overStdio(store: string): Promise<Client> {
  const client = newClient();
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', '--store', store] })
  );
  closers.push(() => client.close());
  return client;
}

async function overHttp(url: string, token?: string, fetch?: typeof globalThis.fetch) {
  const client = newClient();
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', url), {
      ...(token === undefined
        ? {}
        : { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
      ...(fetch === undefined ? {} : { fetch }),
    })
  );
  closers.push(() => client.close());
  return client;
}

async function localToken(store: string, grants: Grant[]): Promise<string> {
  const tokens = await openTokenStore({ path: store });
  try {
    return (await tokens.issue('mcp-test', grants)).secret;
  } finally {
    await tokens.close();
  }
}

function listening(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
      const match = /Listening on (\S+)/.exec(out);
      if (match) resolve(match[1]!);
    });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
    child.on('exit', (code) => reject(new Error(`serve exited ${code}: ${err}`)));
  });
}

// The first line a process writes after it is sent one JSON-RPC message.
function firstReply(child: ChildProcess, message: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
      const end = out.indexOf('\n');
      if (end >= 0) resolve(JSON.parse(out.slice(0, end)) as Record<string, unknown>);
    });
    child.on('exit', (code) => reject(new Error(`mcp exited ${code}`)));
    child.stdin!.write(JSON.stringify(message) + '\n');
  });
}

const LEGACY_INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'legacy', version: '0.0.0' },
  },
};

type Structured = Record<string, unknown>;

describe('S10 MCP', () => {
  let issuer: TestIssuer;
  before(async () => {
    issuer = await startIssuer(AUDIENCE);
  });
  // Inside the suite, so clients and servers close before the helpers remove their directories.
  after(async () => {
    for (const close of closers.reverse()) await close();
    await issuer.close();
  });

  it('S10.1 a stdio create is read back by another process over Streamable HTTP', async () => {
    const store = tempDir();
    await initStore({ path: store });
    const stdio = await overStdio(store);
    const discovered = await stdio.discover();
    assert.ok(discovered.supportedVersions?.includes(MCP_PROTOCOL_VERSION) ?? true);
    const created = await stdio.callTool({
      name: 'memory_create',
      arguments: { namespace: 'demo/notes', kind: 'note', content: 'hello', operationId: 'op-1' },
    });
    assert.equal(created.isError, undefined);
    const memory = (created.structuredContent as Structured).memory as Structured;
    assert.equal((created.structuredContent as Structured).operationId, 'op-1');
    assert.equal(memory.content, 'hello');

    const token = await localToken(store, [{ pattern: '*', permissions: [...PERMISSIONS] }]);
    const child = spawn(process.execPath, [
      CLI,
      'serve',
      '--store',
      store,
      '--listen',
      '127.0.0.1:0',
    ]);
    closers.push(async () => {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    });
    const http = await overHttp(await listening(child), token);
    const read = await http.callTool({ name: 'memory_get', arguments: { id: memory.id } });
    assert.equal(read.isError, undefined);
    assert.deepEqual(read.structuredContent, memory);
  });

  it('S10.2 the remote profile hides other namespaces and refuses a missing token', async () => {
    const store: StoreConfig = { path: tempDir(), history: { provider: 'memory' } };
    await initStore(store);
    const embedded = await openStore(store);
    const other = await embedded.create({ namespace: 'team/b', kind: 'note', content: 'b' });
    await embedded.close();
    const server = await serve({
      store,
      listen: { host: '127.0.0.1', port: 0 },
      tls: { certFile: CERT_FILE, keyFile: KEY_FILE },
      auth: { profile: 'remote', issuer: issuer.issuer, audience: AUDIENCE, ceiling: DEMO },
    });
    closers.push(server.close);

    const token = issuer.token({ sub: 'alice', scope: 'mk:read:demo/* mk:write:demo/*' });
    const client = await overHttp(server.url, token, trustingFetch);
    const hidden = await client.callTool({
      name: 'memory_get',
      arguments: { id: other.memory.id },
    });
    assert.equal(hidden.isError, true);
    assert.equal((hidden.structuredContent as Structured).code, 'NotFound');

    const missing = await trustingFetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get('www-authenticate') ?? '', /^Bearer resource_metadata=/);
    assert.equal(((await missing.json()) as Structured).code, 'Unauthenticated');
  });

  it('a replacement in an unreadable namespace stays out of supersededBy', async () => {
    // Git history, so the revisions outlive the embedded store that wrote them.
    const store: StoreConfig = { path: tempDir() };
    await initStore(store);
    const embedded = await openStore(store);
    const { memory } = await embedded.create({ namespace: 'public', kind: 'note', content: 'old' });
    await embedded.supersede({
      id: memory.id,
      expectedRevision: 1,
      replacement: { namespace: 'private', kind: 'note', content: 'new' },
    });
    await embedded.close();
    const server = await serve({
      store,
      listen: { host: '127.0.0.1', port: 0 },
      auth: { profile: 'local' },
    });
    closers.push(server.close);
    const token = await localToken(store.path, [
      { pattern: 'public', permissions: ['read', 'history'] },
    ]);
    const client = await overHttp(server.url, token);

    const read = await client.callTool({ name: 'memory_get', arguments: { id: memory.id } });
    assert.deepEqual((read.structuredContent as Structured).supersededBy, []);
    const found = await client.callTool({
      name: 'memory_search',
      arguments: { states: ['superseded'] },
    });
    const items = (found.structuredContent as Structured).items as Structured[];
    assert.deepEqual(
      items.map((item) => item.supersededBy),
      [[]]
    );
    const revision = await client.callTool({
      name: 'memory_revision',
      arguments: { id: memory.id, revision: 2 },
    });
    const record = (revision.structuredContent as Structured).record as Structured;
    assert.deepEqual(record.supersededBy, []);
  });

  it('S10.3 domain errors carry the code, retryable and details', async () => {
    const store = tempDir();
    await initStore({ path: store });
    const client = await overStdio(store);
    const bad = await client.callTool({
      name: 'memory_create',
      arguments: { namespace: 'Demo', kind: 'note', content: 'x' },
    });
    assert.equal(bad.isError, true);
    const structured = bad.structuredContent as Structured;
    assert.equal(structured.code, 'ValidationFailed');
    assert.equal(structured.retryable, false);
    assert.equal(typeof structured.details, 'object');
  });

  it('S10.4 only the eleven memory tools are listed', async () => {
    const store = tempDir();
    await initStore({ path: store });
    const client = await overStdio(store);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...MCP_TOOLS].sort());
    assert.equal(names.length, 12);
    for (const name of names) assert.doesNotMatch(name, /purge|namespace|sync/);
    for (const tool of tools) assert.equal(tool.inputSchema.type, 'object');
  });

  it('the discovered schemas describe what the service takes', async () => {
    const store = tempDir();
    await initStore({ path: store });
    const client = await overStdio(store);
    const schemas = Object.fromEntries(
      (await client.listTools()).tools.map((tool) => [tool.name, tool.inputSchema as Structured])
    );
    const props = (schema: Structured) => schema.properties as Record<string, Structured>;
    const origin = {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        name: { type: 'string' },
        version: { type: 'string' },
      },
      required: ['kind', 'name'],
      additionalProperties: false,
    };
    const provenances = [
      ...[
        'memory_create',
        'memory_update',
        'memory_archive',
        'memory_restore',
        'memory_tombstone',
      ].map((name) => props(schemas[name]!).provenance!),
      props(props(schemas.memory_supersede!).replacement!).provenance!,
    ];
    for (const provenance of provenances) assert.deepEqual(props(provenance).origin, origin);
    // Every input the service refuses an unknown field in says so.
    for (const schema of Object.values(schemas)) assert.equal(schema.additionalProperties, false);
    assert.equal(props(schemas.memory_revision!).revision!.minimum, 1);
    assert.equal(props(schemas.memory_update!).expectedRevision!.minimum, 1);
    assert.equal(props(schemas.memory_search!).limit!.minimum, 1);
    assert.deepEqual(schemas.memory_retrieve!.required, ['text']);
    assert.equal(props(schemas.memory_retrieve!).excerptChars!.minimum, 1);
    assert.equal(props(schemas.memory_create!).waitForHistoryMs!.minimum, 0);

    const created = await client.callTool({
      name: 'memory_create',
      arguments: {
        namespace: 'demo',
        kind: 'note',
        content: 'x',
        provenance: { origin: { kind: 'agent', name: 'codex', version: '1' } },
      },
    });
    assert.equal(created.isError, undefined);
    const memory = (created.structuredContent as Structured).memory as Structured;
    assert.deepEqual((memory.provenance as Structured).origin, {
      kind: 'agent',
      name: 'codex',
      version: '1',
    });
    const refused = await client.callTool({
      name: 'memory_create',
      arguments: { namespace: 'demo', kind: 'note', content: 'x', provenance: { origin: 'codex' } },
    });
    assert.equal(refused.isError, true);
    assert.deepEqual(refused.structuredContent, {
      code: 'ValidationFailed',
      retryable: false,
      details: { field: 'provenance.origin', reason: 'not_an_object' },
    });
  });

  it('tombstone and restore describe the lifecycle they run', async () => {
    const store = tempDir();
    await initStore({ path: store });
    const client = await overStdio(store);
    const described = Object.fromEntries(
      (await client.listTools()).tools.map((tool) => [tool.name, tool.description ?? ''])
    );
    assert.doesNotMatch(described.memory_tombstone!, /no longer change/);
    assert.match(described.memory_tombstone!, /until it is restored/);
    assert.match(described.memory_restore!, /archived/);
    assert.match(described.memory_restore!, /tombstoned/);

    const created = await client.callTool({
      name: 'memory_create',
      arguments: { namespace: 'demo', kind: 'note', content: 'x' },
    });
    const id = ((created.structuredContent as Structured).memory as Structured).id;
    const step = async (name: string, expectedRevision: number) => {
      const result = await client.callTool({ name, arguments: { id, expectedRevision } });
      return (result.structuredContent as Structured).memory as Structured;
    };
    assert.equal((await step('memory_archive', 1)).state, 'archived');
    const tombstoned = await step('memory_tombstone', 2);
    assert.deepEqual([tombstoned.state, tombstoned.priorState], ['tombstoned', 'archived']);
    const read = await client.callTool({ name: 'memory_get', arguments: { id } });
    assert.equal((read.structuredContent as Structured).state, 'tombstoned');
    assert.equal((await step('memory_restore', 3)).state, 'archived');
    assert.equal((await step('memory_restore', 4)).state, 'active');
  });

  it('S10.5 a 2025-era client is refused with the supported versions', async () => {
    const store = tempDir();
    await initStore({ path: store });
    const child = spawn(process.execPath, [CLI, 'mcp', '--store', store]);
    closers.push(async () => {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.stdin.end();
      await exited;
    });
    const reply = await firstReply(child, LEGACY_INITIALIZE);
    const error = reply.error as { code: number; data: { supported: string[] } };
    assert.equal(error.code, -32022);
    assert.deepEqual(error.data.supported, [MCP_PROTOCOL_VERSION]);

    const token = await localToken(store, [{ pattern: '*', permissions: ['read'] }]);
    const server = await serve({
      store: { path: store },
      listen: { host: '127.0.0.1', port: 0 },
      auth: { profile: 'local' },
    });
    closers.push(server.close);
    const refused = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(LEGACY_INITIALIZE),
    });
    assert.equal(refused.status, 400);
    const body = (await refused.json()) as {
      error: { code: number; data: { supported: string[] } };
    };
    assert.equal(body.error.code, -32022);
    assert.deepEqual(body.error.data.supported, [MCP_PROTOCOL_VERSION]);

    // No subscription stream is opened, so it cannot hold the server open.
    const listen = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'subscriptions/listen', params: {} }),
    });
    assert.deepEqual(((await listen.json()) as { error: { code: number } }).error.code, -32601);
  });
});
