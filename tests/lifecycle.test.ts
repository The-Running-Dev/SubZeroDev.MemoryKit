import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { EMBEDDED_PRINCIPAL } from '../src/access/index.ts';
import type { MemoryKitError } from '../src/model/index.ts';
import { initStore, openStore } from '../src/sdk/index.ts';
import { tempDir } from './helpers.ts';

function git(repository: string, args: string[]): string {
  const result = spawnSync('git', ['--git-dir', repository, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function newStore(): Promise<{
  store: string;
  client: Awaited<ReturnType<typeof openStore>>;
}> {
  const store = tempDir();
  await initStore({ path: store });
  return { store, client: await openStore({ path: store }) };
}

function code(expected: string): (error: unknown) => boolean {
  return (error) => (error as MemoryKitError).code === expected;
}

describe('lifecycle', () => {
  it('S5.1 supersede creates the replacement and supersedes the target in one write', async () => {
    const { store, client } = await newStore();
    try {
      const a = (await client.create({ namespace: 'demo', kind: 'note', content: 'old' })).memory;
      const outcome = await client.supersede({
        id: a.id,
        expectedRevision: 1,
        replacement: { kind: 'note', content: 'new' },
      });
      const b = outcome.memory;
      assert.equal(b.namespace, 'demo');
      assert.equal(b.state, 'active');
      assert.equal(b.revision, 1);
      assert.deepEqual(b.links, [{ type: 'supersedes', target: a.id }]);
      assert.equal(outcome.history, 'persisted');
      assert.deepEqual(
        outcome.related.map((m) => [m.id, m.state, m.revision, m.supersededBy]),
        [[a.id, 'superseded', 2, [b.id]]]
      );

      const target = await client.get(a.id);
      assert.equal(target.state, 'superseded');
      assert.equal(target.revision, 2);
      assert.deepEqual(target.supersededBy, [b.id]);

      const repository = join(store, 'history.git');
      const log = git(repository, [
        'log',
        '--format=%s|%(trailers:key=MemoryKit-Operation,valueonly,separator=)',
        'main',
      ])
        .trim()
        .split('\n')
        .map((line) => line.trim());
      assert.deepEqual(log.slice(0, 2), [
        `supersede demo/${a.id} r2|${outcome.operationId}`,
        `supersede demo/${b.id} r1|${outcome.operationId}`,
      ]);
      const record = JSON.parse(git(repository, ['show', `main:demo/${a.id}/record.json`]));
      assert.deepEqual(record.supersededBy, [b.id]);
    } finally {
      await client.close();
    }
  });

  it('S5.2 a tombstone keeps the prior state, refuses a stale writer and restores', async () => {
    const { client } = await newStore();
    try {
      const a = (await client.create({ namespace: 'demo', kind: 'note', content: 'old' })).memory;
      await client.supersede({
        id: a.id,
        expectedRevision: 1,
        replacement: { kind: 'note', content: 'new' },
      });
      const tombstoned = (await client.tombstone({ id: a.id, expectedRevision: 2 })).memory;
      assert.equal(tombstoned.revision, 3);
      assert.equal(tombstoned.state, 'tombstoned');
      assert.equal(tombstoned.priorState, 'superseded');

      await assert.rejects(
        client.update({ id: a.id, expectedRevision: 2, content: 'stale' }),
        (error: unknown) =>
          code('RevisionConflict')(error) && (error as MemoryKitError).details.currentRevision === 3
      );

      const restored = (await client.restore({ id: a.id, expectedRevision: 3 })).memory;
      assert.equal(restored.revision, 4);
      assert.equal(restored.state, 'superseded');
      assert.equal(restored.priorState, null);
      assert.equal(restored.content, 'old');
    } finally {
      await client.close();
    }
  });

  it('S5.3 archiving a tombstoned memory is InvalidTransition and changes nothing', async () => {
    const { client } = await newStore();
    try {
      const a = (await client.create({ namespace: 'demo', kind: 'note', content: 'x' })).memory;
      await client.tombstone({ id: a.id, expectedRevision: 1 });
      await assert.rejects(
        client.archive({ id: a.id, expectedRevision: 2 }),
        code('InvalidTransition')
      );
      assert.equal((await client.get(a.id)).revision, 2);

      // archive and restore round-trip, and a provenance replaces the memory's
      await client.restore({ id: a.id, expectedRevision: 2 });
      const archived = await client.archive({
        id: a.id,
        expectedRevision: 3,
        provenance: { reason: 'stale', evidence: [] },
      });
      assert.equal(archived.memory.state, 'archived');
      assert.deepEqual(archived.memory.provenance, { reason: 'stale', evidence: [] });
      assert.equal(
        (await client.restore({ id: a.id, expectedRevision: 4 })).memory.state,
        'active'
      );
    } finally {
      await client.close();
    }
  });

  it('S5.4 history still lists every revision after a tombstone', async () => {
    const { client } = await newStore();
    try {
      const a = (await client.create({ namespace: 'demo', kind: 'note', content: 'x' })).memory;
      await client.update({ id: a.id, expectedRevision: 1, content: 'y' });
      await client.tombstone({ id: a.id, expectedRevision: 2 });
      const revisions = await client.history(a.id);
      assert.deepEqual(
        revisions.map((item) => [item.revision, item.operation]),
        [
          [1, 'create'],
          [2, 'update'],
          [3, 'tombstone'],
        ]
      );
      const snapshot = await client.revision(a.id, 3);
      assert.equal((snapshot.record as { state: string }).state, 'tombstoned');
    } finally {
      await client.close();
    }
  });

  it('tombstone and restoring a tombstone need the tombstone permission', async () => {
    const store = tempDir();
    await initStore({ path: store });
    const writer = await openStore(
      { path: store },
      {
        id: 'writer',
        profile: 'local',
        grants: [{ pattern: 'demo', permissions: ['read', 'write'] }],
      }
    );
    const owner = await openStore({ path: store }, EMBEDDED_PRINCIPAL);
    try {
      const a = (await writer.create({ namespace: 'demo', kind: 'note', content: 'x' })).memory;
      await assert.rejects(writer.tombstone({ id: a.id, expectedRevision: 1 }), code('Forbidden'));
      assert.equal((await writer.get(a.id)).revision, 1);
      await owner.tombstone({ id: a.id, expectedRevision: 1 });
      await assert.rejects(writer.restore({ id: a.id, expectedRevision: 2 }), code('Forbidden'));
      await owner.restore({ id: a.id, expectedRevision: 2 });
      await writer.archive({ id: a.id, expectedRevision: 3 });
      assert.equal(
        (await writer.restore({ id: a.id, expectedRevision: 4 })).memory.state,
        'active'
      );
    } finally {
      await writer.close();
      await owner.close();
    }
  });

  it('a supersede replays its outcome and validates the replacement', async () => {
    const { client } = await newStore();
    try {
      const a = (await client.create({ namespace: 'demo', kind: 'note', content: 'x' })).memory;
      const input = {
        id: a.id,
        expectedRevision: 1,
        replacement: {
          kind: 'note',
          content: 'y',
          links: [{ type: 'supersedes' as const, target: a.id }],
        },
      };
      const first = await client.supersede(input, { operationId: 'op-1' });
      const again = await client.supersede(input, { operationId: 'op-1' });
      assert.equal(again.memory.id, first.memory.id);
      assert.deepEqual(
        again.related.map((m) => m.id),
        [a.id]
      );
      assert.deepEqual(first.memory.links, [{ type: 'supersedes', target: a.id }]);

      await assert.rejects(
        client.supersede({ id: a.id, expectedRevision: 2, replacement: { kind: 'note' } as never }),
        (error: unknown) =>
          code('ValidationFailed')(error) && (error as MemoryKitError).details.field === 'content'
      );
      await assert.rejects(
        client.supersede({
          id: a.id,
          expectedRevision: 2,
          replacement: { kind: 'note', content: 'z' },
        }),
        code('InvalidTransition')
      );
    } finally {
      await client.close();
    }
  });
});
