import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CachedRecallSelector } from '../src/workflow/recall-cache.ts';
import { SqliteRecallCache } from '../src/index-sqlite/index.ts';
import { sha256Hex } from '../src/model/index.ts';
import { context, type RecallRequest, type RecallSelector } from '../src/workflow/index.ts';
import { initStore, openStore } from '../src/sdk/index.ts';
import { runCli, tempDir } from './helpers.ts';

it('persistent recall cache keys every request field, isolates buckets and bounds retention', async () => {
  const path = join(tempDir(), 'cache.sqlite');
  let calls = 0;
  const provider: RecallSelector = {
    id: 'provider',
    expand: async () => {
      calls++;
      return ['port'];
    },
    select: async (r) => {
      calls++;
      return [
        { id: r.passages[0]!.id, revision: r.passages[0]!.revision, quote: r.passages[0]!.content },
      ];
    },
    verify: async (_r, s) => {
      calls++;
      return s;
    },
  };
  const request: RecallRequest = {
    query: 'port',
    limit: 1,
    passages: [
      { id: 'one', revision: 1, namespace: 'project/a', content: 'port 8080', truncated: false },
    ],
  };
  let cache = new SqliteRecallCache(path, sha256Hex('a'));
  let selector = new CachedRecallSelector(provider, cache);
  await selector.expand!('port');
  const selected = await selector.select(request);
  await selector.verify!(request, selected);
  cache.close();
  cache = new SqliteRecallCache(path, sha256Hex('a'));
  selector = new CachedRecallSelector(provider, cache);
  await selector.expand!('port');
  const reused = await selector.select(request);
  reused[0]!.quote = 'mutated';
  assert.deepEqual(await selector.select(request), selected);
  await selector.verify!(request, selected);
  assert.equal(calls, 3);
  for (const changed of [
    { ...request, query: 'different' },
    { ...request, limit: 2 },
    { ...request, passages: [{ ...request.passages[0]!, revision: 2 }] },
    { ...request, passages: [{ ...request.passages[0]!, namespace: 'project/b' }] },
    { ...request, passages: [{ ...request.passages[0]!, content: 'port 9000' }] },
  ])
    await selector.select(changed);
  assert.equal(calls, 8);
  const other = new SqliteRecallCache(path, sha256Hex('b'));
  assert.equal(await other.get(sha256Hex('key')), null);
  for (let i = 0; i < 70; i++) await cache.put(sha256Hex(String(i)), [i]);
  const db = new DatabaseSync(path);
  assert.equal(db.prepare('SELECT count(*) AS n FROM recall_cache').get()!.n, 64);
  db.prepare('UPDATE recall_cache SET expires=0').run();
  assert.equal(await cache.get(sha256Hex('69')), null);
  await other.put(sha256Hex('other'), ['retained']);
  await cache.clear();
  assert.deepEqual(await other.get(sha256Hex('other')), ['retained']);
  db.close();
  other.close();
  cache.close();
});

it('cached selection cannot revive corrected, rejected or purged memories', async () => {
  const path = tempDir();
  const config = { path, history: { provider: 'none' as const } };
  await initStore(config);
  const client = await openStore(config);
  const cache = new SqliteRecallCache(join(tempDir(), 'cache.sqlite'), sha256Hex('scope'));
  let calls = 0;
  const selector = new CachedRecallSelector(
    {
      id: 'test',
      select: async (r) => {
        calls++;
        return r.passages.map((p) => ({ id: p.id, revision: p.revision, quote: p.content }));
      },
    },
    cache
  );
  try {
    const created = await client.create({
      namespace: 'project/a',
      kind: 'note',
      content: 'port 8080',
      metadata: { status: 'accepted' },
    });
    const input = { namespace: 'project/a', text: 'port' };
    assert.equal((await context(client, input, undefined, selector)).items.length, 1);
    assert.equal((await context(client, input, undefined, selector)).items.length, 1);
    assert.equal(calls, 1);
    const corrected = await client.supersede({
      id: created.memory.id,
      expectedRevision: 1,
      replacement: { kind: 'note', content: 'port 9000', metadata: { status: 'accepted' } },
    });
    const current = await context(client, input, undefined, selector);
    assert.equal(current.items[0]!.id, corrected.memory.id);
    assert.ok(!current.text.includes('8080'));
    await client.update({
      id: corrected.memory.id,
      expectedRevision: 1,
      metadata: { status: 'rejected' },
    });
    assert.equal((await context(client, input, undefined, selector)).items.length, 0);
    await client.purge({ id: corrected.memory.id, expectedRevision: 2 });
    assert.equal((await context(client, input, undefined, selector)).items.length, 0);
    assert.equal(
      (await context(client, { namespace: 'project/b', text: 'port' }, undefined, selector)).items
        .length,
      0
    );
  } finally {
    cache.close();
    await client.close();
  }
});

