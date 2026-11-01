import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  initStore,
  openStore,
  openTokenStore,
  exportStore,
  importStore,
  type StorageConfig,
} from '../src/sdk/index.ts';
import { canonicalJson, sha256Hex, ValidationFailedError } from '../src/model/index.ts';
import { importClaudeMem } from '../src/workflow/import.ts';
import { capture, accept, context } from '../src/workflow/index.ts';
import { runCli, tempDir } from './helpers.ts';
import { GitHistory } from '../src/history-git/index.ts';

const backends: StorageConfig[] = [{ provider: 'sqlite' }, { provider: 'markdown' }];
if (process.env.MEMORYKIT_TEST_POSTGRES_URL)
  backends.push({
    provider: 'plugin',
    module: fileURLToPath(new URL('../src/storage-postgres/index.ts', import.meta.url)),
    options: { connectionStringEnv: 'MEMORYKIT_TEST_POSTGRES_URL', storeId: randomUUID() },
  });

for (const source of backends)
  for (const destination of backends) {
    it(`migrates ${source.provider} to ${destination.provider}: identity, review, lifecycle and Git`, async () => {
      const storage = (s: StorageConfig): StorageConfig =>
        s.provider === 'plugin' ? { ...s, options: { ...s.options, storeId: randomUUID() } } : s;
      const from = { path: join(tempDir(), 'source'), storage: storage(source) };
      await initStore(from);
      const c = await openStore(from);
      const captured = await capture(c, {
        namespace: 'project/demo',
        source: {
          host: 'generic',
          sessionId: 'synthetic',
          eventId: 'event',
          ref: 'synthetic://event',
        },
        observations: [{ id: 'user-1', role: 'user', content: 'Cobalt code is 42.' }],
      });
      const candidate = captured.items[0]!.outcome.memory;
      const accepted = await accept(c, candidate.id, 1);
      const corrected = await c.update({
        id: accepted.memory.id,
        expectedRevision: 2,
        content: 'Cobalt code is 43.',
      });
      const archived = await c.create({
        namespace: 'project/demo',
        kind: 'note',
        content: 'old plan',
      });
      await c.archive({ id: archived.memory.id, expectedRevision: 1 });
      await c.setNamespacePolicy('team/private', 'metadata');
      await c.syncHistory({ budgetMs: 10000 });
      const before = await c.get(candidate.id);
      const history = await c.history(candidate.id);
      await c.close();
      const tokens = await openTokenStore(from);
      const secret = await tokens.issue('source-only', [{ pattern: '*', permissions: ['read'] }]);
      await tokens.close();
      const archive = await exportStore(from);
      assert.ok(archive.git);
      assert.doesNotMatch(JSON.stringify(archive), new RegExp(secret.secret));
      const to = { path: join(tempDir(), 'destination'), storage: storage(destination) };
      await importStore(to, archive);
      const restored = await openStore(to);
      assert.deepEqual(await restored.get(candidate.id), before);
      assert.deepEqual(await restored.history(candidate.id), history);
      assert.equal((await restored.get(archived.memory.id)).state, 'archived');
      assert.equal((await restored.getNamespace('team/private')).historyPolicy, 'metadata');
      assert.equal((await restored.revision(candidate.id, 1)).record.revision, 1);
      await restored.update({
        id: candidate.id,
        expectedRevision: corrected.memory.revision,
        content: 'Cobalt code is 44.',
      });
      await restored.syncHistory({ budgetMs: 10000 });
      assert.equal((await restored.history(candidate.id)).length, history.length + 1);
      await restored.close();
      const newTokens = await openTokenStore(to);
      assert.equal(await newTokens.verify(secret.secret), null);
      await newTokens.close();
      await assert.rejects(importStore(to, archive), ValidationFailedError);
    });
  }

it('refuses tampering and invalid bundles before exposing a destination; supports empty stores', async () => {
  const from = { path: join(tempDir(), 'empty') };
  await initStore(from);
  const archive = await exportStore(from);
  assert.equal(archive.git, null);
  const target = join(tempDir(), 'new');
  await assert.rejects(
    importStore({ path: target }, { ...archive, checksum: 'bad' }),
    ValidationFailedError
  );
  assert.equal(existsSync(target), false);
  const broken = {
    ...archive,
    git: { head: 'a'.repeat(40), bundle: Buffer.from('not a bundle').toString('base64') },
  };
  // Recompute with checksum excluded, as a malicious archive producer could.
  const { checksum: ignored, ...body } = broken;
  void ignored;
  await assert.rejects(
    importStore({ path: target }, { ...broken, checksum: sha256Hex(canonicalJson(body)) }),
    ValidationFailedError
  );
  assert.equal(existsSync(target), false);
  await importStore({ path: target, storage: { provider: 'markdown' } }, archive);
  assert.deepEqual((await exportStore({ path: target })).snapshot, archive.snapshot);
});

it('CLI exports exclusively and imports into a new backend', async () => {
  const from = join(tempDir(), 'source'),
    to = join(tempDir(), 'target'),
    file = join(tempDir(), 'portable.json');
  await initStore({ path: from, history: { provider: 'none' } });
  assert.equal(runCli(['export-store', file, '--store', from, '--history', 'none']).status, 0);
  const bytes = readFileSync(file, 'utf8');
  assert.notEqual(runCli(['export-store', file, '--store', from, '--history', 'none']).status, 0);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.equal(runCli(['import-store', file, '--store', to, '--storage', 'markdown']).status, 0);
  writeFileSync(file, '{}');
  assert.notEqual(runCli(['import-store', file, '--store', join(tempDir(), 'bad')]).status, 0);
});

