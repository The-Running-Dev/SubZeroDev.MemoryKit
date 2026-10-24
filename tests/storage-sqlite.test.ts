import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { StoreUnavailableError, StoreVersionTooNewError, newMemoryId } from '../src/model/index.ts';
import { SqliteStorage, isNetworkPath, requireFeatures } from '../src/storage-sqlite/index.ts';
import type { StoredRow } from '../src/contracts/index.ts';
import { tempDir } from './helpers.ts';

function row(namespace: string): StoredRow {
  const now = new Date().toISOString();
  return {
    record: {
      id: newMemoryId(),
      namespace,
      key: null,
      kind: 'note',
      content: 'hello',
      contentType: 'text/plain',
      metadata: {},
      links: [],
      state: 'active',
      priorState: null,
      revision: 1,
      provenance: { evidence: [] },
      actor: 'test',
      createdAt: now,
      updatedAt: now,
    },
  };
}

async function insert(storage: SqliteStorage, stored: StoredRow): Promise<void> {
  await storage.write((tx) =>
    tx.commit(
      {
        rows: [stored],
        outbox: [],
        operation: {
          principalId: 'test',
          operationId: newMemoryId(),
          fingerprint: 'f',
          memoryId: stored.record.id,
          revision: 1,
        },
      },
      [{ id: stored.record.id, revision: null }]
    )
  );
}

describe('SqliteStorage', () => {
  it('S1.1 creates schema 1 in WAL mode with FTS5', async () => {
    const path = join(tempDir(), 'memory.db');
    const storage = new SqliteStorage({ path });
    await storage.open();
    await storage.close();

    const db = new DatabaseSync(path);
    try {
      assert.equal(
        (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
        'wal'
      );
      assert.equal(
        (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        1
      );
      const names = (
        db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all() as {
          name: string;
        }[]
      ).map((item) => item.name);
      for (const table of [
        'memories',
        'links',
        'memories_fts',
        'namespaces',
        'operations',
        'outbox',
        'drain_lease',
        'purges',
        'tokens',
      ]) {
        assert.ok(names.includes(table), table);
      }
    } finally {
      db.close();
    }
  });

  it('S1.1 refuses a build without FTS5', () => {
    assert.throws(
      () => requireFeatures({ journalMode: 'wal', fts5: false }),
      (error: unknown) =>
        error instanceof StoreUnavailableError && error.details.reason === 'fts5_missing'
    );
    assert.throws(
      () => requireFeatures({ journalMode: 'delete', fts5: true }),
      (error: unknown) =>
        error instanceof StoreUnavailableError && error.details.reason === 'wal_unavailable'
    );
  });

  it('S1.6 refuses a schema newer than the code', async () => {
    const path = join(tempDir(), 'memory.db');
    const storage = new SqliteStorage({ path });
    await storage.open();
    await storage.close();
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 2');
    db.close();

    await assert.rejects(
      new SqliteStorage({ path }).open(),
      (error: unknown) =>
        error instanceof StoreVersionTooNewError &&
        error.details.found === 2 &&
        error.details.supported === 1
    );
  });

  it('refuses network paths, foreign databases and files that are not databases', async () => {
    assert.ok(isNetworkPath('\\\\server\\share\\memory.db'));
    assert.ok(isNetworkPath('//server/share/memory.db'));
    await assert.rejects(
      new SqliteStorage({ path: '\\\\server\\share\\memory.db' }).open(),
      (error: unknown) =>
        error instanceof StoreUnavailableError && error.details.reason === 'network_path'
    );

    const foreign = join(tempDir(), 'memory.db');
    const db = new DatabaseSync(foreign);
    db.exec('CREATE TABLE other (x)');
    db.close();
    await assert.rejects(
      new SqliteStorage({ path: foreign }).open(),
      (error: unknown) =>
        error instanceof StoreUnavailableError && error.details.reason === 'foreign_database'
    );
    const untouched = new DatabaseSync(foreign);
    const mode = untouched.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    untouched.close();
    assert.equal(mode.journal_mode, 'delete', 'a refused database is not switched to WAL');

    const junk = join(tempDir(), 'memory.db');
    writeFileSync(
      junk,
      'this is not a database, just some text that is long enough to have a header'
    );
    await assert.rejects(
      new SqliteStorage({ path: junk }).open(),
      (error: unknown) =>
        error instanceof StoreUnavailableError && error.details.reason === 'not_a_store'
    );
  });

  it('applies the row scope inside the query', async () => {
    const storage = new SqliteStorage({ path: join(tempDir(), 'memory.db') });
    await storage.open();
    try {
      const inside = row('team/a_b/notes');
      const lookalike = row('team/axb');
      const sibling = row('team/a_bc');
      const base = row('team/a_b');
      for (const stored of [inside, lookalike, sibling, base]) await insert(storage, stored);

      assert.ok(await storage.get(inside.record.id, { patterns: ['team/a_b/*'] }));
      assert.ok(await storage.get(inside.record.id, { patterns: ['*'] }));
      assert.equal(await storage.get(inside.record.id, { patterns: ['team/a_b'] }), null);
      assert.equal(await storage.get(inside.record.id, { patterns: [] }), null);
      assert.equal(await storage.get(lookalike.record.id, { patterns: ['team/a_b/*'] }), null);
      assert.equal(await storage.get(sibling.record.id, { patterns: ['team/a_b/*'] }), null);
      assert.ok(await storage.get(sibling.record.id, { patterns: ['team/a_b/*', 'team/a_bc'] }));
      assert.ok(await storage.get(base.record.id, { patterns: ['team/a_b/*'] }));
    } finally {
      await storage.close();
    }
  });

  it('rolls back every part of a failed write', async () => {
    const path = join(tempDir(), 'memory.db');
    const storage = new SqliteStorage({ path });
    await storage.open();
    const stored = row('demo');
    await assert.rejects(
      storage.write(async (tx) => {
        await tx.namespacePolicy('demo', 'full');
        await tx.commit(
          {
            rows: [stored],
            outbox: [],
            operation: {
              principalId: 'test',
              operationId: 'op',
              fingerprint: 'f',
              memoryId: stored.record.id,
              revision: 1,
            },
          },
          [{ id: stored.record.id, revision: null }]
        );
        throw new Error('boom');
      }),
      /boom/
    );
    await storage.close();

    const db = new DatabaseSync(path);
    try {
      for (const table of ['memories', 'memories_fts', 'namespaces', 'operations']) {
        assert.equal(
          (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
          0,
          table
        );
      }
    } finally {
      db.close();
    }
  });
});
