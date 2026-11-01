import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { Pool } from 'pg';
import { PostgresStorage, createStorage } from '../src/storage-postgres/index.ts';
import {
  StoreBusyError,
  StoreUnavailableError,
  ValidationFailedError,
} from '../src/model/index.ts';

const url = process.env.MEMORYKIT_TEST_POSTGRES_URL;
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
