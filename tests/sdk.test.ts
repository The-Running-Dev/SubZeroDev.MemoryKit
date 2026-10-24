import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import {
  NotFoundError,
  StoreUnavailableError,
  ValidationFailedError,
  LimitExceededError,
  IdempotencyMismatchError,
  DEFAULT_LIMITS,
  isMemoryId,
  newMemoryId,
} from '../src/model/index.ts';
import { initStore, openStore } from '../src/sdk/index.ts';
import { REPO_ROOT, runNode, tempDir } from './helpers.ts';

function count(store: string, table: string): number {
  const db = new DatabaseSync(join(store, 'memory.db'));
  try {
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('sdk', () => {
  it('S1.1 initStore creates a store once', async () => {
    const path = join(tempDir(), 'nested', 'store');
    await initStore({ path });
    await assert.rejects(
      initStore({ path }),
      (error: unknown) =>
        error instanceof StoreUnavailableError && error.details.reason === 'already_a_store'
    );
    await assert.rejects(
      openStore({ path: tempDir() }),
      (error: unknown) =>
        error instanceof StoreUnavailableError && error.details.reason === 'not_a_store'
    );
  });

  it('S1.2 a created memory comes back equal in a new process', async () => {
    const path = tempDir();
    await initStore({ path });
    const client = await openStore({ path });
    const outcome = await client.create({ namespace: 'demo', kind: 'note', content: 'hello' });
    await client.close();

    assert.equal(outcome.storage, 'persisted');
    assert.equal(outcome.history, 'not_required');
    assert.equal(outcome.historyRef, null);
    assert.deepEqual(outcome.related, []);
    assert.ok(isMemoryId(outcome.memory.id));
    assert.equal(outcome.memory.id.length, 26);
    assert.equal(outcome.memory.revision, 1);
    assert.equal(outcome.memory.state, 'active');
    assert.equal(outcome.memory.actor, 'embedded');
    assert.deepEqual(outcome.memory.supersededBy, []);

    const child = runNode(join(REPO_ROOT, 'tests', 'fixtures', 'get-record.ts'), [
      path,
      outcome.memory.id,
    ]);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), outcome.memory);
  });

  it('S1.4 get of an unknown id is NotFound', async () => {
    const path = tempDir();
    await initStore({ path });
    const client = await openStore({ path });
    try {
      await assert.rejects(client.get(newMemoryId()), NotFoundError);
      await assert.rejects(client.get('not-an-id'), ValidationFailedError);
    } finally {
      await client.close();
    }
  });

  it('S1.5 invalid or oversize input writes nothing', async () => {
    const path = tempDir();
    await initStore({ path });
    const client = await openStore({ path });
    try {
      await assert.rejects(
        client.create({ namespace: 'Demo', kind: 'note', content: 'hello' }),
        ValidationFailedError
      );
      await assert.rejects(
        client.create({
          namespace: 'demo',
          kind: 'note',
          content: '{bad',
          contentType: 'application/json',
        }),
        ValidationFailedError
      );
      await assert.rejects(
        client.create({
          namespace: 'demo',
          kind: 'note',
          content: 'x'.repeat(DEFAULT_LIMITS.maxContentBytes + 1),
        }),
        LimitExceededError
      );
    } finally {
      await client.close();
    }
    for (const table of ['memories', 'memories_fts', 'namespaces', 'operations', 'outbox']) {
      assert.equal(count(path, table), 0, table);
    }
  });

  it('replays a create with the same operation id and refuses a different one', async () => {
    const path = tempDir();
    await initStore({ path });
    const client = await openStore({ path });
    try {
      const input = { namespace: 'demo', kind: 'note', content: 'hello' };
      const first = await client.create(input, { operationId: 'op-1' });
      const again = await client.create(input, { operationId: 'op-1' });
      assert.deepEqual(again, first);
      await assert.rejects(
        client.create({ ...input, content: 'other' }, { operationId: 'op-1' }),
        IdempotencyMismatchError
      );
    } finally {
      await client.close();
    }
    assert.equal(count(path, 'memories'), 1);
  });

  it('stores keys, metadata, links and provenance as given', async () => {
    const path = tempDir();
    await initStore({ path });
    const client = await openStore({ path });
    try {
      const target = (await client.create({ namespace: 'demo', kind: 'note', content: 'a' })).memory
        .id;
      const created = await client.create({
        namespace: 'demo/sub',
        key: 'k1',
        kind: 'lesson',
        content: '{"ok":true}',
        contentType: 'application/json',
        metadata: { priority: 'high', tags: ['x', 'y'], score: 3 },
        links: [{ type: 'derived_from', target }],
        provenance: {
          origin: { kind: 'agent', name: 'tester' },
          reason: 'test',
          evidence: [{ ref: 'doc:1' }],
        },
      });
      assert.deepEqual(await client.get(created.memory.id), created.memory);
      assert.equal(created.memory.key, 'k1');
    } finally {
      await client.close();
    }
  });
});
