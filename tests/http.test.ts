import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { after, describe, it } from 'node:test';
import { PERMISSIONS, type Grant } from '../src/access/index.ts';
import { ForbiddenError, RevisionConflictError } from '../src/model/index.ts';
import { connect, initStore, openTokenStore, type StoreConfig } from '../src/sdk/index.ts';
import { MAX_BODY_BYTES, serve } from '../src/server/index.ts';
import { CLI, runCli, tempDir } from './helpers.ts';

const ALL: Grant[] = [{ pattern: '*', permissions: [...PERMISSIONS] }];
const closers: (() => Promise<void>)[] = [];

async function issue(store: StoreConfig, grants: Grant[] = ALL) {
  const tokens = await openTokenStore(store);
  try {
    return await tokens.issue('tester', grants);
  } finally {
    await tokens.close();
  }
}

async function started(config: Partial<StoreConfig> = {}, allowedOrigins?: string[]) {
  const store: StoreConfig = { path: tempDir(), history: { provider: 'memory' }, ...config };
  await initStore(store);
  const server = await serve({
    store,
    listen: { host: '127.0.0.1', port: 0 },
    auth: { profile: 'local' },
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
  });
  closers.push(server.close);
  const { secret } = await issue(store);
  return { store, url: server.url, secret };
}

async function problem(response: Response) {
  assert.equal(response.headers.get('content-type'), 'application/problem+json');
  return (await response.json()) as { code: string; details: Record<string, unknown> };
}

// Resolves with the URL the serve process prints, or rejects when it exits first.
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

// Sends raw bytes and returns everything the service writes back before closing.
function rawExchange(url: string, request: string): Promise<string> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = netConnect(Number(port), hostname, () => socket.write(request));
    let text = '';
    socket.setEncoding('utf8').on('data', (chunk: string) => (text += chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(text));
  });
}

