import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { EMBEDDED_PRINCIPAL, validatePrincipal, type Principal } from '../src/access/index.ts';
import type { RowScope, StoredRow } from '../src/contracts/index.ts';
import type { MemoryId, MemoryKitError, Permission } from '../src/model/index.ts';
import { DATABASE_FILE, initStore } from '../src/sdk/index.ts';
import { MemoryService } from '../src/service/index.ts';
import { SqliteStorage } from '../src/storage-sqlite/index.ts';
import { MemoryHistory } from '../src/history-memory/index.ts';
import { tempDir } from './helpers.ts';

// Records every by-id read: the scope it carried and whether a row came back.
class SpyStorage extends SqliteStorage {
  readonly reads: { id: MemoryId; scope: RowScope; found: boolean }[] = [];

  override async get(id: MemoryId, scope: RowScope): Promise<StoredRow | null> {
    const row = await super.get(id, scope);
    this.reads.push({ id, scope, found: row !== null });
    return row;
  }
}

function code(expected: string): (error: unknown) => boolean {
  return (error) => (error as MemoryKitError).code === expected;
}

function principal(id: string, pattern: string, permissions: Permission[]): Principal {
  return { id, profile: 'local', grants: [{ pattern, permissions }] };
}

async function newService(withHistory = false) {
  const store = tempDir();
  await initStore({ path: store, history: { provider: 'none' } });
  const storage = new SpyStorage({ path: join(store, DATABASE_FILE) });
  const service = new MemoryService(storage, withHistory ? new MemoryHistory() : null, {});
  await service.open();
  return { service, storage, owner: service.as(EMBEDDED_PRINCIPAL) };
}

const TEAM_A = principal('team-a', 'team/a/*', ['read', 'write']);