it('provider failures are retried on the next request rather than cached', async () => {
  const cache = new SqliteRecallCache(join(tempDir(), 'cache.sqlite'), sha256Hex('fail'));
  let calls = 0;
  const selector = new CachedRecallSelector(
    {
      id: 'fail',
      select: async () => {
        calls++;
        throw new Error('offline');
      },
    },
    cache
  );
  try {
    for (let i = 0; i < 2; i++)
      await assert.rejects(selector.select({ query: 'q', limit: 1, passages: [] }), /offline/);
    assert.equal(calls, 2);
  } finally {
    cache.close();
  }
});

it('CLI recall cache persists calls across processes and clears only the selected profile bucket', async () => {
  const dir = tempDir();
  const store = join(dir, 'store');
  const config = { path: store, history: { provider: 'none' as const } };
  await initStore(config);
  const client = await openStore(config);
  try {
    await client.create({
      namespace: 'project/a',
      kind: 'note',
      content: 'The bicycle is in the attic.',
      metadata: { status: 'accepted' },
    });
  } finally {
    await client.close();
  }
  const counter = join(dir, 'calls.txt');
  const adapter = join(dir, 'selector.mjs');
  writeFileSync(
    adapter,
    `import {appendFileSync} from 'node:fs';
    let raw='';for await(const chunk of process.stdin) raw+=chunk;
    const r=JSON.parse(raw);appendFileSync(process.argv[2],r.task+'\\n');
    const selected=(r.passages??[]).filter(p=>p.content.includes('bicycle')).map(p=>({id:p.id,revision:p.revision,quote:p.content}));
    process.stdout.write(JSON.stringify(r.task==='expand'?{queries:['bicycle']}:{selections:r.task==='verify'?r.selections:selected}));`
  );
  const profile = join(dir, 'profile.json');
  const settings = {
    version: 1,
    store,
    namespace: 'project/a',
    history: 'none',
    recall: {
      id: 'test-v1',
      discovery: true,
      verification: true,
      cache: join(dir, 'cache.sqlite'),
      command: { command: process.execPath, args: [adapter, counter] },
    },
  };
  writeFileSync(profile, JSON.stringify(settings));
  const run = (args: string[]) => {
    const r = runCli([...args, '--profile', profile]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const first = run(['context', '--text', 'Where is my cycling equipment?']);
  assert.equal(first.items.length, 1);
  assert.deepEqual(run(['context', '--text', 'Where is my cycling equipment?']), first);
  assert.equal(readFileSync(counter, 'utf8').trim().split('\n').length, 3);
  settings.recall.id = 'test-v2';
  writeFileSync(profile, JSON.stringify(settings));
  run(['context', '--text', 'Where is my cycling equipment?']);
  const db = new DatabaseSync(settings.recall.cache);
  assert.equal(db.prepare('SELECT count(DISTINCT bucket) AS n FROM recall_cache').get()!.n, 2);
  assert.deepEqual(run(['recall-cache-clear']), { cleared: true });
  assert.equal(db.prepare('SELECT count(DISTINCT bucket) AS n FROM recall_cache').get()!.n, 1);
  db.close();
  run(['context', '--text', 'Where is my cycling equipment?']);
  assert.equal(readFileSync(counter, 'utf8').trim().split('\n').length, 9);
});
