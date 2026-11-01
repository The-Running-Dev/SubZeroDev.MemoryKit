import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, it } from 'node:test';
import { installHooks, installationPaths, inspectInstallation } from '../src/hosts/installation.ts';
import { initStore, openStore } from '../src/sdk/index.ts';
import { capture, context, type EmbeddingProvider } from '../src/workflow/index.ts';
import { reviewMemory, reviewQueue } from '../src/workflow/review.ts';
import { importClaudeMem, reconcileClaudeMem } from '../src/workflow/import.ts';
import { SqliteEmbeddingIndex } from '../src/index-sqlite/index.ts';
import { RevisionConflictError, sha256Hex } from '../src/model/index.ts';
import { runCli, tempDir } from './helpers.ts';

const ns = 'project/test';
const group = (command: string) => ({
  UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }],
});
it('managed hooks preserve other settings through install, upgrade and removal', () => {
  const dir = tempDir(),
    settings = join(dir, 'settings.json');
  const paths = installationPaths(join(dir, 'profile.json'), 'codex', settings);
  const other = group('user-hook');
  writeFileSync(settings, JSON.stringify({ theme: 'dark', hooks: other }));
  installHooks(paths, group('memorykit-v1'));
  assert.equal(inspectInstallation(paths).configured, true);
  assert.deepEqual(
    (installHooks(paths, group('memorykit-v1')) as { changed: boolean }).changed,
    false
  );
  installHooks(paths, group('memorykit-v2'));
  const config = JSON.parse(readFileSync(settings, 'utf8'));
  config.hooks.Stop = [{ hooks: [{ command: 'added-later' }] }];
  writeFileSync(settings, JSON.stringify(config));
  installHooks(paths, {}, true);
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), {
    theme: 'dark',
    hooks: { ...other, Stop: config.hooks.Stop },
  });
  assert.equal(inspectInstallation(paths).configured, false);
  assert.equal((installHooks(paths, {}, true) as { changed: boolean }).changed, false);
});
it('changed, unowned and conflicting hook files fail before mutation', () => {
  const dir = tempDir(),
    settings = join(dir, 'settings.json');
  const paths = installationPaths(join(dir, 'profile'), 'claude-code', settings);
  assert.throws(() => installationPaths(settings, 'codex', settings), /different files/);
  writeFileSync(settings, JSON.stringify({ hooks: group('mine') }));
  assert.throws(() => installHooks(paths, group('mine')), /unowned/);
  installHooks(paths, group('ours'));
  const changed = readFileSync(settings, 'utf8').replace('ours', 'edited');
  writeFileSync(settings, changed);
  assert.throws(() => installHooks(paths, {}, true), /changed or are missing/);
  assert.equal(readFileSync(settings, 'utf8'), changed);
  writeFileSync(settings + '.memorykit.lock', '');
  assert.throws(() => installHooks(paths, {}), /Another installation/);
});
it('failed manifest persistence restores the settings without claiming ownership', () => {
  const dir = tempDir(),
    settings = join(dir, 'settings.json'),
    blocked = join(dir, 'blocked');
  writeFileSync(settings, JSON.stringify({ theme: 'dark', hooks: group('user-hook') }));
  writeFileSync(blocked, 'file instead of directory');
  const before = JSON.parse(readFileSync(settings, 'utf8'));
  const paths = installationPaths(
    join(dir, 'profile'),
    'codex',
    settings,
    join(blocked, 'manifest')
  );
  assert.throws(() => installHooks(paths, group('ours')), /manifest failed/);
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), before);
});

