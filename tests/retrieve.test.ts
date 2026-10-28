import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { EMBEDDED_PRINCIPAL } from '../src/access/index.ts';
import {
  DEFAULT_LIMITS,
  MAX_RETRIEVE_BYTES,
  retrievedItem,
  validateRetrieve,
  type MemoryKitError,
  type RetrieveQuery,
  type RetrieveResult,
  type RetrieveSource,
} from '../src/model/index.ts';
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

function reason(field: string, expected: string): (error: unknown) => boolean {
  return (error) => {
    const { code, details } = error as MemoryKitError;
    return code === 'ValidationFailed' && details.field === field && details.reason === expected;
  };
}

// Every page of a retrieve, following its cursors.
async function pages(
  client: { retrieve(query: RetrieveQuery): Promise<RetrieveResult> },
  query: RetrieveQuery
): Promise<RetrieveResult[]> {
  const result = [];
  let cursor: string | null = null;
  do {
    const page: RetrieveResult = await client.retrieve(
      cursor === null ? query : { ...query, cursor }
    );
    result.push(page);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return result;
}

function source(content: string, overrides: Partial<RetrieveSource> = {}): RetrieveSource {
  return {
    id: '01JAAAAAAAAAAAAAAAAAAAAAAA',
    revision: 1,
    namespace: 'demo',
    key: null,
    kind: 'note',
    state: 'active',
    updatedAt: '2026-10-28T00:00:00.000Z',
    content,
    metadata: {},
    provenance: { evidence: [] },
    ...overrides,
  };
}

describe('retrieve validation', () => {
  it('S15.1 applies the defaults and the fixed bounds', () => {
    const query = validateRetrieve({ text: 'lighthouse' }, DEFAULT_LIMITS);
    assert.equal(query.limit, 10);
    assert.equal(query.excerptChars, 280);
    assert.deepEqual(query.states, ['active']);
    assert.equal(validateRetrieve({ text: 'x', limit: 50 }, DEFAULT_LIMITS).limit, 50);
    const small = { ...DEFAULT_LIMITS, maxPageSize: 5 };
    assert.equal(validateRetrieve({ text: 'x' }, small).limit, 5);

    assert.throws(() => validateRetrieve({}, DEFAULT_LIMITS), reason('text', 'required'));
    assert.throws(
      () => validateRetrieve({ text: 'x', limit: 51 }, DEFAULT_LIMITS),
      reason('limit', 'too_large')
    );
    assert.throws(
      () => validateRetrieve({ text: 'x', limit: 6 }, small),
      reason('limit', 'too_large')
    );
    assert.throws(
      () => validateRetrieve({ text: 'x', excerptChars: 1001 }, DEFAULT_LIMITS),
      reason('excerptChars', 'too_large')
    );
    for (const excerptChars of [0, 1.5, '10']) {
      assert.throws(
        () => validateRetrieve({ text: 'x', excerptChars }, DEFAULT_LIMITS),
        reason('excerptChars', 'not_a_limit')
      );
    }
    assert.throws(
      () => validateRetrieve({ text: 'x', snippet: true }, DEFAULT_LIMITS),
      (error) => (error as MemoryKitError).code === 'ValidationFailed'
    );
  });
});

describe('retrieved item', () => {
  it('S15.2 cuts the excerpt at code points around the first matched term', () => {
    const content = `${'🌊'.repeat(100)} the lighthouse ${'🌊'.repeat(100)}`;
    const item = retrievedItem(
      source(content),
      [],
      -1.5,
      ['lighthouse'],
      content.indexOf('lighthouse'),
      60
    );
    assert.equal(Array.from(item.excerpt.text).length, 60);
    assert.ok(item.excerpt.text.includes('lighthouse'));
    assert.ok(!item.excerpt.text.includes('�'));
    assert.equal(item.excerpt.truncated, true);
    assert.equal(item.contentBytes, Buffer.byteLength(content));
    assert.equal(item.match.score, 1.5);
    assert.deepEqual(item.match.terms, ['lighthouse']);

    // Near the end the window keeps its full width; without a content match it starts at 0.
    const tail = retrievedItem(source(`${'a '.repeat(50)}beacon`), [], -1, ['beacon'], 100, 10);
    assert.equal(tail.excerpt.text, 'a a beacon');
    const head = retrievedItem(source('plain words here'), [], -1, ['beacon'], -1, 5);
    assert.equal(head.excerpt.text, 'plain');
    assert.deepEqual(head.match.terms, ['beacon']);

    const whole = retrievedItem(source('Café crème'), [], 0, ['cafe'], 0, 280);
    assert.deepEqual(whole.excerpt, { text: 'Café crème', truncated: false });
    assert.ok(Object.is(whole.match.score, 0), 'a zero rank is not -0');
  });

  it('S15.2 the index locates the match, whatever the script or case', async () => {
    const { client } = await newStore();
    const pad = 'filler '.repeat(60);
    const create = (content: string, metadata = {}): Promise<unknown> =>
      client.create({ namespace: 'scripts', kind: 'note', content, metadata });
    await create(`${pad}ΣΑΣ greek`);
    await create(`${pad}สวัสดีครับ thai`);
    await create(`${pad}Crème brûlée`);
    await create('plain words here', { tag: 'beacon' });
    const excerpt = async (text: string): Promise<{ text: string; terms: string[] }> => {
      const { items } = await client.retrieve({ text, excerptChars: 40 });
      assert.equal(items.length, 1, text);
      return { text: items[0]!.excerpt.text, terms: items[0]!.match.terms };
    };
    assert.match((await excerpt('σασ')).text, /ΣΑΣ greek$/u);
    assert.match((await excerpt('สวัสดี')).text, /สวัสดีครับ thai$/u);
    assert.match((await excerpt('CREME brulee')).text, /Crème brûlée$/u);
    assert.deepEqual(await excerpt('beacon beacon'), {
      text: 'plain words here',
      terms: ['beacon'],
    });
    await client.close();
  });

  it('S15.2 lists at most 5 short refs and 8 replacements, counting the rest', () => {
    const refs = ['a', 'x'.repeat(257), 'b', 'c', 'd', 'e', 'f'];
    const replacements = Array.from({ length: 10 }, (_, i) => `01JAAAAAAAAAAAAAAAAAAAAAA${i}`);
    const item = retrievedItem(
      source('text', {
        provenance: { reason: 'hidden', evidence: refs.map((ref) => ({ ref, note: 'hidden' })) },
      }),
      replacements,
      -1,
      ['text'],
      0,
      280
    );
    assert.deepEqual(item.evidence, { refs: ['a', 'b', 'c', 'd', 'e'], omitted: 2 });
    assert.deepEqual(item.supersededBy, { ids: replacements.slice(0, 8), omitted: 2 });
    assert.doesNotMatch(JSON.stringify(item), /hidden/u);
  });
});

describe('retrieve', () => {
  it('S15.4 a page stops before the item that would cross the byte bound and resumes there', async () => {
    const { client } = await newStore();
    try {
      const evidence = ['1', '2', '3', '4', '5'].map((n) => ({ ref: n.repeat(256) }));
      for (let i = 0; i < 50; i++) {
        await client.create({
          namespace: 'demo',
          kind: 'note',
          content: `lighthouse ${i} ${'w'.repeat(5000)}`,
          provenance: { evidence },
        });
      }
      const query = { text: 'lighthouse', limit: 50, excerptChars: 1000 };
      const all = await pages(client, query);
      assert.ok(all.length > 1, 'the bound splits the results');
      for (const page of all) {
        assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MAX_RETRIEVE_BYTES);
        assert.equal(page.completeness, 'complete');
      }
      assert.ok(all[0]!.items.length < 50);
      const found = all.flatMap((page) => page.items.map((item) => item.id));
      const searched = (await client.search({ text: 'lighthouse', limit: 50 })).items;
      assert.deepEqual(
        found,
        searched.map((record) => record.id)
      );
    } finally {
      await client.close();
    }
  });

  it('S15.1 a retrieve that reaches the scan budget is partial and resumes from its cursor', async () => {
    const { store, client } = await newStore();
    for (let i = 0; i < 12; i++) {
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
      const first = await reader.retrieve({ text: 'lighthouse', limit: 50 });
      assert.equal(first.completeness, 'partial');
      assert.equal(first.partialReason, 'scan_budget');
      assert.ok(first.nextCursor !== null);
      const all = await pages(reader, { text: 'lighthouse', limit: 50 });
      assert.equal(new Set(all.flatMap((page) => page.items.map((item) => item.id))).size, 12);
    } finally {
      await service.close();
    }
  });
});

