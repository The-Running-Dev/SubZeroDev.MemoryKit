import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { initStore, openStore, openTokenStore } from '../src/sdk/index.ts';
import { MarkdownStorage } from '../src/storage-markdown/index.ts';
import { MemoryService } from '../src/service/index.ts';
import { EMBEDDED_PRINCIPAL } from '../src/access/index.ts';
import {
  StoreBusyError,
  StoreUnavailableError,
  ValidationFailedError,
} from '../src/model/index.ts';
import { runCli, tempDir } from './helpers.ts';

it('serializes Markdown writes across processes and preserves Git revision history', async () => {
  const path = tempDir();
  await initStore({ path, storage: { provider: 'markdown' } });
  const write = (index: number) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          'tests/fixtures/write.ts',
          path,
          'create',
          JSON.stringify({ namespace: 'demo', kind: 'note', content: `process ${index}` }),
        ],
        { windowsHide: true }
      );
      let output = '',
        error = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (error += chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        try {
          assert.equal(code, 0, error);
          assert.equal(JSON.parse(output).ok, true, output);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  await Promise.all([0, 1, 2, 3].map(write));
  const client = await openStore({ path });
  try {
    assert.equal((await client.search({ namespaces: ['demo'] })).items.length, 4);
    const record = (await client.search({ namespaces: ['demo'], text: 'process' })).items[0]!;
    await client.update({ id: record.id, expectedRevision: 1, content: 'changed' });
    assert.equal((await client.syncHistory({ budgetMs: 10000 })).blocked, null);
    const snapshot = await client.revision(record.id, 1);
    assert.equal('content' in snapshot.record && snapshot.record.content, record.content);
  } finally {
    await client.close();
  }
});