describe('permissions', () => {
  it('S7.1 a principal creates only inside its grants', async () => {
    const { service } = await newService();
    try {
      const client = service.as(TEAM_A);
      const created = await client.create({
        namespace: 'team/a/notes',
        kind: 'note',
        content: 'x',
      });
      assert.equal(created.memory.namespace, 'team/a/notes');
      await assert.rejects(
        client.create({ namespace: 'team/b', kind: 'note', content: 'x' }),
        code('Forbidden')
      );
    } finally {
      await service.close();
    }
  });

  it('S7.2 an id outside the grants is NotFound, and storage never returned its row', async () => {
    const { service, storage, owner } = await newService();
    try {
      const hidden = (await owner.create({ namespace: 'team/b', kind: 'note', content: 'secret' }))
        .memory;
      storage.reads.length = 0;
      await assert.rejects(service.as(TEAM_A).get(hidden.id), code('NotFound'));
      assert.deepEqual(storage.reads, [
        { id: hidden.id, scope: { patterns: ['team/a/*'] }, found: false },
      ]);
    } finally {
      await service.close();
    }
  });

  it('S7.3 search refuses an unreadable namespace and otherwise stays inside the grants', async () => {
    const { service, owner } = await newService();
    try {
      const mine = (await owner.create({ namespace: 'team/a/x', kind: 'note', content: 'x marks' }))
        .memory;
      await owner.create({ namespace: 'team/b', kind: 'note', content: 'x marks' });
      const client = service.as(TEAM_A);
      await assert.rejects(client.search({ namespaces: ['team/b'] }), code('Forbidden'));
      const found = await client.search({ text: 'x' });
      assert.deepEqual(
        found.items.map((item) => item.id),
        [mine.id]
      );
    } finally {
      await service.close();
    }
  });

  it('S7.4 write permits neither tombstone, history nor admin', async () => {
    const { service, owner } = await newService(true);
    try {
      const writer = service.as(principal('writer', 'team/a/*', ['read', 'write']));
      const memory = (await writer.create({ namespace: 'team/a/x', kind: 'note', content: 'x' }))
        .memory;
      await assert.rejects(
        writer.tombstone({ id: memory.id, expectedRevision: 1 }),
        code('Forbidden')
      );
      await assert.rejects(writer.history(memory.id), code('NotFound'));
      await assert.rejects(writer.revision(memory.id, 1), code('NotFound'));
      await assert.rejects(writer.setNamespacePolicy('team/a/x', 'none'), code('Forbidden'));
      await assert.rejects(writer.syncHistory(), code('Forbidden'));
      assert.equal((await owner.get(memory.id)).state, 'active');
    } finally {
      await service.close();
    }
  });

  it('S7.5 every revision records the principal as its actor, whatever the provenance says', async () => {
    const { service } = await newService(true);
    try {
      const client = service.as(principal('app1', 'demo', ['read', 'write', 'history']));
      const provenance = { origin: { kind: 'agent', name: 'someone-else' }, evidence: [] };
      const created = await client.create({
        namespace: 'demo',
        kind: 'note',
        content: 'v1',
        provenance,
      });
      await client.update({
        id: created.memory.id,
        expectedRevision: 1,
        content: 'v2',
        provenance,
      });
      await service.awaitHistory(5_000);
      const revisions = await client.history(created.memory.id);
      assert.deepEqual(
        revisions.map((item) => [item.revision, item.actor]),
        [
          [1, 'app1'],
          [2, 'app1'],
        ]
      );
      assert.equal((await client.get(created.memory.id)).provenance.origin?.name, 'someone-else');
    } finally {
      await service.close();
    }
  });

  it('supersededBy names only replacements the caller can read', async () => {
    const { service, owner } = await newService(true);
    try {
      const target = (await owner.create({ namespace: 'public', kind: 'note', content: 'old' }))
        .memory;
      const superseded = await owner.supersede(
        {
          id: target.id,
          expectedRevision: 1,
          replacement: { namespace: 'private', kind: 'note', content: 'new' },
        },
        { operationId: 'cross-namespace' }
      );
      const hidden = superseded.memory.id;
      const reader = service.as(principal('reader', 'public', ['read', 'history']));

      const read = await reader.get(target.id);
      assert.equal(read.state, 'superseded');
      assert.deepEqual(read.supersededBy, []);
      const found = await reader.search({ namespaces: ['public'], states: ['superseded'] });
      assert.deepEqual(
        found.items.map((item) => [item.id, item.supersededBy]),
        [[target.id, []]]
      );
      await assert.rejects(reader.get(hidden), code('NotFound'));
      // The exported revision keeps what was true when it was written; the reader's copy of it
      // is filtered like a current read.
      assert.deepEqual((await owner.revision(target.id, 2)).record.supersededBy, [hidden]);
      assert.deepEqual((await reader.revision(target.id, 2)).record.supersededBy, []);

      // A caller that can read both namespaces sees the relationship, on reads and a replay.
      const both = service.as({
        id: 'both',
        profile: 'local',
        grants: [
          { pattern: 'public', permissions: ['read'] },
          { pattern: 'private', permissions: ['read'] },
        ],
      });
      assert.deepEqual((await both.get(target.id)).supersededBy, [hidden]);
      const all = await both.search({ states: ['superseded'] });
      assert.deepEqual(
        all.items.map((item) => item.supersededBy),
        [[hidden]]
      );
      const replayed = await owner.supersede(
        {
          id: target.id,
          expectedRevision: 1,
          replacement: { namespace: 'private', kind: 'note', content: 'new' },
        },
        { operationId: 'cross-namespace' }
      );
      assert.equal(replayed.memory.id, hidden);
      assert.deepEqual(
        replayed.related.map((record) => record.supersededBy),
        [[hidden]]
      );
    } finally {
      await service.close();
    }
  });

  it('a malformed principal is refused before it can reach storage', async () => {
    const { service } = await newService();
    try {
      const bad: unknown[] = [
        { id: '', profile: 'local', grants: [] },
        { id: 'x', profile: 'guest', grants: [] },
        { id: 'x', profile: 'local', grants: [{ pattern: 'team/', permissions: ['read'] }] },
        { id: 'x', profile: 'local', grants: [{ pattern: 'team', permissions: ['own'] }] },
      ];
      for (const value of bad) {
        assert.throws(() => validatePrincipal(value), code('ValidationFailed'));
        assert.throws(() => service.as(value as Principal), code('ValidationFailed'));
      }
      validatePrincipal(EMBEDDED_PRINCIPAL);
    } finally {
      await service.close();
    }
  });
});
