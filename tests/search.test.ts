import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { EMBEDDED_PRINCIPAL, type Principal } from '../src/access/index.ts';
import type { MemoryKitError, MemoryRecord, SearchQuery } from '../src/model/index.ts';
import { DATABASE_FILE, initStore, openStore } from '../src/sdk/index.ts';
import { MemoryService } from '../src/service/index.ts';
import { SqliteStorage } from '../src/storage-sqlite/index.ts';
import { tempDir } from './helpers.ts';

type Client = Awaited<ReturnType<typeof openStore>>;

const NO_HISTORY = { provider: 'none' } as const;

async function newStore(): Promise<{ store: string; client: Client }> {
  const store = tempDir();
  await initStore({ path: store, history: NO_HISTORY });
  return { store, client: await openStore({ path: store, history: NO_HISTORY }) };
}

function code(expected: string): (error: unknown) => boolean {
  return (error) => (error as MemoryKitError).code === expected;
}

// 30 memories in demo; every third one mentions the lighthouse.
async function seed(client: Client): Promise<MemoryRecord[]> {
  const records: MemoryRecord[] = [];
  for (let i = 0; i < 30; i++) {
    const content = i % 3 === 0 ? `the lighthouse log ${i}` : `harbour note ${i}`;
    records.push((await client.create({ namespace: 'demo', kind: 'note', content })).memory);
  }
  return records;
}

