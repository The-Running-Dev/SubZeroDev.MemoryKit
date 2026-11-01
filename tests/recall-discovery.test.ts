import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import { initStore, openStore } from '../src/sdk/index.ts';
import { context } from '../src/workflow/index.ts';
import { CommandRecallSelector } from '../src/providers-command/index.ts';
import { ValidationFailedError } from '../src/model/index.ts';
import { tempDir } from './helpers.ts';

for (const provider of ['sqlite', 'markdown'] as const)
  it(`discovers an older paraphrase beyond the recency bound without broadening scope (${provider})`, async () => {
    const path = tempDir();
    const config = { path, storage: { provider }, history: { provider: 'none' as const } };
    await initStore(config);
    const client = await openStore(config);
    after(() => client.close());
    const create = (namespace: string, content: string) =>
      client.create({ namespace, kind: 'note', content, metadata: { status: 'accepted' } });
    const target = (await create('project/a', 'The bicycle is in the attic.')).memory;
    await create('project/private', 'The bicycle secret is HIDDEN_SCOPE_MARKER.');
    for (let i = 0; i < 250; i++)
      await create('project/a', `Routine unrelated daily housekeeping ${i}.`);
    const result = await context(
      client,
      {
        namespace: 'project/a',
        text: 'Review inventory, write tests, explain where my cycling equipment is kept.',
      },
      undefined,
      {
        id: 'test',
        async expand(query) {
          assert.match(query, /cycling/);
          return ['bicycles storage'];
        },
        async select(request) {
          assert.ok(request.passages.length <= 32);
          assert.ok(
            request.passages.every(
              (p) => p.namespace === 'project/a' && !p.content.includes('HIDDEN_SCOPE_MARKER')
            )
          );
          assert.ok(request.passages.some((p) => p.id === target.id));
          return [{ id: target.id, revision: target.revision, quote: target.content }];
        },
      }
    );
    assert.deepEqual(
      result.items.map((r) => r.id),
      [target.id]
    );
    assert.ok(result.reasons.includes('candidate_limit'));
  });

it('finds task facts deep in long records and emits the selected window', async () => {
  const path = tempDir();
  await initStore({ path, history: { provider: 'none' } });
  const client = await openStore({ path, history: { provider: 'none' } });
  after(() => client.close());
  const fact = 'The Zephyr rollout uses port 9473.';
  const target = (
    await client.create({
      namespace: 'project/a',
      kind: 'note',
      content: 'Padding without useful facts. '.repeat(400) + fact,
      metadata: { status: 'accepted' },
    })
  ).memory;
  const result = await context(
    client,
    { namespace: 'project/a', text: 'Which port does the Zephyr rollout use?' },
    undefined,
    {
      id: 'test',
      async select(request) {
        assert.ok(request.passages[0]!.content.includes(fact));
        return [{ id: target.id, revision: target.revision, quote: fact }];
      },
    }
  );
  assert.match(result.text, /9473/);
  assert.equal(result.items[0]!.truncated, true);
});

it('rejects unbounded generated queries before searching or selecting', async () => {
  const path = tempDir();
  await initStore({ path, history: { provider: 'none' } });
  const client = await openStore({ path, history: { provider: 'none' } });
  after(() => client.close());
  for (const generated of [Array(9).fill('term'), ['x'.repeat(257)], [''], [3]]) {
    await assert.rejects(
      context(client, { namespace: 'project/a', text: 'task' }, undefined, {
        id: 'bad',
        async expand() {
          return generated as string[];
        },
        async select() {
          assert.fail('Invalid expansion reached selection');
        },
      }),
      ValidationFailedError
    );
  }
  assert.equal(
    new CommandRecallSelector('default', { command: process.execPath }).expand,
    undefined
  );
});