describe('S17 stemmed index', () => {
  const count = (db: DatabaseSync, sql: string, ...params: string[]) =>
    (db.prepare(sql).get(...params) as { n: number }).n;

  it('S17.5 a purge leaves no row in either full-text table', async () => {
    const { store, client } = await newStore();
    const gone = await client.create({ namespace: 'demo', kind: 'note', content: 'lighthouse' });
    const kept = await client.create({ namespace: 'demo', kind: 'note', content: 'lighthouse' });
    await client.purge({ id: gone.memory.id, expectedRevision: 1 });
    await client.close();
    const db = new DatabaseSync(join(store, DATABASE_FILE));
    try {
      for (const table of ['memories_fts', 'memories_stem']) {
        const rows = `SELECT count(*) AS n FROM ${table} WHERE id = ?`;
        assert.equal(count(db, rows, gone.memory.id), 0, table);
        assert.equal(count(db, rows, kept.memory.id), 1, table);
      }
    } finally {
      db.close();
    }
  });

  it('S17.5 the migration fills the stemmed index with every indexed memory', async () => {
    const { store, client } = await newStore();
    for (let i = 0; i < 7; i++) {
      await client.create({ namespace: 'demo', kind: 'note', content: `lighthouse ${i}` });
    }
    await client.close();
    const path = join(store, DATABASE_FILE);
    const db = new DatabaseSync(path);
    db.exec('DROP TABLE memories_stem; PRAGMA user_version = 3');
    db.close();

    const reopened = await openStore({ path: store, history: NO_HISTORY });
    try {
      assert.equal((await reopened.retrieve({ text: 'lighthouses', limit: 50 })).items.length, 7);
    } finally {
      await reopened.close();
    }
    const check = new DatabaseSync(path);
    try {
      const indexed = count(check, 'SELECT count(*) AS n FROM memories_fts');
      assert.equal(indexed, 7);
      assert.equal(count(check, 'SELECT count(*) AS n FROM memories_stem'), indexed);
      assert.equal(
        count(
          check,
          'SELECT count(*) AS n FROM memories_fts f JOIN memories_stem s ON s.rowid = f.rowid AND s.id = f.id'
        ),
        indexed
      );
    } finally {
      check.close();
    }
  });

  it('S17.2 later pages keep the cut of the first page', async () => {
    const { client } = await newStore();
    try {
      for (let i = 0; i < 4; i++) {
        await client.create({ namespace: 'demo', kind: 'note', content: `lighthouse beacon ${i}` });
        await client.create({
          namespace: 'demo',
          kind: 'note',
          content: `lighthouse ${'filler '.repeat(300)}${i}`,
        });
      }
      const query = { text: 'lighthouse beacon' };
      const whole = (await client.retrieve({ ...query, limit: 50 })).items.map((item) => item.id);
      assert.equal(whole.length, 4, 'the cut drops the weak matches');
      const paged = (await pages(client, { ...query, limit: 1 })).flatMap((page) =>
        page.items.map((item) => item.id)
      );
      assert.deepEqual(paged, whole);
    } finally {
      await client.close();
    }
  });
});
