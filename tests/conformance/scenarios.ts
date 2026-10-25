import assert from 'node:assert/strict';
import { newMemoryId } from '../../src/model/index.ts';
import { tempDir } from '../helpers.ts';
import type { Driver, Result } from './driver.ts';

export interface Scenario {
  readonly name: string;
  run(driver: Driver): Promise<void>;
}

function value<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(`expected success, got ${JSON.stringify(result.problem)}`);
  return result.value;
}

function problem(result: Result<unknown>, code: string): void {
  assert.equal(result.ok, false, `expected ${code}`);
  if (!result.ok) assert.equal(result.problem.code, code);
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'create then get returns the same record',
    async run(driver) {
      const store = tempDir();
      value(await driver.init(store));
      const outcome = value(
        await driver.create(store, {
          namespace: 'demo/notes',
          key: 'first',
          kind: 'note',
          content: 'hello',
          metadata: { priority: 'high' },
        })
      );
      assert.equal(outcome.storage, 'persisted');
      assert.equal(outcome.history, 'persisted', 'Git history is the default');
      const memory = outcome.memory as Record<string, unknown>;
      assert.equal(memory.revision, 1);
      assert.equal(memory.state, 'active');
      assert.deepEqual(value(await driver.get(store, memory.id as string)), memory);
    },
  },
  {
    name: 'unknown ids and invalid input fail with the contract codes',
    async run(driver) {
      const store = tempDir();
      value(await driver.init(store));
      problem(await driver.get(store, newMemoryId()), 'NotFound');
      problem(
        await driver.create(store, { namespace: 'Demo', kind: 'note', content: 'x' }),
        'ValidationFailed'
      );
      problem(
        await driver.create(store, {
          namespace: 'demo',
          kind: 'note',
          content: '{bad',
          contentType: 'application/json',
        }),
        'ValidationFailed'
      );
    },
  },
  {
    name: 'S2.6 update conflicts, replays and refuses a reused operation id',
    async run(driver) {
      const store = tempDir();
      value(await driver.init(store));
      const created = value(
        await driver.create(store, { namespace: 'demo', kind: 'note', content: 'v1' })
      );
      const id = (created.memory as Record<string, unknown>).id as string;

      // S2.1: a write against revision 1 lands at 2; a second one against 1 conflicts.
      const won = value(
        await driver.update(store, { id, expectedRevision: 1, content: 'winner' }, 'op-a')
      );
      const memory = won.memory as Record<string, unknown>;
      assert.equal(memory.revision, 2);
      assert.equal(memory.content, 'winner');
      assert.equal(memory.kind, 'note');
      const lost = await driver.update(store, { id, expectedRevision: 1, content: 'loser' });
      problem(lost, 'RevisionConflict');
      if (!lost.ok) assert.equal(lost.problem.details.currentRevision, 2);

      // S2.2: the same operation id and body replays the stored outcome.
      const again = value(
        await driver.update(store, { id, expectedRevision: 1, content: 'winner' }, 'op-a')
      );
      assert.deepEqual(again, won);

      // S2.3: the same operation id with another body is refused.
      problem(
        await driver.update(store, { id, expectedRevision: 1, content: 'other' }, 'op-a'),
        'IdempotencyMismatch'
      );
      const current = value(await driver.get(store, id));
      assert.equal(current.revision, 2);
      assert.equal(current.content, 'winner');
    },
  },
  {
    name: 'S3 operation status, store status and namespace policies',
    async run(driver) {
      const store = tempDir();
      value(await driver.init(store));
      const created = value(
        await driver.create(store, { namespace: 'demo', kind: 'note', content: 'x' }, 'op-1')
      );
      const memory = created.memory as Record<string, unknown>;
      assert.deepEqual(value(await driver.operation(store, 'op-1')), {
        operationId: 'op-1',
        memoryId: memory.id,
        revision: 1,
        storage: 'persisted',
        history: 'persisted',
        historyRef: created.historyRef,
      });
      problem(await driver.operation(store, 'op-unknown'), 'NotFound');
      const revisions = value(await driver.history(store, memory.id as string)) as unknown[];
      assert.equal(revisions.length, 1);

      const status = value(await driver.status(store));
      assert.equal(status.contractVersion, 1);
      assert.equal((status.storage as Record<string, unknown>).id, 'storage-sqlite');
      assert.equal((status.history as Record<string, unknown>).id, 'history-git');
      assert.deepEqual(status.historyQueue, { pending: 0, blocked: null, lastError: null });

      assert.deepEqual(value(await driver.getNamespace(store, 'demo')), {
        name: 'demo',
        historyPolicy: 'full',
      });
      assert.deepEqual(value(await driver.setNamespacePolicy(store, 'demo', 'metadata')), {
        name: 'demo',
        historyPolicy: 'metadata',
      });
      assert.equal(value(await driver.getNamespace(store, 'demo')).historyPolicy, 'metadata');
      problem(await driver.setNamespacePolicy(store, 'demo', 'partial'), 'ValidationFailed');
      problem(await driver.getNamespace(store, 'Demo'), 'ValidationFailed');
    },
  },
  {
    name: 'update validates its input and maps an unknown id to NotFound',
    async run(driver) {
      const store = tempDir();
      value(await driver.init(store));
      problem(
        await driver.update(store, { id: newMemoryId(), expectedRevision: 1, content: 'x' }),
        'NotFound'
      );
      const created = value(
        await driver.create(store, { namespace: 'demo', kind: 'note', content: '{}' })
      );
      const id = (created.memory as Record<string, unknown>).id as string;
      problem(
        await driver.update(store, { id, expectedRevision: 0, content: 'x' }),
        'ValidationFailed'
      );
      problem(
        await driver.update(store, {
          id,
          expectedRevision: 1,
          contentType: 'application/json',
          content: '{bad',
        }),
        'ValidationFailed'
      );
    },
  },
  {
    name: 'S5 supersede, tombstone, restore and an invalid transition',
    async run(driver) {
      const store = tempDir();
      value(await driver.init(store));
      const created = value(
        await driver.create(store, { namespace: 'demo', kind: 'note', content: 'old' })
      );
      const a = (created.memory as Record<string, unknown>).id as string;

      const superseded = value(
        await driver.supersede(store, {
          id: a,
          expectedRevision: 1,
          replacement: { kind: 'note', content: 'new' },
        })
      );
      const b = superseded.memory as Record<string, unknown>;
      assert.equal(b.namespace, 'demo');
      assert.deepEqual(b.links, [{ type: 'supersedes', target: a }]);
      const related = superseded.related as Record<string, unknown>[];
      assert.deepEqual(
        related.map((m) => [m.id, m.state, m.revision, m.supersededBy]),
        [[a, 'superseded', 2, [b.id]]]
      );
      const target = value(await driver.get(store, a));
      assert.equal(target.state, 'superseded');
      assert.deepEqual(target.supersededBy, [b.id]);

      const tombstoned = value(
        await driver.transition(store, 'tombstone', { id: a, expectedRevision: 2 })
      ).memory as Record<string, unknown>;
      assert.deepEqual(
        [tombstoned.revision, tombstoned.state, tombstoned.priorState],
        [3, 'tombstoned', 'superseded']
      );
      problem(
        await driver.update(store, { id: a, expectedRevision: 2, content: 'stale' }),
        'RevisionConflict'
      );
      problem(
        await driver.transition(store, 'archive', { id: a, expectedRevision: 3 }),
        'InvalidTransition'
      );
      assert.equal(value(await driver.get(store, a)).revision, 3);

      const restored = value(
        await driver.transition(store, 'restore', { id: a, expectedRevision: 3 })
      ).memory as Record<string, unknown>;
      assert.deepEqual(
        [restored.revision, restored.state, restored.priorState],
        [4, 'superseded', null]
      );
    },
  },
  {
    name: 'S6 search pages, filters and rejects an oversized limit and a foreign cursor',
    async run(driver) {
      const store = tempDir();
      value(await driver.init(store));
      const ids: string[] = [];
      for (const [kind, content] of [
        ['note', 'the lighthouse keeper'],
        ['lesson', 'a lighthouse at dusk'],
        ['note', 'lighthouse beams'],
        ['note', 'harbour fog'],
      ]) {
        const created = value(await driver.create(store, { namespace: 'demo', kind, content }));
        ids.push((created.memory as Record<string, unknown>).id as string);
      }
      value(await driver.transition(store, 'tombstone', { id: ids[2], expectedRevision: 1 }));

      const idsOf = (page: Record<string, unknown>) =>
        (page.items as Record<string, unknown>[]).map((item) => item.id as string);
      const first = value(await driver.search(store, { text: 'lighthouse', limit: 1 }));
      assert.equal(first.completeness, 'complete');
      assert.equal(typeof first.nextCursor, 'string');
      const second = value(
        await driver.search(store, { text: 'lighthouse', limit: 1, cursor: first.nextCursor })
      );
      assert.equal(second.nextCursor, null);
      assert.deepEqual([...idsOf(first), ...idsOf(second)].sort(), [ids[0], ids[1]].sort());

      const lessons = value(await driver.search(store, { text: 'lighthouse', kinds: ['lesson'] }));
      assert.deepEqual(idsOf(lessons), [ids[1]]);
      const tombstoned = value(
        await driver.search(store, { namespaces: ['demo'], states: ['tombstoned'] })
      );
      assert.deepEqual(idsOf(tombstoned), [ids[2]]);

      problem(await driver.search(store, { limit: 101 }), 'LimitExceeded');
      problem(
        await driver.search(store, { text: 'fog', cursor: first.nextCursor }),
        'ValidationFailed'
      );
    },
  },
];
