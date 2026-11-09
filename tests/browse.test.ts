import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { browse, type BrowseInput } from '../src/index.ts';
import { EMBEDDED_PRINCIPAL, type Principal } from '../src/access/index.ts';
import { handle } from '../src/http/index.ts';
import { ForbiddenError, NotFoundError, ValidationFailedError } from '../src/model/index.ts';
import { initStore, openStore, type StoreConfig } from '../src/sdk/index.ts';
import type { MemoryClient } from '../src/service/index.ts';
import { context } from '../src/workflow/index.ts';
import { runCli, tempDir } from './helpers.ts';

const ns = 'project/browse';
async function fixture(provider: 'sqlite' | 'markdown') {
  const config: StoreConfig = {
    path: tempDir(),
    storage: { provider },
    history: { provider: 'none' },
  };
  await initStore(config);
  const client = await openStore(config);
  after(() => client.close());
  return { client, config };
}
async function seed(
  client: MemoryClient,
  content: string,
  metadata: Record<string, string> = {},
  namespace = ns
) {
  return (
    await client.create({
      namespace,
      kind: 'note',
      content,
      metadata: { status: 'accepted', sourceRole: 'user', ...metadata },
      provenance: { evidence: [{ ref: 'private:evidence' }] },
    })
  ).memory;
}
const checkBytes = (result: Awaited<ReturnType<typeof browse>>, max = 8192) => {
  assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(result)));
  assert.ok(result.bytes <= max);
  assert.equal(result.count, result.items.length);
};

