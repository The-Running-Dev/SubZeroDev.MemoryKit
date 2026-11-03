import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { Pool } from 'pg';
import { PostgresStorage, createStorage } from '../src/storage-postgres/index.ts';
import { initStore, openStore } from '../src/sdk/index.ts';
import { reviewMemory } from '../src/workflow/review.ts';
import { tempDir } from './helpers.ts';
import {
  StoreBusyError,
  StoreUnavailableError,
  ValidationFailedError,
} from '../src/model/index.ts';

const url = process.env.MEMORYKIT_TEST_POSTGRES_URL;
it('PostgreSQL indexes candidates transactionally and falls back after an older writer', { skip: !url }, async () => {
  const storeId = randomUUID(), pool = new Pool({ connectionString: url });
  const config = { path: tempDir(), history: { provider: 'none' as const }, storage: {
    provider: 'plugin' as const,
    module: fileURLToPath(new URL('../src/storage-postgres/index.ts', import.meta.url)),
    options: { connectionStringEnv: 'MEMORYKIT_TEST_POSTGRES_URL', storeId },
  } };
  await initStore(config);
  let client = await openStore(config);
  try {
    const a = (await client.create({ namespace: 'project/a', kind: 'note', content: 'Bicycles are in the attic.', metadata: { status: 'accepted', tag: 'WHEELS' } })).memory;
    await client.create({ namespace: 'project/ab', kind: 'note', content: 'Bicycles PRIVATE_FOREIGN', metadata: { status: 'accepted' } });
    const find = () => client.retrieve({ namespaces: ['project/a/*'], text: 'bicycle', limit: 1 });
    assert.deepEqual((await find()).items.map((r) => r.id), [a.id]);
    assert.equal((await client.search({ namespaces: ['project/a'], text: 'wheels' })).items.length, 1);
    const b = await reviewMemory(client, { namespace: 'project/a', action: 'correct', id: a.id, expectedRevision: 1, content: 'Bicycles are in the garage.' });
    assert.deepEqual((await find()).items.map((r) => r.id), [b.memory.id]);
    assert.equal((await client.retrieve({ namespaces: ['project/a'], text: 'attic', states: ['superseded'] })).items[0]!.supersededBy.ids[0], b.memory.id);
    // Simulate the old snapshot-only plugin, which drops the derived-index version marker.
    await pool.query(`UPDATE memorykit_stores SET payload=jsonb_set(payload-'searchVersion', '{rows}',
      (SELECT jsonb_agg(CASE WHEN r->>'id'=$2 THEN jsonb_set(r,'{content}','"Bicycles are in the cellar."') ELSE r END)
       FROM jsonb_array_elements(payload->'rows') r)) WHERE store_id=$1`, [storeId, b.memory.id]);
    assert.ok((await client.retrieve({ namespaces: ['project/a'], text: 'cellar' })).items.some((r) => r.id === b.memory.id));
    assert.equal((await client.retrieve({ namespaces: ['project/a'], text: 'garage' })).items.length, 0);
    await client.close();
    client = await openStore(config);
    const mirrored = await pool.query('SELECT record FROM memorykit_search_rows_v1 WHERE store_id=$1 AND id=$2', [storeId, b.memory.id]);
    assert.match(mirrored.rows[0].record.content, /cellar/);
    const explain = await pool.connect();
    try {
      await explain.query('BEGIN');
      await explain.query('SET LOCAL enable_seqscan=off');
      const plan = await explain.query("EXPLAIN SELECT id FROM memorykit_search_rows_v1 WHERE terms @> ARRAY['p:bicycle']::text[]");
      assert.match(JSON.stringify(plan.rows), /memorykit_search_terms_v1/);
    } finally { await explain.query('ROLLBACK'); explain.release(); }
    await client.purge({ id: b.memory.id, expectedRevision: 1 });
    assert.equal((await pool.query('SELECT 1 FROM memorykit_search_rows_v1 WHERE store_id=$1 AND id=$2', [storeId, b.memory.id])).rowCount, 0);
    assert.equal((await find()).items.length, 0);
  } finally {
    await client.close();
    await pool.query('DELETE FROM memorykit_stores WHERE store_id=$1', [storeId]);
    await pool.end();
  }
});
it('PostgreSQL validates options without exposing connection credentials', async () => {
  await assert.rejects(
    createStorage({
      path: 'unused',
      initialize: false,
      options: { storeId: 'demo', connectionString: 'secret' },
    }),
    ValidationFailedError
  );
  await assert.rejects(
    createStorage({
      path: 'unused',
      initialize: false,
      options: { storeId: 'demo', connectionStringEnv: 'MEMORYKIT_TEST_MISSING' },
    }),
    (e) => e instanceof StoreUnavailableError && !e.message.includes('secret')
  );
});

it(
  'PostgreSQL serializes independent clients, rolls back and persists tokens across reopen',
  { skip: !url },
  async () => {
    const storeId = randomUUID();
    const a = new PostgresStorage({ connectionString: url!, storeId, initialize: true });
    await a.open();
    const b = new PostgresStorage({ connectionString: url!, storeId, timeoutMs: 200 });
    await b.open();
    const pool = new Pool({ connectionString: url });
    try {
      await assert.rejects(
        a.write(async (tx) => {
          await tx.namespacePolicy('rollback', 'full');
          throw new Error('abort');
        }),
        /unavailable/
      );
      assert.equal((await a.snapshot()).namespaces.length, 0);
      const lock = await pool.connect();
      try {
        await lock.query('BEGIN');
        await lock.query('SELECT payload FROM memorykit_stores WHERE store_id=$1 FOR UPDATE', [
          storeId,
        ]);
        await assert.rejects(b.issue('blocked', []), StoreBusyError);
      } finally {
        await lock.query('ROLLBACK');
        lock.release();
      }
      const issued = await Promise.all([a.issue('a', []), b.issue('b', [])]);
      await a.close();
      await a.open();
      assert.equal((await a.list()).length, 2);
      assert.equal((await b.verify(issued[0]!.secret))?.id, 'a');
      await b.revoke(issued[0]!.tokenId);
      assert.equal(await a.verify(issued[0]!.secret), null);
      const isolated = new PostgresStorage({
        connectionString: url!,
        storeId: randomUUID(),
        initialize: true,
      });
      await isolated.open();
      assert.equal(await isolated.verify(issued[1]!.secret), null);
      await isolated.close();
    } finally {
      await a.close();
      await b.close();
      await pool.end();
    }
  }
);