it('imports the upstream serializer fixture, reviews sources, then migrates with provenance intact', async () => {
  const data = JSON.parse(
    readFileSync(new URL('./fixtures/claude-mem-upstream-export.json', import.meta.url), 'utf8')
  );
  const from = { path: join(tempDir(), 'upstream') };
  await initStore(from);
  const c = await openStore(from);
  const options = {
    sourceId: 'synthetic-upstream',
    projectNamespaces: { 'synthetic-alpha': 'project/synthetic-alpha' },
  };
  const imported = await importClaudeMem(c, data, options);
  assert.equal(imported.completeness, 'complete');
  assert.equal(imported.items.length, 3);
  assert.equal(
    (await context(c, { namespace: 'project/synthetic-alpha', text: 'synthetic' })).items.length,
    0
  );
  const source = imported.items
    .map((i) => i.outcome.memory)
    .find((r) => r.metadata.sourceRole === 'user')!;
  assert.deepEqual(JSON.parse(source.content), data.prompts[0]);
  assert.match(source.provenance.evidence[0]!.ref, /claude-mem:synthetic-upstream/);
  const accepted = await accept(c, source.id, 1);
  const again = await importClaudeMem(c, data, options);
  assert.equal(
    again.items.find((i) => i.outcome.memory.id === source.id)!.outcome.memory.id,
    source.id
  );
  await c.syncHistory({ budgetMs: 10000 });
  await c.close();
  const archive = await exportStore(from);
  const to = { path: join(tempDir(), 'markdown'), storage: { provider: 'markdown' as const } };
  await importStore(to, archive);
  const restored = await openStore(to);
  try {
    assert.deepEqual(await restored.get(source.id), accepted.memory);
    const rows = (await restored.search({})).items;
    assert.equal(rows.filter((r) => r.metadata.status === 'candidate').length, 2);
    assert.equal(rows.filter((r) => r.metadata.status === 'accepted').length, 1);
    assert.equal(
      (await context(restored, { namespace: 'project/synthetic-alpha', text: 'synthetic source' }))
        .items.length,
      1
    );
  } finally {
    await restored.close();
  }
});

it('preserves supersession, tombstone restoration and purge history across backend migration', async () => {
  const from = { path: join(tempDir(), 'lifecycle') };
  await initStore(from);
  const c = await openStore(from);
  const old = (
    await c.create({
      namespace: 'demo',
      kind: 'note',
      content: 'Old fact',
      metadata: { status: 'accepted' },
    })
  ).memory;
  const replacement = await c.supersede({
    id: old.id,
    expectedRevision: 1,
    replacement: { kind: 'note', content: 'Corrected fact', metadata: { status: 'accepted' } },
  });
  await c.tombstone({ id: replacement.memory.id, expectedRevision: 1 });
  const purged = (
    await c.create({ namespace: 'demo', kind: 'note', content: 'Purge current state' })
  ).memory;
  await c.purge({ id: purged.id, expectedRevision: 1 });
  await c.syncHistory({ budgetMs: 10000 });
  const before = await c.get(old.id),
    dead = await c.get(replacement.memory.id);
  await c.close();
  const retained = new GitHistory({ repository: join(from.path, 'history.git') });
  await retained.open();
  const history = await retained.list(purged.id, purged.namespace);
  await retained.close();
  assert.equal(history.length, 2);
  const archive = await exportStore(from);
  assert.equal(
    archive.snapshot.records.some((r) => r.id === purged.id),
    false
  );
  const to = {
    path: join(tempDir(), 'restored-lifecycle'),
    storage: { provider: 'markdown' as const },
  };
  await importStore(to, archive);
  const restored = await openStore(to);
  try {
    assert.deepEqual(await restored.get(old.id), before);
    assert.deepEqual(await restored.get(dead.id), dead);
    const migratedHistory = new GitHistory({ repository: join(to.path, 'history.git') });
    await migratedHistory.open();
    assert.deepEqual(await migratedHistory.list(purged.id, purged.namespace), history);
    await migratedHistory.close();
    await assert.rejects(restored.get(purged.id), /not found/i);
    const revived = await restored.restore({ id: dead.id, expectedRevision: dead.revision });
    assert.equal(revived.memory.state, 'active');
    assert.equal(revived.memory.revision, dead.revision + 1);
  } finally {
    await restored.close();
  }
});

it('rejects malformed history anchors and lifecycle before creating a destination', async () => {
  const from = { path: join(tempDir(), 'invalid-anchor') };
  await initStore(from);
  const c = await openStore(from);
  await c.create({ namespace: 'demo', kind: 'note', content: 'Fact' });
  await c.syncHistory({ budgetMs: 10000 });
  await c.close();
  const original = await exportStore(from);
  for (const mutate of [
    (a: typeof original) => {
      a.snapshot.anchor!.entry.payload = {} as never;
    },
    (a: typeof original) => {
      a.snapshot.records[0]!.priorState = 'active';
    },
    (a: typeof original) => {
      a.snapshot.namespaces = [];
    },
  ]) {
    const modified = structuredClone(original);
    mutate(modified);
    const { checksum: ignored, ...body } = modified;
    void ignored;
    modified.checksum = sha256Hex(canonicalJson(body));
    const target = join(tempDir(), 'invalid');
    await assert.rejects(importStore({ path: target }, modified), ValidationFailedError);
    assert.equal(existsSync(target), false);
  }
});
