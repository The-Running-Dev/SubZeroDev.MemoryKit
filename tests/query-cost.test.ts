import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { EMBEDDED_PRINCIPAL } from '../src/access/index.ts';
import { matchesPattern, type RetrieveQuery, type SearchQuery } from '../src/model/index.ts';
import { DATABASE_FILE, initStore, openStore } from '../src/sdk/index.ts';
import { MemoryService } from '../src/service/index.ts';
import { SqliteStorage, scopeSql } from '../src/storage-sqlite/index.ts';
import { tempDir } from './helpers.ts';

const NO_HISTORY = { provider: 'none' } as const;

// Names either side of "a" in byte order: "-" and "." sort before "/", "0" just after it.
const NAMES = ['a', 'a/b', 'a/b/c', 'a-b', 'a.b', 'ab', 'a0', 'b', 'a/0'];

describe('query cost', () => {
  it('S16.2 a prefix scope is a range that selects exactly the names under it', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE memories (namespace TEXT); CREATE INDEX ns ON memories(namespace)');
      const insert = db.prepare('INSERT INTO memories VALUES (?)');
      for (const name of NAMES) insert.run(name);
      for (const pattern of ['a/*', 'a/b/*', 'a-b/*', 'ab/*', 'a0/*', 'a', 'a/b'] as const) {
        const { sql, params } = scopeSql({ patterns: [pattern] });
        const found = db
          .prepare(`SELECT namespace FROM memories WHERE ${sql} ORDER BY namespace`)
          .all(...params)
          .map((row) => row.namespace);
        const expected = NAMES.filter((name) => matchesPattern(pattern, name)).sort();
        assert.deepEqual(found, expected, pattern);
        const plan = db
          .prepare(`EXPLAIN QUERY PLAN SELECT namespace FROM memories WHERE ${sql}`)
          .all(...params)
          .map((row) => String(row.detail))
          .join('\n');
        assert.match(plan, /USING COVERING INDEX ns/, `${pattern} uses the index`);
      }
    } finally {
      db.close();
    }
  });

  it('S16.4 candidates outside the scope count towards the budget, and paging finds every match', async () => {
    const store = tempDir();
    await initStore({ path: store, history: NO_HISTORY });
    const client = await openStore({ path: store, history: NO_HISTORY });
    const wanted = new Set<string>();
    for (let i = 0; i < 13; i++) {
      const namespace = i % 4 === 0 ? 'demo' : 'other';
      const { memory } = await client.create({
        namespace,
        kind: 'note',
        content: `lighthouse ${i}`,
      });
      if (namespace === 'demo') wanted.add(memory.id);
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
      const query: RetrieveQuery = { text: 'lighthouse', namespaces: ['demo'] };
      const found: string[] = [];
      const partial: boolean[] = [];
      let cursor: string | null = null;
      do {
        const page = await reader.search(cursor === null ? query : { ...query, cursor });
        found.push(...page.items.map((item) => item.id));
        partial.push(page.completeness === 'partial');
        if (page.completeness === 'partial') assert.equal(page.partialReason, 'scan_budget');
        cursor = page.nextCursor;
      } while (cursor !== null);
      // 13 candidates at 5 a page: two partial pages, then the last three.
      assert.deepEqual(partial, [true, true, false]);
      assert.deepEqual(new Set(found), wanted);
      assert.equal(found.length, wanted.size);

      const retrieved: string[] = [];
      cursor = null;
      do {
        const page = await reader.retrieve(cursor === null ? query : { ...query, cursor });
        retrieved.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor !== null);
      assert.deepEqual(retrieved, found);
    } finally {
      await service.close();
    }
  });

  it('S16.4 a metadata filter counts its rejected candidates towards the budget', async () => {
    const store = tempDir();
    await initStore({ path: store, history: NO_HISTORY });
    const client = await openStore({ path: store, history: NO_HISTORY });
    for (let i = 0; i < 8; i++) {
      await client.create({
        namespace: 'demo',
        kind: 'note',
        content: `lighthouse ${i}`,
        metadata: { keep: i === 7 },
      });
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
      const query: SearchQuery = { text: 'lighthouse', metadata: { keep: true } };
      const first = await reader.search(query);
      assert.equal(first.completeness, 'partial');
      assert.ok(first.items.length <= 1);
      const second = await reader.search({ ...query, cursor: first.nextCursor! });
      assert.equal(second.completeness, 'complete');
      assert.equal(first.items.length + second.items.length, 1);
    } finally {
      await service.close();
    }
  });
});