for (const provider of ['sqlite', 'markdown'] as const)
  describe(`${provider}: bounded browse`, () => {
    it('projects attributed eligible summaries only, with explicit candidate and preview opt-ins', async () => {
      const { client } = await fixture(provider);
      const user = await seed(client, 'USER_SOURCE', { secret: 'PRIVATE_METADATA' });
      const assistant = await seed(client, 'ASSISTANT_RECAP', { sourceRole: 'assistant' });
      const candidate = await seed(client, 'CANDIDATE', { status: 'candidate' });
      await seed(client, 'REJECTED', { status: 'rejected' });
      await seed(client, 'UNREVIEWED', { status: 'unreviewed' });
      await seed(client, 'FOREIGN', {}, ns + '/child');
      const archived = await seed(client, 'ARCHIVED');
      await client.archive({ id: archived.id, expectedRevision: archived.revision });
      const old = await seed(client, 'SUPERSEDED');
      const replacement = await client.supersede({
        id: old.id,
        expectedRevision: old.revision,
        replacement: { kind: 'note', content: 'CURRENT', metadata: { status: 'accepted' } },
      });
      const result = await browse(client, { namespace: ns });
      checkBytes(result);
      assert.deepEqual(
        new Set(result.items.map((r) => r.id)),
        new Set([user.id, assistant.id, replacement.memory.id])
      );
      assert.equal(result.items.find((r) => r.id === assistant.id)!.sourceRole, 'assistant');
      assert.equal(result.items.find((r) => r.id === user.id)!.sourceRole, 'user');
      for (const marker of [
        'PRIVATE_METADATA',
        'private:evidence',
        'USER_SOURCE',
        'ASSISTANT_RECAP',
      ])
        assert.ok(!JSON.stringify(result).includes(marker));
      assert.equal(result.completeness, 'complete');
      const review = await browse(client, {
        namespace: ns,
        includeCandidates: true,
        previewChars: 4,
      });
      assert.ok(review.items.some((r) => r.id === candidate.id && r.status === 'candidate'));
      assert.deepEqual(review.items.find((r) => r.id === user.id)!.preview, {
        text: 'USER',
        truncated: true,
      });
      assert.equal((await client.get(candidate.id)).metadata.status, 'candidate');
    });

    it('paginates without duplicates and binds cursors to normalized filters, scopes and caller', async () => {
      const { client, config } = await fixture(provider);
      for (let i = 0; i < 5; i++) await seed(client, 'Alpha ' + i);
      const input: BrowseInput = { namespace: ns, text: 'ALPHA', kinds: ['note'], limit: 2 };
      const first = await browse(client, input);
      assert.equal(first.count, 2);
      assert.deepEqual(first.reasons, ['item_limit']);
      assert.ok(first.nextCursor);
      const second = await browse(client, { ...input, text: 'alpha', cursor: first.nextCursor! });
      const third = await browse(client, { ...input, cursor: second.nextCursor! });
      assert.equal(
        new Set([...first.items, ...second.items, ...third.items].map((r) => r.id)).size,
        5
      );
      assert.equal(third.nextCursor, null);
      for (const change of [
        { namespace: 'project/other' },
        { text: 'different' },
        { includeCandidates: true },
        { kinds: ['other'] },
        { previewChars: 1 },
      ])
        await assert.rejects(
          browse(client, { ...input, ...change, cursor: first.nextCursor! }),
          ValidationFailedError
        );
      const other: Principal = { ...EMBEDDED_PRINCIPAL, id: 'other-reader' };
      const reader = await openStore(config, other);
      try {
        await assert.rejects(
          browse(reader, { ...input, cursor: first.nextCursor! }),
          ValidationFailedError
        );
      } finally {
        await reader.close();
      }
      // Built-in identities survive reopening, so CLI pagination works across processes.
      const reopened = await openStore(config);
      try {
        assert.deepEqual(
          (await browse(reopened, { ...input, cursor: first.nextCursor! })).items,
          second.items
        );
      } finally {
        await reopened.close();
      }
    });

    it('bounds the full UTF-8 envelope and retains an item that does not fit', async () => {
      const { client } = await fixture(provider);
      const record = await seed(client, '💾é'.repeat(200));
      const small = await browse(client, { namespace: ns, maxBytes: 512, previewChars: 256 });
      checkBytes(small, 512);
      assert.equal(small.count, 0);
      assert.deepEqual(small.reasons, ['byte_limit']);
      assert.ok(small.nextCursor);
      const bigger = await browse(client, {
        namespace: ns,
        maxBytes: 4096,
        previewChars: 256,
        cursor: small.nextCursor!,
      });
      checkBytes(bigger, 4096);
      assert.equal(bigger.items[0]!.id, record.id);
      assert.equal(Array.from(bigger.items[0]!.preview!.text).length, 256);
      assert.equal(bigger.items[0]!.contentBytes, Buffer.byteLength(record.content));
      assert.equal(bigger.nextCursor, null);
    });

    it('does not let hidden namespaces influence items, cursors or partial reasons', async () => {
      const { client, config } = await fixture(provider);
      for (let i = 0; i < 3; i++) await seed(client, 'alpha visible ' + i);
      const principal: Principal = {
        id: 'reader',
        profile: 'local',
        grants: [{ pattern: ns, permissions: ['read'] }],
      };
      const reader = await openStore(config, principal);
      try {
        const input = { namespace: ns, text: 'alpha', limit: 1 };
        const before = await browse(reader, input);
        for (let i = 0; i < 210; i++) await seed(client, 'alpha HIDDEN ' + i, {}, 'project/hidden');
        assert.deepEqual(await browse(reader, input), before);
        await assert.rejects(browse(reader, { namespace: 'project/hidden' }), ForbiddenError);
        await assert.rejects(
          browse(reader, { namespace: ns, sharedNamespaces: ['project/hidden'] }),
          ForbiddenError
        );
      } finally {
        await reader.close();
      }
    });

    it('stops at 200 scoped search calls and resumes after filtered records', async () => {
      const { client } = await fixture(provider);
      for (let i = 0; i < 203; i++) await seed(client, 'candidate ' + i, { status: 'candidate' });
      const first = await browse(client, { namespace: ns });
      assert.equal(first.count, 0);
      assert.deepEqual(first.reasons, ['scan_budget']);
      assert.ok(first.nextCursor);
      const end = await browse(client, { namespace: ns, cursor: first.nextCursor! });
      assert.equal(end.count, 0);
      assert.equal(end.completeness, 'complete');
      assert.equal(end.nextCursor, null);
    });

    it('supports explicit shared scopes and literal filters without model calls', async () => {
      const { client } = await fixture(provider);
      await seed(client, 'café Evidence');
      const shared = await seed(client, 'café Evidence', {}, 'shared/team');
      const result = await browse(client, {
        namespace: ns,
        sharedNamespaces: ['shared/team'],
        text: 'CAFÉ',
        kinds: ['note'],
      });
      assert.equal(result.count, 2);
      assert.ok(result.items.some((r) => r.id === shared.id));
      assert.equal((await browse(client, { namespace: ns, text: 'missing' })).count, 0);
    });
  });