// Every page of a search, following its cursors.
async function pages(
  client: { search(query: SearchQuery): ReturnType<Client['search']> },
  query: SearchQuery
) {
  const result = [];
  let cursor: string | null = null;
  do {
    const page = await client.search(cursor === null ? query : { ...query, cursor });
    result.push(page);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return result;
}

const ids = (items: MemoryRecord[]): string[] => items.map((item) => item.id);

describe('search', () => {
  it('S6.1 text search pages through every match in a stable order', async () => {
    const { client } = await newStore();
    try {
      const records = await seed(client);
      const matching = records.filter((record) => record.content.includes('lighthouse'));
      const first = await pages(client, { text: 'lighthouse', limit: 4 });
      assert.deepEqual(
        first.map((page) => page.items.length),
        [4, 4, 2]
      );
      assert.ok(first.every((page) => page.completeness === 'complete'));
      const found = first.flatMap((page) => ids(page.items));
      assert.equal(new Set(found).size, 10);
      assert.deepEqual([...found].sort(), ids(matching).sort());
      const again = await pages(client, { text: 'lighthouse', limit: 4 });
      assert.deepEqual(
        again.flatMap((page) => ids(page.items)),
        found
      );
    } finally {
      await client.close();
    }
  });

  it('S6.2 tombstoned and superseded memories appear only when their state is asked for', async () => {
    const { client } = await newStore();
    try {
      const gone = (await client.create({ namespace: 'demo', kind: 'note', content: 'beacon a' }))
        .memory;
      const old = (await client.create({ namespace: 'demo', kind: 'note', content: 'beacon b' }))
        .memory;
      await client.tombstone({ id: gone.id, expectedRevision: 1 });
      await client.supersede({
        id: old.id,
        expectedRevision: 1,
        replacement: { kind: 'note', content: 'replacement' },
      });
      assert.deepEqual((await client.search({ text: 'beacon' })).items, []);
      assert.deepEqual(
        ids((await client.search({ text: 'beacon', states: ['tombstoned'] })).items),
        [gone.id]
      );
      const superseded = (await client.search({ text: 'beacon', states: ['superseded'] })).items;
      assert.deepEqual(ids(superseded), [old.id]);
      assert.equal(superseded[0]!.supersededBy.length, 1);
    } finally {
      await client.close();
    }
  });

  it('S6.3 metadata and kinds narrow the results, and an update is searchable at once', async () => {
    const { client } = await newStore();
    try {
      const high = (
        await client.create({
          namespace: 'demo',
          kind: 'lesson',
          content: 'tide tables',
          metadata: { priority: 'high', owner: 'ops' },
        })
      ).memory;
      const low = (
        await client.create({
          namespace: 'demo',
          kind: 'lesson',
          content: 'tide charts',
          metadata: { priority: 'low' },
        })
      ).memory;
      const note = (
        await client.create({
          namespace: 'demo',
          kind: 'note',
          content: 'tide notes',
          metadata: { priority: 'high' },
        })
      ).memory;
      assert.equal((await client.search({ text: 'tide' })).items.length, 3);
      assert.deepEqual(
        ids((await client.search({ text: 'tide', metadata: { priority: 'high' } })).items).sort(),
        [high.id, note.id].sort()
      );
      assert.deepEqual(
        ids((await client.search({ text: 'tide', kinds: ['lesson'] })).items).sort(),
        [high.id, low.id].sort()
      );
      assert.deepEqual(
        ids(
          (await client.search({ text: 'tide', kinds: ['lesson'], metadata: { priority: 'high' } }))
            .items
        ),
        [high.id]
      );
      assert.deepEqual((await client.search({ metadata: { priority: 1 } })).items, []);

      await client.update({ id: low.id, expectedRevision: 1, content: 'storm warnings' });
      assert.deepEqual(ids((await client.search({ text: 'storm' })).items), [low.id]);
      assert.equal((await client.search({ text: 'tide' })).items.length, 2);
    } finally {
      await client.close();
    }
  });

  it('S6.4 a search that reaches the scan budget is partial and resumes from its cursor', async () => {
    const { store, client } = await newStore();
    for (let i = 0; i < 30; i++) {
      await client.create({ namespace: 'demo', kind: 'note', content: `lighthouse ${i}` });
    }
    await client.close();
    const service = new MemoryService(
      new SqliteStorage({ path: join(store, DATABASE_FILE), scanBudget: 5 }),
      null,
      {}
    );
    await service.open();
    try {
      const reader = service.as(EMBEDDED_PRINCIPAL);
      const first = await reader.search({ text: 'lighthouse' });
      assert.equal(first.completeness, 'partial');
      assert.equal(first.partialReason, 'scan_budget');
      assert.equal(first.items.length, 5);
      assert.notEqual(first.nextCursor, null);
      const all = await pages(reader, { text: 'lighthouse' });
      const found = all.flatMap((page) => ids(page.items));
      assert.equal(new Set(found).size, 30);
      assert.equal(all.at(-1)!.completeness, 'complete');
    } finally {
      await service.close();
    }
  });

  it('S6.5 a limit over the maximum page size is LimitExceeded', async () => {
    const { client } = await newStore();
    try {
      await assert.rejects(client.search({ limit: 101 }), code('LimitExceeded'));
      await assert.rejects(client.search({ limit: 0 }), code('ValidationFailed'));
      assert.deepEqual((await client.search({ limit: 100 })).items, []);
    } finally {
      await client.close();
    }
  });

  it('S6.6 without text, results are newest first and then by id', async () => {
    const { client } = await newStore();
    try {
      const records = await seed(client);
      const expected = [...records].sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
      );
      const found = (await pages(client, { limit: 7 })).flatMap((page) => ids(page.items));
      assert.deepEqual(found, ids(expected));

      const oldest = expected.at(-1)!;
      await client.update({ id: oldest.id, expectedRevision: 1, content: 'revised' });
      assert.equal((await client.search({ limit: 1 })).items[0]!.id, oldest.id);
    } finally {
      await client.close();
    }
  });

  it('rejects a cursor from another query, a malformed cursor and text with no words', async () => {
    const { client } = await newStore();
    try {
      await seed(client);
      const page = await client.search({ text: 'lighthouse', limit: 2 });
      await assert.rejects(
        client.search({ text: 'harbour', limit: 2, cursor: page.nextCursor! }),
        code('ValidationFailed')
      );
      await assert.rejects(
        client.search({ limit: 2, cursor: page.nextCursor! }),
        code('ValidationFailed')
      );
      await assert.rejects(client.search({ cursor: 'not-a-cursor' }), code('ValidationFailed'));
      await assert.rejects(client.search({ text: '!!! ??' }), code('ValidationFailed'));
      await assert.rejects(client.search({ namespaces: [] }), code('ValidationFailed'));
      await assert.rejects(client.search({ states: ['gone' as never] }), code('ValidationFailed'));
    } finally {
      await client.close();
    }
  });

  it('a search covers only namespaces the principal may read', async () => {
    const { store, client } = await newStore();
    const reader: Principal = {
      id: 'reader',
      profile: 'local',
      grants: [{ pattern: 'team/*', permissions: ['read'] }],
    };
    const scoped = await openStore({ path: store, history: NO_HISTORY }, reader);
    try {
      const mine = (await client.create({ namespace: 'team/a', kind: 'note', content: 'shared' }))
        .memory;
      await client.create({ namespace: 'other', kind: 'note', content: 'shared' });
      assert.deepEqual(ids((await scoped.search({ text: 'shared' })).items), [mine.id]);
      assert.deepEqual(
        ids((await scoped.search({ text: 'shared', namespaces: ['team/a'] })).items),
        [mine.id]
      );
      assert.equal((await scoped.search({ namespaces: ['team/*'] })).items.length, 1);
      await assert.rejects(scoped.search({ namespaces: ['other'] }), code('Forbidden'));
      await assert.rejects(scoped.search({ namespaces: ['*'] }), code('Forbidden'));
      assert.deepEqual((await scoped.search({ namespaces: ['team'] })).items, []);
      await assert.rejects(scoped.search({ namespaces: ['team/a', 'other'] }), code('Forbidden'));
    } finally {
      await scoped.close();
      await client.close();
    }
  });
});
