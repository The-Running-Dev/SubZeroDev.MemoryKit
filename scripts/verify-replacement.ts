// Offline acceptance against an installed package and the pinned synthetic upstream export.
// Never opens a real claude-mem database or changes host configuration.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { package: { type: 'string' }, report: { type: 'string' } },
});
assert.ok(values.package, 'Supply --package /installed/node_modules/subzerodev-memorykit');
const api: typeof import('../src/index.ts') = await import(
  pathToFileURL(join(resolve(values.package), 'dist/index.js')).href
);
const fixture = JSON.parse(
  readFileSync(
    new URL('../tests/fixtures/claude-mem-upstream-export.json', import.meta.url),
    'utf8'
  )
);
const work = mkdtempSync(join(tmpdir(), 'memorykit-replacement-'));
const checks: string[] = [];
const namespace = 'project/synthetic/alpha';
const options = {
  sourceId: 'pinned-synthetic-export',
  projectNamespaces: { 'synthetic-alpha': namespace },
};
try {
  const source = { path: join(work, 'sqlite') };
  await api.initStore(source);
  let client = await api.openStore(source);
  let selected;
  let original;
  let retainedHistory;
  try {
    assert.equal((await api.reconcileClaudeMem(client, fixture, options)).ready, false);
    const imported = await api.importClaudeMem(client, fixture, options);
    assert.equal(imported.items.length, 3);
    assert.equal(imported.failures.length, 0);
    assert.equal((await api.reconcileClaudeMem(client, fixture, options)).ready, true);
    checks.push('pinned upstream export: plan, import and exact source coverage');
    const queue = await api.reviewQueue(client, { namespace });
    assert.equal(queue.items.length, 3);
    original = queue.items.find((item) => item.memory.kind === 'observation')!.memory;
    assert.equal(original.metadata.sourceRole, 'assistant');
    const prompt = queue.items.find((item) => item.memory.kind === 'source')!.memory;
    assert.equal(prompt.metadata.sourceRole, 'user');
    for (const { memory } of queue.items) {
      await api.reviewMemory(client, {
        namespace,
        id: memory.id,
        expectedRevision: memory.revision,
        action: memory.kind === 'handoff' ? 'reject' : 'accept',
      });
    }
    const accepted = await client.get(original.id);
    selected = (
      await api.reviewMemory(client, {
        namespace,
        id: original.id,
        expectedRevision: accepted.revision,
        action: 'correct',
        content: 'The Cobalt deployment code is SYNTHETIC-43.',
      })
    ).memory;
    assert.deepEqual(selected.provenance, original.provenance);
    assert.equal((await client.get(original.id)).state, 'superseded');
    const recall = await api.context(client, { namespace, text: 'Cobalt deployment code' });
    assert.match(recall.text, /SYNTHETIC-43/);
    assert.doesNotMatch(recall.text, /SYNTHETIC-42/);
    assert.equal((await api.reviewQueue(client, { namespace })).items.length, 0);
    checks.push('attributed review, reject, atomic correction and current-only recall');
    assert.equal((await api.reconcileClaudeMem(client, fixture, options)).ready, true);
    const changed = structuredClone(fixture);
    changed.observations[0].narrative = 'The source changed after export.';
    assert.equal((await api.reconcileClaudeMem(client, changed, options)).ready, false);
    assert.deepEqual(await client.get(selected.id), selected);
    checks.push('changed-source reconciliation is read-only and preserves the correction');
    const historyQueue = await client.syncHistory({ budgetMs: 30000 });
    assert.deepEqual(historyQueue, { pending: 0, blocked: null, lastError: null },
      'Synthetic migration history must be completely exported before measuring retained revisions');
    retainedHistory = await client.history(original.id);
    assert.ok(retainedHistory.length >= 3);
  } finally {
    await client.close();
  }
  const archive = await api.exportStore(source);
  assert.ok(archive.git);
  const markdown = { path: join(work, 'markdown'), storage: { provider: 'markdown' as const } };
  await api.importStore(markdown, archive);
  client = await api.openStore(markdown);
  try {
    assert.deepEqual(await client.get(selected!.id), selected);
    assert.deepEqual(await client.history(original!.id), retainedHistory);
    assert.equal((await api.reconcileClaudeMem(client, fixture, options)).ready, true);
  } finally {
    await client.close();
  }
  checks.push('SQLite to Markdown: identity, review, source coverage and retained Git revisions');
  const rollbackArchive = await api.exportStore(markdown);
  const rollback = { path: join(work, 'rollback') };
  await api.importStore(rollback, rollbackArchive);
  client = await api.openStore(rollback);
  try {
    assert.deepEqual(await client.get(selected!.id), selected);
    assert.deepEqual(await client.history(original!.id), retainedHistory);
  } finally {
    await client.close();
  }
  checks.push(
    'rollback into a fresh SQLite store preserves the reviewed correction and Git history'
  );
  const report = {
    version: 1,
    installedPackage: true,
    fixture: 'claude-mem-upstream-export.json',
    upstreamCommit: 'b80b29bc49d08a71312f44b8feacb2e7585edff4',
    checks,
    limitations:
      'Synthetic upstream serializer fixture only. Source coverage is not acceptance or retrieval quality. No live claude-mem data/settings changed; rollback restores MemoryKit, not the upstream database. Credentials and operation replay are excluded from archives.',
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.report) writeFileSync(resolve(values.report), json);
  process.stdout.write(json);
} finally {
  rmSync(work, { recursive: true, force: true });
}