it('rechecks revision, state and authorization; selected stale content cannot enter context', async () => {
  const { client } = await fixture('sqlite');
  const record = await seed(client, 'OLD_SOURCE');
  for (const mode of ['changed', 'missing', 'revoked'] as const) {
    const proxy = new Proxy(client, {
      get(target, key) {
        if (key === 'get')
          return async () => {
            if (mode === 'missing') throw new NotFoundError('gone');
            if (mode === 'revoked') return { ...record, metadata: { status: 'rejected' } };
            return { ...record, revision: 2 };
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await browse(proxy, { namespace: ns });
    assert.equal(result.count, 0);
    assert.deepEqual(result.reasons, ['records_changed']);
  }
  const chosen = await browse(client, { namespace: ns });
  assert.equal(chosen.items[0]!.revision, 1);
  await client.update({ id: record.id, expectedRevision: 1, metadata: { status: 'rejected' } });
  assert.equal((await context(client, { namespace: ns })).items.length, 0);
});

it('distinguishes provider partial pages, empty results and errors', async () => {
  const { client } = await fixture('sqlite');
  const proxy = (search: MemoryClient['search']) =>
    new Proxy(client, {
      get(target, key) {
        if (key === 'search') return search;
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const partial = await browse(
    proxy(async () => ({
      items: [],
      nextCursor: 'next',
      completeness: 'partial',
      partialReason: 'time_budget',
    })),
    { namespace: ns }
  );
  assert.deepEqual(partial.reasons, ['provider_time_budget']);
  assert.ok(partial.nextCursor);
  const error = new Error('provider unavailable');
  await assert.rejects(
    browse(
      proxy(async () => {
        throw error;
      }),
      { namespace: ns }
    ),
    (e) => e === error
  );
  assert.equal((await browse(client, { namespace: ns })).completeness, 'complete');
});

it('rejects invalid inputs and malformed continuation before reading a provider', async () => {
  const { client } = await fixture('sqlite');
  for (const input of [
    { namespace: '*' },
    { limit: 0 },
    { maxBytes: 511 },
    { previewChars: 257 },
    { includeCandidates: ['true'] },
    { cursor: 'bad' },
    { cursor: 'x'.repeat(8193) },
    { kinds: [] },
    { text: 42 },
    { unknown: 'field' },
  ])
    await assert.rejects(
      browse(client, { namespace: ns, ...input } as BrowseInput),
      ValidationFailedError
    );
});

it('SDK, HTTP and real CLI return equivalent bounded results and CLI cursors resume', async () => {
  const { client, config } = await fixture('sqlite');
  for (let i = 0; i < 3; i++) await seed(client, 'source ' + i);
  const input = { namespace: ns, limit: 1 };
  const expected = await browse(client, input);
  const response = await handle(client, {
    method: 'POST',
    path: '/v1/browse',
    headers: new Headers(),
    body: JSON.stringify(input),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), expected);
  assert.equal(Buffer.byteLength(response.body), expected.bytes);
  const args = [
    'browse',
    '--store',
    config.path,
    '--history',
    'none',
    '--namespace',
    ns,
    '--limit',
    '1',
  ];
  const first = runCli(args);
  assert.equal(first.status, 0, first.stderr);
  const page = JSON.parse(first.stdout);
  assert.deepEqual(page, expected);
  assert.ok(page.nextCursor);
  const next = runCli([...args, '--cursor', page.nextCursor]);
  assert.equal(next.status, 0, next.stderr);
  assert.notEqual(JSON.parse(next.stdout).items[0].id, page.items[0]!.id);
});
