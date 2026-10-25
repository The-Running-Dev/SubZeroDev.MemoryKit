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
      assert.equal(outcome.history, 'not_required');
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
        history: 'not_required',
        historyRef: null,
      });
      problem(await driver.operation(store, 'op-unknown'), 'NotFound');
      problem(await driver.history(store, memory.id as string), 'HistoryNotRetained');

      const status = value(await driver.status(store));
      assert.equal(status.contractVersion, 1);
      assert.equal((status.storage as Record<string, unknown>).id, 'storage-sqlite');
      assert.equal(status.history, null);
      assert.deepEqual(status.historyQueue, { pending: 0, blocked: null });

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
];