for (const storage of ['sqlite', 'markdown'] as const) {
  it(`managed ${storage} CLI installation probes the real generated command in both hosts`, () => {
    const dir = tempDir(),
      output = join(dir, 'config with spaces');
    const cli = (...args: string[]) => {
      const r = runCli(args);
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    cli(
      'setup',
      '--store',
      join(dir, 'store'),
      '--storage',
      storage,
      '--history',
      'none',
      '--output',
      output,
      '--namespace',
      ns
    );
    const profile = join(output, 'memorykit.profile.json');
    for (const host of ['claude-code', 'codex']) {
      const settings = join(dir, host + '.json');
      const flags = ['--profile', profile, '--host', host, '--settings', settings];
      assert.equal(cli('install', ...flags).installed, true);
      const doctor = cli('doctor', ...flags, '--probe');
      assert.equal(doctor.ok, true);
      assert.equal(doctor.installation.executionProbe, true);
      assert.equal(doctor.installation.lastInvocation, null);
      assert.equal(cli('uninstall', ...flags).installed, false);
      assert.equal(runCli(['doctor', ...flags]).status, 1);
    }
  });
  it(`${storage} review preserves attribution and uses revisions for accept, reject and correction`, async () => {
    const config = {
      path: tempDir(),
      storage: { provider: storage },
      history: { provider: 'none' as const },
    };
    await initStore(config);
    const client = await openStore(config);
    after(() => client.close());
    await capture(client, {
      namespace: ns,
      source: { host: 'any', sessionId: 'one', eventId: 'one', ref: 'test:user' },
      observations: [
        { id: 'user', role: 'user', content: 'Use port 8080.' },
        { id: 'model', role: 'assistant', generated: true, content: 'Use SQLite.' },
      ],
    });
    const queue = await reviewQueue(client, { namespace: ns });
    const user = queue.items.find((i) => i.memory.metadata.sourceRole === 'user')!.memory;
    const model = queue.items.find((i) => i.memory.metadata.sourceRole === 'assistant')!.memory;
    assert.equal(model.metadata.statement, 'generated');
    assert.deepEqual(user.provenance.evidence, [{ ref: 'test:user' }]);
    await reviewMemory(client, {
      namespace: ns,
      id: user.id,
      expectedRevision: 1,
      action: 'accept',
    });
    await assert.rejects(
      reviewMemory(client, {
        namespace: ns,
        id: user.id,
        expectedRevision: 1,
        action: 'correct',
        content: 'Use port 9000.',
      }),
      RevisionConflictError
    );
    const corrected = await reviewMemory(client, {
      namespace: ns,
      id: user.id,
      expectedRevision: 2,
      action: 'correct',
      content: 'Use port 9000.',
    });
    assert.equal(corrected.memory.metadata.statement, 'curated');
    assert.equal(corrected.memory.metadata.correctionSource, 'reviewer');
    assert.deepEqual(corrected.memory.provenance.evidence, user.provenance.evidence);
    await reviewMemory(client, {
      namespace: ns,
      id: model.id,
      expectedRevision: 1,
      action: 'reject',
    });
    const result = await context(client, { namespace: ns });
    assert.deepEqual(
      result.items.map((i) => i.id),
      [corrected.memory.id]
    );
    assert.equal((await reviewQueue(client, { namespace: ns })).items.length, 0);
    await assert.rejects(
      reviewMemory(client, {
        namespace: 'other',
        id: corrected.memory.id,
        expectedRevision: 1,
        action: 'accept',
      })
    );
  });
}
it('duplicate suggestions require accepted identical text in the same namespace', async () => {
  const config = { path: tempDir(), history: { provider: 'none' as const } };
  await initStore(config);
  const client = await openStore(config);
  after(() => client.close());
  const add = async (namespace: string, content: string, status = 'candidate') =>
    (await client.create({ namespace, kind: 'note', content, metadata: { status } })).memory;
  const target = await add(ns, 'Use SQLite.', 'accepted'),
    candidate = await add(ns, ' Use  SQLite. ');
  const foreign = await add('other', candidate.content, 'accepted');
  const queue = await reviewQueue(client, { namespace: ns });
  assert.deepEqual(queue.items[0]!.duplicateIds, [target.id]);
  await assert.rejects(
    reviewMemory(client, {
      namespace: ns,
      id: candidate.id,
      expectedRevision: 1,
      action: 'duplicate',
      duplicateOf: foreign.id,
    })
  );
  await reviewMemory(client, {
    namespace: ns,
    id: candidate.id,
    expectedRevision: 1,
    action: 'duplicate',
    duplicateOf: target.id,
  });
  assert.equal((await client.get(candidate.id)).metadata.status, 'rejected');
  assert.equal((await client.get(target.id)).revision, 1);
});
it('persistent index reuses document embeddings across reopen and invalidates revisions and removals', async () => {
  const dir = tempDir(),
    config = { path: join(dir, 'store'), history: { provider: 'none' as const } };
  await initStore(config);
  const client = await openStore(config);
  after(() => client.close());
  const record = (
    await client.create({
      namespace: ns,
      kind: 'note',
      content: 'Bicycle in shed.',
      metadata: { status: 'accepted' },
    })
  ).memory;
  let documents = 0,
    queries = 0;
  const embedding: EmbeddingProvider = {
    id: 'test-v1',
    async embed(texts, purpose) {
      if (purpose === 'document') documents += texts.length;
      else queries++;
      return texts.map(() => [1, 0]);
    },
  };
  const file = join(dir, 'index.sqlite'),
    bucket = sha256Hex('store+scope+principal');
  let index = new SqliteEmbeddingIndex(file, bucket);
  const recall = () =>
    context(client, { namespace: ns, text: 'cycling gear' }, embedding, undefined, index);
  assert.equal((await recall()).items[0]!.id, record.id);
  index.close();
  index = new SqliteEmbeddingIndex(file, bucket);
  await recall();
  assert.equal(documents, 1);
  assert.equal(queries, 2);
  await client.update({ id: record.id, expectedRevision: 1, content: 'Bicycle in attic.' });
  assert.match((await recall()).text, /attic/);
  assert.equal(documents, 2);
  await client.purge({ id: record.id, expectedRevision: 2 });
  assert.equal((await recall()).items.length, 0);
  const db = new DatabaseSync(file);
  assert.equal(db.prepare('SELECT count(*) AS n FROM vectors').get()!.n, 0);
  db.close();
  await index.put([{ key: sha256Hex('probe'), vector: [1] }]);
  const other = new SqliteEmbeddingIndex(file, sha256Hex('other-principal'));
  assert.deepEqual(await other.get([sha256Hex('probe')]), [null]);
  other.close();
  await assert.rejects(index.put([{ key: sha256Hex('bad'), vector: [NaN] }]));
  index.close();
});
it('embedding recall drops a record revised during a provider call and does not prune an incomplete scan', async () => {
  const config = { path: tempDir(), history: { provider: 'none' as const } };
  await initStore(config);
  const client = await openStore(config);
  after(() => client.close());
  const record = (
    await client.create({
      namespace: ns,
      kind: 'note',
      content: 'Bicycle in shed.',
      metadata: { status: 'accepted' },
    })
  ).memory;
  let pruned = false;
  const embedding: EmbeddingProvider = {
    id: 'race-v1',
    async embed(texts, purpose) {
      if (purpose === 'document')
        await client.update({ id: record.id, expectedRevision: 1, content: 'Bicycle relocated.' });
      return texts.map(() => [1]);
    },
  };
  const partial = Object.create(client) as typeof client;
  partial.search = async (query) => ({ ...(await client.search(query)), completeness: 'partial' });
  const result = await context(
    partial,
    { namespace: ns, text: 'cycling gear' },
    embedding,
    undefined,
    {
      get: async (keys) => keys.map(() => null),
      put: async () => {},
      retain: async () => {
        pruned = true;
      },
    }
  );
  assert.equal(result.items.length, 0);
  assert.equal(result.completeness, 'partial');
  assert.equal(pruned, false);
});
it('source reconciliation reports changed, missing and reviewed rows without mutating them', async () => {
  const config = { path: tempDir(), history: { provider: 'none' as const } };
  await initStore(config);
  const client = await openStore(config);
  after(() => client.close());
  const data = {
    observations: [{ id: 1, project: 'a', text: 'Original source' }],
    prompts: [{ id: 2, project: 'a', text: 'User words' }],
  };
  const options = { sourceId: 'test-install', projectNamespaces: { a: ns } };
  assert.equal(
    (await reconcileClaudeMem(client, data, options)).rows.every((r) => r.status === 'missing'),
    true
  );
  await importClaudeMem(client, data, options);
  let audit = await reconcileClaudeMem(client, data, options);
  assert.equal(audit.ready, true);
  const original = audit.rows[0]!;
  await reviewMemory(client, {
    namespace: ns,
    id: original.id!,
    expectedRevision: 1,
    action: 'correct',
    content: 'Reviewer correction',
  });
  audit = await reconcileClaudeMem(client, data, options);
  assert.equal(audit.ready, true);
  assert.equal(audit.rows[0]!.state, 'superseded');
  const changed = structuredClone(data);
  changed.observations[0]!.text = 'Changed upstream';
  assert.equal((await reconcileClaudeMem(client, changed, options)).rows[0]!.status, 'changed');
  assert.equal((await client.get(original.id!)).revision, 2);
});
