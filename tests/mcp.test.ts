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
    assert.equal(names.length, 11);
    for (const name of names) assert.doesNotMatch(name, /purge|namespace|sync/);
    for (const tool of tools) assert.equal(tool.inputSchema.type, 'object');
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
  });
});
