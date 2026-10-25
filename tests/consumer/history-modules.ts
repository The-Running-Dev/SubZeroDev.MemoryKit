// Run separately for memory and none against the packed install. Register before importing
// the public entry so an eager Git re-export cannot escape the isolation check.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = process.argv[2];
assert.ok(provider === 'memory' || provider === 'none');
const urls: string[] = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    urls.push(result.url);
    return result;
  },
});

const { initStore, openStore } = await import('subzerodev-memorykit');
const dir = mkdtempSync(join(tmpdir(), 'memorykit-isolation-'));
try {
  const config = { path: dir, history: { provider } } as const;
  // init does not persist this default or a configuration file.
  await initStore({ ...config, defaultHistoryPolicy: 'none' });
  assert.deepEqual(readdirSync(dir), ['memory.db']);
  const client = await openStore(config);
  try {
    const created = await client.create({ namespace: 'demo', kind: 'note', content: 'first' });
    assert.equal(created.history, provider === 'memory' ? 'persisted' : 'not_required');
    assert.equal((await client.getNamespace('demo')).historyPolicy, 'full');
    await client.update({ id: created.memory.id, expectedRevision: 1, content: 'second' });
    assert.equal((await client.get(created.memory.id)).content, 'second');
    if (provider === 'memory') {
      assert.deepEqual(
        (await client.history(created.memory.id)).map((r) => r.revision),
        [1, 2]
      );
      const first = await client.revision(created.memory.id, 1);
      assert.ok('content' in first.record);
      assert.equal(first.record.content, 'first');
    }
  } finally {
    await client.close();
  }
  const configured = await openStore({
    ...config,
    defaultHistoryPolicy: 'metadata',
    service: { defaultHistoryPolicy: 'none' },
  });
  try {
    await configured.create({ namespace: 'configured', kind: 'note', content: 'metadata' });
    assert.equal((await configured.getNamespace('configured')).historyPolicy, 'metadata');
  } finally {
    await configured.close();
  }
  const reopened = await openStore(config);
  try {
    await reopened.create({ namespace: 'configured', kind: 'note', content: 'kept' });
    await reopened.create({ namespace: 'fresh', kind: 'note', content: 'full' });
    assert.equal((await reopened.getNamespace('configured')).historyPolicy, 'metadata');
    assert.equal((await reopened.getNamespace('fresh')).historyPolicy, 'full');
  } finally {
    await reopened.close();
  }
  assert.ok(urls.some((url) => /node_modules\/subzerodev-memorykit\/dist\/index\.js$/.test(url)));
  assert.deepEqual(
    urls.filter((url) => /history-git/.test(url)),
    []
  );
  console.log(`installed ${provider} public-entry isolation ok`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
