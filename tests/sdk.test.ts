import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import {
  ForbiddenError,
  NotFoundError,
  StoreBusyError,
  StoreUnavailableError,
  StoreVersionTooNewError,
  ValidationFailedError,
  LimitExceededError,
  IdempotencyMismatchError,
  DEFAULT_LIMITS,
  isMemoryId,
  newMemoryId,
  toProblem,
} from '../src/model/index.ts';
import { EMBEDDED_PRINCIPAL } from '../src/access/index.ts';
import { initStore, openStore } from '../src/sdk/index.ts';
import { MemoryService } from '../src/service/index.ts';
import { SqliteStorage } from '../src/storage-sqlite/index.ts';
import { SCHEMA_VERSION } from '../src/storage-sqlite/schema.ts';
import { REPO_ROOT, runNode, runNodeAsync, tempDir } from './helpers.ts';

const WRITE = join(REPO_ROOT, 'tests', 'fixtures', 'write.ts');

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
    assert.equal(outcome.history, 'persisted', 'Git history is the default');
    assert.match(outcome.historyRef ?? '', /^[0-9a-f]{40}$/);
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

  it('S1.6 openStore refuses a schema newer than the code', async () => {
    const path = tempDir();
    await initStore({ path });
    const db = new DatabaseSync(join(path, 'memory.db'));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    await assert.rejects(openStore({ path }), StoreVersionTooNewError);
  });

  it('a create outside the grants is Forbidden and writes nothing', async () => {
    const path = tempDir();
    await initStore({ path });
    const client = await openStore({ path }, { id: 'nobody', profile: 'local', grants: [] });
    try {
      await assert.rejects(
        client.create({ namespace: 'demo', kind: 'note', content: 'x' }),
        ForbiddenError
      );
    } finally {
      await client.close();
    }
    for (const table of ['memories', 'namespaces', 'operations']) {
      assert.equal(count(path, table), 0, table);
    }
  });

  it('rejects ill-formed Unicode anywhere in the input', async () => {
    const path = tempDir();
    await initStore({ path });
    const client = await openStore({ path });
    const lone = String.fromCharCode(0xd800);
    try {
      for (const input of [
        { namespace: 'demo', kind: 'note', content: `bad ${lone}` },
        { namespace: 'demo', kind: 'note', content: 'x', key: lone },
        { namespace: 'demo', kind: 'note', content: 'x', metadata: { tag: [lone] } },
        { namespace: 'demo', kind: 'note', content: 'x', metadata: { [lone]: 1 } },
      ]) {
        await assert.rejects(
          client.create(input),
          (error: unknown) =>
            error instanceof ValidationFailedError && error.details.reason === 'ill_formed_unicode'
        );
      }
    } finally {
      await client.close();
    }
    assert.equal(count(path, 'memories'), 0);
  });

  it('S2.1 two processes updating revision 1: one wins, one conflicts', async () => {
    const path = tempDir();
    await initStore({ path });
    const client = await openStore({ path });
    const id = (await client.create({ namespace: 'demo', kind: 'note', content: 'v1' })).memory.id;
    await client.close();

    const results = await Promise.all(
      ['a', 'b'].map(async (name) => {
        const input = JSON.stringify({ id, expectedRevision: 1, content: name });
        const child = await runNodeAsync(WRITE, [path, 'update', input]);
        assert.equal(child.status, 0, child.stderr);
        return { name, result: JSON.parse(child.stdout) };
      })
    );
    const won = results.filter((item) => item.result.ok);
    const lost = results.filter((item) => !item.result.ok);
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    assert.equal(won[0]!.result.value.memory.revision, 2);
    assert.equal(lost[0]!.result.problem.code, 'RevisionConflict');
    assert.equal(lost[0]!.result.problem.details.currentRevision, 2);

    const reader = await openStore({ path });
    try {
      const current = await reader.get(id);
      assert.equal(current.revision, 2);
      assert.equal(current.content, won[0]!.name);
    } finally {
      await reader.close();
    }
  });

  it('S2.2 and S2.3 an update replays by operation id and refuses another body', async () => {
    const path = tempDir();
    await initStore({ path });
    const client = await openStore({ path });
    try {
      const id = (await client.create({ namespace: 'demo', kind: 'note', content: 'v1' })).memory
        .id;
      const input = { id, expectedRevision: 1, content: 'v2', metadata: { a: 1 } };
      const first = await client.update(input, { operationId: 'op-u' });
      assert.equal(first.memory.revision, 2);
      assert.deepEqual(first.memory.metadata, { a: 1 });
      const again = await client.update(input, { operationId: 'op-u' });
      assert.deepEqual(again, first);
      await assert.rejects(
        client.update({ ...input, content: 'v3' }, { operationId: 'op-u' }),
        IdempotencyMismatchError
      );
      // A later write does not change what the earlier operation replays.
      await client.update({ id, expectedRevision: 2, content: 'v3' });
      assert.deepEqual(await client.update(input, { operationId: 'op-u' }), first);
      assert.equal((await client.get(id)).revision, 3);
    } finally {
      await client.close();
    }
  });

  it('S2.4 concurrent creates of one key: one wins, the other is AlreadyExists', async () => {
    const path = tempDir();
    await initStore({ path });
    const input = JSON.stringify({ namespace: 'demo', key: 'k1', kind: 'note', content: 'x' });
    const results = await Promise.all(
      [0, 1].map(async () => {
        const child = await runNodeAsync(WRITE, [path, 'create', input]);
        assert.equal(child.status, 0, child.stderr);
        return JSON.parse(child.stdout);
      })
    );
    const won = results.filter((result) => result.ok);
    const lost = results.filter((result) => !result.ok);
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    assert.equal(lost[0].problem.code, 'AlreadyExists');
    assert.equal(lost[0].problem.details.id, won[0].value.memory.id);
    assert.equal(count(path, 'memories'), 1);
  });

  it('S2.5 a lock held past the busy timeout is StoreBusy and persists nothing', async () => {
    const path = tempDir();
    await initStore({ path });
    const service = new MemoryService(
      new SqliteStorage({ path: join(path, 'memory.db'), busyTimeoutMs: 100 }),
      null
    );
    await service.open();
    const holder = new DatabaseSync(join(path, 'memory.db'));
    holder.exec('BEGIN IMMEDIATE');
    try {
      await assert.rejects(
        service
          .as(EMBEDDED_PRINCIPAL)
          .create({ namespace: 'demo', kind: 'note', content: 'x' }, { operationId: 'op-busy' }),
        (error: unknown) =>
          error instanceof StoreBusyError &&
          error.retryable &&
          error.details.timeoutMs === 100 &&
          toProblem(error).retryable === true
      );
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    // The retry with the same operation id goes through once the lock is gone.
    const retried = await service
      .as(EMBEDDED_PRINCIPAL)
      .create({ namespace: 'demo', kind: 'note', content: 'x' }, { operationId: 'op-busy' });
    await service.close();
    assert.equal(retried.memory.revision, 1);
    assert.equal(count(path, 'memories'), 1);
    assert.equal(count(path, 'operations'), 1);
  });

  it('update keeps omitted fields, refuses changes it cannot make and checks the type', async () => {
    const path = tempDir();
    await initStore({ path });
    const client = await openStore({ path });
    try {
      const created = await client.create({
        namespace: 'demo',
        key: 'k',
        kind: 'note',
        content: '{"a":1}',
        contentType: 'application/json',
        metadata: { keep: true },
      });
      const { id } = created.memory;
      const updated = await client.update({ id, expectedRevision: 1, kind: 'lesson' });
      assert.equal(updated.memory.kind, 'lesson');
      assert.equal(updated.memory.content, '{"a":1}');
      assert.deepEqual(updated.memory.metadata, { keep: true });
      assert.equal(updated.memory.key, 'k');
      assert.equal(updated.memory.createdAt, created.memory.createdAt);
      await assert.rejects(
        client.update({ id, expectedRevision: 2, content: 'not json' }),
        ValidationFailedError
      );
      await assert.rejects(
        client.update({ id, expectedRevision: 2, namespace: 'other' } as never),
        ValidationFailedError
      );
      await assert.rejects(
        client.update({ id, expectedRevision: 1.5, content: '{}' }),
        ValidationFailedError
      );
    } finally {
      await client.close();
    }
  });

  it('an update outside the grants is NotFound and writes nothing', async () => {
    const path = tempDir();
    await initStore({ path });
    const owner = await openStore({ path });
    const id = (await owner.create({ namespace: 'demo', kind: 'note', content: 'x' })).memory.id;
    await owner.close();
    const outsider = await openStore(
      { path },
      { id: 'reader', profile: 'local', grants: [{ pattern: 'demo', permissions: ['read'] }] }
    );
    try {
      await assert.rejects(
        outsider.update({ id, expectedRevision: 1, content: 'y' }),
        NotFoundError
      );
    } finally {
      await outsider.close();
    }
    assert.equal(count(path, 'operations'), 1);
  });

  it('a replay after the write grant is removed is NotFound', async () => {
    const path = tempDir();
    await initStore({ path });
    const writer = { id: 'agent', profile: 'local' as const };
    const before = await openStore(
      { path },
      { ...writer, grants: [{ pattern: 'demo', permissions: ['read', 'write'] }] }
    );
    const input = { namespace: 'demo', kind: 'note', content: 'x' };
    const created = await before.create(input, { operationId: 'op-c' });
    const id = created.memory.id;
    await before.update({ id, expectedRevision: 1, content: 'y' }, { operationId: 'op-u' });
    await before.close();
    const after = await openStore(
      { path },
      { ...writer, grants: [{ pattern: 'demo', permissions: ['read'] }] }
    );
    try {
      await assert.rejects(
        after.update({ id, expectedRevision: 1, content: 'y' }, { operationId: 'op-u' }),
        NotFoundError
      );
      await assert.rejects(after.create(input, { operationId: 'op-c' }));
    } finally {
      await after.close();
    }
  });

  it('migrates a schema 1 store and replays its operations from the current row', async () => {
    const path = tempDir();
    await initStore({ path });
    const client = await openStore({ path });
    const input = { namespace: 'demo', kind: 'note', content: 'x' };
    const first = await client.create(input, { operationId: 'op-old' });
    await client.close();

    const db = new DatabaseSync(join(path, 'memory.db'));
    db.exec(
      'DROP INDEX memories_updated; ALTER TABLE operations DROP COLUMN outcome; ' +
        'PRAGMA user_version = 1'
    );
    db.close();

    const reopened = await openStore({ path });
    try {
      assert.deepEqual(await reopened.create(input, { operationId: 'op-old' }), first);
    } finally {
      await reopened.close();
    }
    const check = new DatabaseSync(join(path, 'memory.db'));
    try {
      const version = check.prepare('PRAGMA user_version').get() as { user_version: number };
      assert.equal(version.user_version, SCHEMA_VERSION);
      const index = check
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'memories_updated'")
        .get();
      assert.ok(index !== undefined, 'schema 3 adds the ordering index');
    } finally {
      check.close();
    }
  });

  it('a __proto__ metadata key is part of the fingerprint', async () => {
    const path = tempDir();
    await initStore({ path });
    const client = await openStore({ path });
    try {
      const input = { namespace: 'demo', kind: 'note', content: 'x' };
      await client.create(
        { ...input, metadata: JSON.parse('{"__proto__": {"a": 1}}') },
        { operationId: 'op-proto' }
      );
      await assert.rejects(
        client.create(
          { ...input, metadata: JSON.parse('{"__proto__": {"a": 2}}') },
          { operationId: 'op-proto' }
        ),
        IdempotencyMismatchError
      );
    } finally {
      await client.close();
    }
  });
});