describe('S8 local HTTP service', () => {
  // Inside the suite, so the servers close before the helpers remove their directories.
  after(async () => {
    for (const close of closers.reverse()) await close();
  });

  it('S8.1 serve, token create and a create through connect', async () => {
    const dir = tempDir();
    assert.equal(runCli(['init', dir]).status, 0);
    const created = runCli([
      'token',
      'create',
      '--store',
      dir,
      '--principal',
      'app1',
      '--grant',
      'read,write:demo/*',
    ]);
    assert.equal(created.status, 0, created.stderr);
    const secret = /secret:\s+(\S+)/.exec(created.stdout)?.[1];
    assert.ok(secret !== undefined && secret.startsWith('mk_'));
    assert.equal(created.stdout.split(secret).length, 2, 'the secret is printed once');
    const listed = runCli(['token', 'list', '--store', dir]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /app1\s+read,write:demo\/\*/);
    assert.ok(!listed.stdout.includes(secret), 'list never shows a secret');

    const child = spawn(process.execPath, [
      CLI,
      'serve',
      '--store',
      dir,
      '--listen',
      '127.0.0.1:0',
    ]);
    const exited = new Promise((resolve) => child.on('exit', resolve));
    try {
      const url = await listening(child);
      const client = connect(url, { token: secret });
      const outcome = await client.create({ namespace: 'demo/a', kind: 'note', content: 'hello' });
      assert.equal(outcome.memory.namespace, 'demo/a');
      await assert.rejects(
        client.create({ namespace: 'other', kind: 'note', content: 'x' }),
        ForbiddenError
      );

      const got = spawnSync(
        process.execPath,
        [CLI, 'get', outcome.memory.id, '--url', url, '--token-env', 'MK_TEST_TOKEN', '--json'],
        { encoding: 'utf8', env: { ...process.env, MK_TEST_TOKEN: secret } }
      );
      assert.equal(got.status, 0, got.stderr);
      assert.equal((JSON.parse(got.stdout) as { content: string }).content, 'hello');
      const unset = spawnSync(
        process.execPath,
        [CLI, 'get', outcome.memory.id, '--url', url, '--token-env', 'MK_TEST_UNSET'],
        { encoding: 'utf8', env: { ...process.env, MK_TEST_UNSET: '' } }
      );
      assert.equal(unset.status, 2);
    } finally {
      child.kill();
      await exited;
    }
  });

  it('S8.2 no token and a revoked token get 401; non-loopback without TLS refuses', async () => {
    const { store, url } = await started();
    const missing = await fetch(`${url}/v1/status`);
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('www-authenticate'), 'Bearer');
    assert.equal((await problem(missing)).code, 'Unauthenticated');

    const { tokenId, secret } = await issue(store);
    const headers = { authorization: `Bearer ${secret}` };
    assert.equal((await fetch(`${url}/v1/status`, { headers })).status, 200);
    const tokens = await openTokenStore(store);
    await tokens.revoke(tokenId);
    await tokens.close();
    const revoked = await fetch(`${url}/v1/status`, { headers });
    assert.equal(revoked.status, 401);
    assert.equal((await problem(revoked)).code, 'Unauthenticated');

    await assert.rejects(
      serve({ store, listen: { host: '0.0.0.0', port: 0 }, auth: { profile: 'local' } }),
      (error: { code: string; details: { field: string } }) =>
        error.code === 'ValidationFailed' && error.details.field === 'tls'
    );
    const cli = runCli(['serve', '--store', store.path, '--listen', '0.0.0.0:0']);
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /"code":"ValidationFailed"/);
  });

  it('S8.3 a disallowed Origin gets 403 before authentication', async () => {
    const { url, secret } = await started({}, ['http://app.example']);
    const evil = await fetch(`${url}/v1/status`, { headers: { origin: 'http://evil.example' } });
    assert.equal(evil.status, 403);
    const body = await problem(evil);
    assert.equal(body.code, 'Forbidden');
    assert.equal(body.details.reason, 'origin');
    const allowed = await fetch(`${url}/v1/status`, {
      headers: { origin: 'http://app.example', authorization: `Bearer ${secret}` },
    });
    assert.equal(allowed.status, 200);
  });

  it('S8.4 a conflict is 409 problem+json; a pending-history write is 202', async () => {
    const { url, secret } = await started();
    const client = connect(url, { token: secret });
    const { memory } = await client.create({ namespace: 'demo', kind: 'note', content: 'a' });
    const conflict = await fetch(`${url}/v1/memories/${memory.id}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 5, content: 'b' }),
    });
    assert.equal(conflict.status, 409);
    const body = await problem(conflict);
    assert.equal(body.code, 'RevisionConflict');
    assert.equal(body.details.currentRevision, 1);
    await assert.rejects(
      client.update({ id: memory.id, expectedRevision: 5, content: 'b' }),
      (error) => error instanceof RevisionConflictError && error.details.currentRevision === 1
    );

    const slow = await started({ service: { historyWaitMs: 0 } });
    const pending = await fetch(`${slow.url}/v1/memories`, {
      method: 'POST',
      headers: { authorization: `Bearer ${slow.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'demo', kind: 'note', content: 'a' }),
    });
    assert.equal(pending.status, 202);
    assert.equal(((await pending.json()) as { history: string }).history, 'pending');
  });

  it('S8.6 a retry after a disconnect returns the stored outcome', async () => {
    const { url, secret } = await started();
    const client = connect(url, { token: secret });
    const body = JSON.stringify({ namespace: 'demo', kind: 'note', content: 'once' });
    const { hostname, port } = new URL(url);
    await new Promise<void>((resolve, reject) => {
      const socket = netConnect(Number(port), hostname, () => {
        socket.write(
          `POST /v1/memories HTTP/1.1\r\nHost: ${hostname}\r\n` +
            `Authorization: Bearer ${secret}\r\nIdempotency-Key: op-disconnect\r\n` +
            `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
            body,
          () => {
            socket.destroy();
            resolve();
          }
        );
      });
      socket.on('error', reject);
    });

    let operation;
    for (let attempt = 0; attempt < 100 && operation === undefined; attempt++) {
      try {
        operation = await client.operation('op-disconnect');
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.ok(operation !== undefined, 'the write completed after the client left');

    const retried = await client.create(
      { namespace: 'demo', kind: 'note', content: 'once' },
      { operationId: 'op-disconnect' }
    );
    assert.equal(retried.memory.id, operation.memoryId);
    assert.equal(retried.memory.revision, 1);
    const found = await client.search({ namespaces: ['demo'] });
    assert.equal(found.items.length, 1);
    assert.deepEqual(
      (await client.history(retried.memory.id)).map((item) => item.revision),
      [1]
    );
  });

  it('a body over the cap is LimitExceeded and the connection closes', async () => {
    const { url, secret } = await started();
    const reply = await rawExchange(
      url,
      `POST /v1/memories HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${secret}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${MAX_BODY_BYTES + 1}\r\n\r\n`
    );
    assert.match(reply, /^HTTP\/1\.1 413 /);
    assert.match(reply, /"code":"LimitExceeded"/);
  });

  it('an unknown route is NotFound and connect rejects a bad url', async () => {
    const { url, secret } = await started();
    const response = await fetch(`${url}/v1/nothing`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(response.status, 404);
    assert.equal((await problem(response)).code, 'NotFound');
    assert.throws(() => connect('ftp://example'), { code: 'ValidationFailed' });
    assert.throws(() => connect(`${url}?x=1`), { code: 'ValidationFailed' });
    await assert.rejects(connect('http://127.0.0.1:1', { token: secret }).status(), {
      code: 'StoreUnavailable',
    });
  });
});