describe('managed Markdown storage', () => {
  it('rejects invalid lock timeouts instead of waiting indefinitely', () => {
    for (const busyTimeoutMs of [NaN, Infinity, -1, 0.5, 120001])
      assert.throws(
        () => new MarkdownStorage({ path: tempDir(), busyTimeoutMs }),
        ValidationFailedError
      );
  });
  it('rolls back a failed transaction, persists replays, and removes all current copies on purge', async () => {
    const path = tempDir();
    await initStore({ path, storage: { provider: 'markdown' }, history: { provider: 'none' } });
    let c = await openStore({ path, history: { provider: 'none' } });
    const input = {
      namespace: 'project/demo',
      kind: 'note',
      content: 'PURGE_CONTENT_SENTINEL',
      metadata: { status: 'accepted' },
    };
    const original = await c.create(input, { operationId: 'create-once' });
    await c.update({ id: original.memory.id, expectedRevision: 1, content: 'NEW_PURGE_SENTINEL' });
    await c.close();
    c = await openStore({ path, history: { provider: 'none' } });
    assert.equal((await c.create(input, { operationId: 'create-once' })).memory.revision, 1);
    assert.equal((await c.get(original.memory.id)).revision, 2);
    await c.purge({ id: original.memory.id, expectedRevision: 2 }, { operationId: 'purge-once' });
    await c.close();
    assert.equal(readdirSync(join(path, 'markdown', 'records')).length, 0);
    assert.doesNotMatch(
      readFileSync(join(path, 'markdown', 'state.json'), 'utf8'),
      /PURGE_CONTENT_SENTINEL|NEW_PURGE_SENTINEL/
    );

    const storage = new MarkdownStorage({ path: join(path, 'markdown') });
    await storage.open();
    await assert.rejects(
      storage.write(async (tx) => {
        await tx.namespacePolicy('rollback', 'full');
        throw new Error('rollback');
      }),
      /rollback/
    );
    assert.equal(await storage.getNamespace('rollback'), null);
    await storage.close();
  });
  it('coordinates independent connections and fences stale history drainers', async () => {
    const path = tempDir();
    await initStore({ path, storage: { provider: 'markdown' }, history: { provider: 'none' } });
    const clients = await Promise.all([
      openStore({ path, history: { provider: 'none' } }),
      openStore({ path, history: { provider: 'none' } }),
    ]);
    try {
      const first = await clients[0]!.create({ namespace: 'demo', kind: 'note', content: 'one' });
      const results = await Promise.allSettled(
        clients.map((c) => c.update({ id: first.memory.id, expectedRevision: 1, content: 'two' }))
      );
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const failed = results.find((r) => r.status === 'rejected');
      assert.ok(failed?.status === 'rejected' && failed.reason.code === 'RevisionConflict');
    } finally {
      await Promise.all(clients.map((c) => c.close()));
    }
    const a = new MarkdownStorage({ path: join(path, 'markdown') });
    const b = new MarkdownStorage({ path: join(path, 'markdown') });
    await a.open();
    await b.open();
    const old = await a.acquireDrainLease('a', 0);
    const fresh = await b.acquireDrainLease('b', 10000);
    assert.ok(old && fresh && fresh.token > old.token);
    assert.equal(await a.markExported(1, 'stale', old.token), false);
    assert.equal(await b.markExported(1, 'current', fresh.token), true);
    await a.close();
    await b.close();
  });
  it('fails closed on external Markdown edits and never guesses that a lock is stale', async () => {
    const path = tempDir();
    const storage = new MarkdownStorage({ path, busyTimeoutMs: 20 });
    const service = new MemoryService(storage, null);
    await service.open();
    const client = service.as(EMBEDDED_PRINCIPAL);
    const result = await client.create({ namespace: 'demo', kind: 'note', content: 'original' });
    const file = join(path, 'records', readdirSync(join(path, 'records'))[0]!);
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, original.replace('original', 'changed'));
    await assert.rejects(client.get(result.memory.id), StoreUnavailableError);
    writeFileSync(file, original);
    mkdirSync(join(path, '.lock'));
    await assert.rejects(client.get(result.memory.id), StoreBusyError);
    assert.ok(existsSync(join(path, '.lock')));
    rmSync(join(path, '.lock'), { recursive: true });
    await service.close();
  });
  it('stores only token hashes, preserves revocation and supports the CLI init path', async () => {
    const path = join(tempDir(), 'store');
    const result = runCli(['init', path, '--storage', 'markdown', '--history', 'none']);
    assert.equal(result.status, 0, result.stderr);
    const tokens = await openTokenStore({ path });
    const issued = await tokens.issue('reader', [{ pattern: 'demo', permissions: ['read'] }]);
    assert.equal((await tokens.verify(issued.secret))?.id, 'reader');
    assert.doesNotMatch(
      readFileSync(join(path, 'markdown', 'state.json'), 'utf8'),
      new RegExp(issued.secret)
    );
    await tokens.revoke(issued.tokenId);
    assert.equal(await tokens.verify(issued.secret), null);
    await tokens.close();
    await assert.rejects(
      openStore({ path, storage: { provider: 'sqlite' } }),
      StoreUnavailableError
    );
  });
  it('loads an explicit third-party module through SDK, token and CLI paths', async () => {
    const root = tempDir(),
      path = join(root, 'store');
    const module = join(root, 'plugin.mjs');
    const implementation = pathToFileURL(join(process.cwd(), 'src/storage-markdown/index.ts')).href;
    writeFileSync(
      module,
      `import { MarkdownStorage } from ${JSON.stringify(implementation)};
      export async function createStorage({path, options}) {
        if(options.expected !== true) throw new Error('Missing options');
        const storage = new MarkdownStorage({path:path+'/custom'});
        return {storage,tokens:storage};
      }`
    );
    const storage = { provider: 'plugin' as const, module, options: { expected: true } };
    await initStore({ path, storage, history: { provider: 'none' } });
    await assert.rejects(openStore({ path }), ValidationFailedError);
    const client = await openStore({ path, storage, history: { provider: 'none' } });
    const created = await client.create({
      namespace: 'demo',
      kind: 'note',
      content: 'custom plugin',
    });
    await client.close();
    const get = runCli([
      'get',
      created.memory.id,
      '--store',
      path,
      '--storage-plugin',
      module,
      '--storage-options',
      '{"expected":true}',
      '--history',
      'none',
      '--json',
    ]);
    assert.equal(get.status, 0, get.stderr);
    assert.match(get.stdout, /custom plugin/);
    const tokens = await openTokenStore({ path, storage });
    assert.equal((await tokens.list()).length, 0);
    await tokens.close();
  });
});
