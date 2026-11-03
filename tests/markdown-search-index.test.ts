import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { initStore, openStore } from '../src/sdk/index.ts';
import { reviewMemory } from '../src/workflow/review.ts';
import { tempDir } from './helpers.ts';

it('reads only indexed candidate files and still verifies their authoritative hashes', async () => {
  const path = tempDir();
  const config = { path, storage: { provider: 'markdown' as const, searchIndex: true }, history: { provider: 'none' as const } };
  await initStore(config);
  const client = await openStore(config);
  try {
    const wanted = (await client.create({ namespace: 'project/a', kind: 'note', content: 'Bicycles in the attic.' })).memory;
    const unrelated = (await client.create({ namespace: 'project/a', kind: 'note', content: 'Umbrellas in the cellar.' })).memory;
    const find = (text: string) => client.retrieve({ namespaces: ['project/a'], text });
    assert.equal((await find('bicycle')).items[0]!.id, wanted.id);
    const state = JSON.parse(readFileSync(join(path, 'markdown', 'state.json'), 'utf8'));
    const file = join(path, 'markdown', 'records', state.files[unrelated.id]);
    const original = readFileSync(file, 'utf8');
    try {
      writeFileSync(file, 'tampered authoritative record');
      assert.equal((await find('bicycle')).items[0]!.id, wanted.id);
      await assert.rejects(find('umbrella'), /corrupt or was edited/);
    } finally { writeFileSync(file, original); }
  } finally { await client.close(); }
});

it('rebuilds the optional Markdown index and invalidates it on writes from either configuration', async () => {
  const path = tempDir(), storage = { provider: 'markdown' as const, searchIndex: true };
  const config = { path, storage, history: { provider: 'none' as const } };
  await initStore(config);
  let c = await openStore(config);
  const file = join(path, 'markdown', 'search.sqlite');
  try {
    const original = (await c.create({ namespace: 'project/a', kind: 'note', content: 'Bicycles are stored in the attic.', metadata: { status: 'accepted', nested: { tag: 'WHEELS' } } })).memory;
    await c.create({ namespace: 'project/ab', kind: 'note', content: 'Bicycles PRIVATE_FOREIGN', metadata: { status: 'accepted' } });
    const find = () => c.retrieve({ namespaces: ['project/a/*'], text: 'bicycle', limit: 1 });
    assert.deepEqual((await find()).items.map((r) => r.id), [original.id]);
    assert.ok(existsSync(file));
    assert.equal((await c.search({ namespaces: ['project/a'], text: 'wheels' })).items.length, 1);
    const corrected = await reviewMemory(c, { namespace: 'project/a', action: 'correct', id: original.id, expectedRevision: 1, content: 'Bicycles are stored in the garage.' });
    assert.deepEqual((await find()).items.map((r) => r.id), [corrected.memory.id]);
    assert.deepEqual((await c.get(original.id)).links, []);
    assert.equal((await c.retrieve({ namespaces: ['project/a'], text: 'attic', states: ['superseded'] })).items[0]!.supersededBy.ids[0], corrected.memory.id);
    await c.close();
    c = await openStore({ ...config, storage: { provider: 'markdown' } });
    await c.update({ id: corrected.memory.id, expectedRevision: 1, content: 'Bicycles are stored in the cellar.' });
    assert.equal(existsSync(file), false);
    await c.close();
    c = await openStore(config);
    assert.equal((await find()).items[0]!.excerpt.text.includes('cellar'), true);
    rmSync(file);
    assert.equal((await find()).items[0]!.id, corrected.memory.id);
    writeFileSync(file, 'corrupt derived database');
    assert.equal((await find()).items[0]!.id, corrected.memory.id);
    await c.purge({ id: corrected.memory.id, expectedRevision: 2 });
    assert.equal(existsSync(file), false);
    assert.doesNotMatch(readFileSync(join(path, 'markdown', 'state.json'), 'utf8'), /cellar/);
    assert.equal((await find()).items.length, 0);
  } finally { await c.close(); }
});
