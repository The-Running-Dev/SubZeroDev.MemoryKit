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
];
